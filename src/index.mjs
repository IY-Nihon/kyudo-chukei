/**
 * Gemini の中継。
 *
 * ■ なぜ
 *   アプリ（Expo Web）に Gemini の鍵を持たせると、配った束から鍵が抜ける。
 *   鍵はここ（Worker の secret）だけに置き、アプリは Firebase のログインの証
 *   （ID トークン）を付けて呼ぶ。証が本物で、この団体の企画のものなら通す。
 *
 * ■ 受けるもの（Gemini の REST とまったく同じ道と体）
 *   POST /v1beta/models/{model}:generateContent
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   GET  /v1beta/models
 *   POST /hozon・PUT /hozon/photo/{id}/{番} … アプリの改善のための保存（src/hozon.mjs）
 *   体はそのまま Gemini へ流す（読み解かない。写真が入っていて大きいので、
 *   Worker の CPU をほとんど使わずに済む）。
 *
 * ■ 確かめること
 *   1. 出どころ（Origin）が ALLOWED_ORIGINS にある（ブラウザから呼ぶ前提）
 *   2. Authorization: Bearer <Firebase ID トークン> が本物（Google の公開鍵で署名を検める。
 *      有効期限内、aud が FIREBASE_PROJECT_IDS のどれか、iss がその企画）
 *   3. 模型が ALLOWED_MODELS にある
 *   4. 人（sub）ごとの回数が上限内
 *
 * ■ 鍵
 *   GEMINI_API_KEY（1つ）と GEMINI_API_KEYS（, 区切りで何個でも）を合わせて使う。
 *   呼ぶたびに次の鍵から始め（回し持ち）、その鍵が 429（上限）や 403（止められた）
 *   なら次の鍵で同じ体をもう一度送る。全部だめなら最後の返事をそのまま返す。
 *
 * ■ 混んでいるとき
 *   503（模型が混んでいる。"This model is currently experiencing high demand"）は
 *   鍵のせいではないが、山は短い。2・4・8 秒待って 3 回まで送り直す（鍵も次のものに
 *   替える。企画ごとに枠が違うことがある）。それでもだめなら 503 をそのまま返し、アプリが
 *   もう少し待ってもう一度呼ぶ。1.5・3 秒の 2 回では足りず、配信した日にまた 503 が
 *   使う人まで届いた（2026-09-20。小さな文の依頼は同じ時刻に 200 だったので、写真の重い
 *   依頼のほうが落とされやすい）
 */

import { 保存を受ける, 古い保存を消す } from './hozon.mjs';

const 公開鍵の場所 = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const 上流 = 'https://generativelanguage.googleapis.com';

/** 公開鍵の控え（Worker の生きている間だけ） */
let 鍵の控え = { 鍵たち: null, 期限: 0 };
/** 次に使う Gemini の鍵の番号（Worker の生きている間だけ。回し持ちの起点） */
let 次の鍵 = 0;
/** 503（混んでいる）のとき、送り直す前に待つ長さ（ms）。並びの数だけ送り直す */
export const 混みの待ち = [2000, 4000, 8000];

export default {
  async fetch(request, env, ctx) {
    const 出どころ = request.headers.get('Origin') || '';
    const 許す出どころ = 出どころを選ぶ(出どころ, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      // 先触れ（preflight）。出どころが違えば CORS の頭を付けずに返す＝ブラウザが止める
      return new Response(null, { status: 204, headers: CORSの頭(許す出どころ) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      // 鍵の数は出さない。誰でも呼べる道なので、上限まで使い切るのに何回要るかが読めてしまう。
      // 置いた数は wrangler tail の「鍵 3/7」で確かめる
      return 答える({ ok: true, 何: 'kyudo-gemini-chukei' }, 200, 許す出どころ);
    }

    // 1. 出どころ
    if (出どころ && !許す出どころ) return 答える({ error: '出どころが許可されていません' }, 403, null);

    // 2. 証
    const 証 = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!証) return 答える({ error: 'ログインの証がありません' }, 401, 許す出どころ);
    let 本人;
    try {
      本人 = await 証を確かめる(証, env.FIREBASE_PROJECT_IDS.split(',').map((s) => s.trim()));
    } catch (e) {
      return 答える({ error: 'ログインの証が正しくありません', 訳: String((e && e.message) || e) }, 401, 許す出どころ);
    }

    // 改善のための保存（src/hozon.mjs）。回数の上限は Gemini の中継と同じものを使う
    if (url.pathname === '/hozon' || url.pathname.startsWith('/hozon/')) {
      if (!(await 回数に収まるか(env, 本人)))
        return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);
      const 結果 = await 保存を受ける(request, url, env, 本人);
      return 答える(結果.中身, 結果.状態, 許す出どころ);
    }

    // 3. 道と模型
    const 道 = 上流の道にする(url, env.ALLOWED_MODELS.split(',').map((s) => s.trim()));
    if (!道) return 答える({ error: 'この道は中継しません' }, 404, 許す出どころ);

    // 4. 回数
    if (!(await 回数に収まるか(env, 本人)))
      return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);

    // 上流へ。鍵はここで付ける。体は読み解かないが、鍵を替えて送り直せるよう一度手元に置く
    const 鍵たち = 鍵の一覧(env);
    if (!鍵たち.length) return 答える({ error: '中継に鍵が置かれていません' }, 500, 許す出どころ);
    const 上流のURL = 上流 + 道 + (url.search || '');
    const 種 = request.headers.get('Content-Type');
    const 依頼者 = request.headers.get('x-goog-api-client');
    let 体 = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    // 道具（function calling）の返事の role。@google/generative-ai 0.24 は functionResponse を
    // role:"function" で送るが、いまの Gemini API（3.6-flash）は 'function' を受けず
    // 「Role 'function' is not supported」の 400 を返す（2026-09-14、AI チャットで実際に）。
    // 正しくは role:"user"。アプリは 2026-09-14 から自分で role:"user" を積むので、いまは
    // 古い束（更新前の PWA）のためだけに残している。文字列の置換ではなく JSON として読み、
    // contents[].role だけを直す（文字列の中に同じ字があっても触らない）
    if (体 && 体.byteLength < 4 * 1024 * 1024 && /json/i.test(request.headers.get('Content-Type') || '')) {
      const 直した = 道具の返事のroleを直す(new TextDecoder().decode(体));
      if (直した !== null) 体 = new TextEncoder().encode(直した);
    }
    let 番 = 次の鍵++ % 鍵たち.length;
    let 返事 = null;
    let 使った = -1;
    let 鍵を替えた = 0;
    let 混んだ = 0;
    for (;;) {
      const 頭 = new Headers();
      頭.set('x-goog-api-key', 鍵たち[番]);
      if (種) 頭.set('Content-Type', 種);
      if (依頼者) 頭.set('x-goog-api-client', 依頼者);
      try {
        返事 = await fetch(上流のURL, { method: request.method, headers: 頭, body: 体 });
      } catch (e) {
        return 答える({ error: 'Gemini につながりませんでした', 訳: String((e && e.message) || e) }, 502, 許す出どころ);
      }
      使った = 番;
      const 訳 = await 送り直す訳(返事);
      if (訳 === '鍵' && 鍵を替えた < 鍵たち.length - 1) 鍵を替えた++;
      else if (訳 === '混み' && 混んだ < 混みの待ち.length) await new Promise((r) => setTimeout(r, 混みの待ち[混んだ++]));
      else break;
      // 使わない返事の体は捨てる（つなぎっぱなしにしない）
      if (返事.body) await 返事.body.cancel().catch(() => {});
      番 = (番 + 1) % 鍵たち.length;
    }
    // そのまま返す（流し読み（SSE）もこのままで通る）
    const 出す頭 = new Headers(返事.headers);
    for (const [k, v] of Object.entries(CORSの頭(許す出どころ))) 出す頭.set(k, v);
    出す頭.delete('content-security-policy');
    // どの鍵で答えたかは返事に載せない（載せると、鍵の数と回し方が外から読める）。
    // 運用者は wrangler tail で見る
    console.log(`鍵 ${使った + 1}/${鍵たち.length} ${返事.status}${混んだ ? ` 混み${混んだ}` : ''}`);
    return new Response(返事.body, { status: 返事.status, headers: 出す頭 });
  },

  // 毎日の定時の処理（wrangler.toml の [triggers]）。1 年を過ぎた改善のための保存を消す
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      古い保存を消す(env).then(
        (数) => console.log(`古い保存を ${数} 件消しました`),
        (e) => console.error('古い保存を消せませんでした', e)
      )
    );
  },
};

/**
 * 体（JSON）の contents[].role が "function" なら "user" に直した文を返す。
 * 直すところが無い・JSON として読めない・形が違うときは null（体はそのまま送る）。
 * @param {string} 文
 * @returns {string|null}
 */
export function 道具の返事のroleを直す(文) {
  if (!文.includes('"function"')) return null;
  let 体;
  try {
    体 = JSON.parse(文);
  } catch {
    return null;
  }
  if (!体 || !Array.isArray(体.contents)) return null;
  let 直した = false;
  for (const 発言 of 体.contents) {
    if (発言 && 発言.role === 'function') {
      発言.role = 'user';
      直した = true;
    }
  }
  return 直した ? JSON.stringify(体) : null;
}

/** 使える鍵の並び。GEMINI_API_KEY（1つ）と GEMINI_API_KEYS（, 区切り）を合わせ、重複は落とす */
function 鍵の一覧(env) {
  const 全部 = [env.GEMINI_API_KEY, ...String(env.GEMINI_API_KEYS || '').split(',')]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  return [...new Set(全部)];
}

/**
 * 送り直すべき返事なら、その訳を返す。送り直さないなら null。
 *   '鍵' … その鍵ではだめで、別の鍵なら通るかもしれない
 *           429 … この鍵の上限（分・日）
 *           403 … この鍵が止められている／権限が無い
 *           400 で「API key」と言われた … この鍵が無効
 *   '混み' … 503（模型が混んでいる）。少し待てば通ることが多い
 * 普通の 400（体がおかしい）や 404 は何度送っても同じなので送り直さない
 * @param {{status:number, clone:() => {text:() => Promise<string>}}} 返事
 * @returns {Promise<'鍵'|'混み'|null>}
 */
export async function 送り直す訳(返事) {
  if (返事.status === 429 || 返事.status === 403 || 返事.status === 401) return '鍵';
  if (返事.status === 503) return '混み';
  if (返事.status === 400) {
    // 体は読むと無くなるので、写しから読む
    const 文 = await 返事.clone().text().catch(() => '');
    return /API key|API_KEY_INVALID/i.test(文) ? '鍵' : null;
  }
  return null;
}

/** 人（証の sub）ごとの回数の上限に収まるか。上限の仕組みが無ければ通す（守りが1つ減るだけ） */
async function 回数に収まるか(env, 本人) {
  if (!env.RATE || !本人.sub) return true;
  try {
    const { success } = await env.RATE.limit({ key: 本人.sub });
    return !!success;
  } catch (e) {
    return true;
  }
}

/** 許された出どころなら、その文字列を返す（無ければ null） */
function 出どころを選ぶ(出どころ, 一覧) {
  if (!出どころ) return null;
  const 許す = (一覧 || '').split(',').map((s) => s.trim()).filter(Boolean);
  return 許す.includes(出どころ) ? 出どころ : null;
}

function CORSの頭(出どころ) {
  if (!出どころ) return {};
  return {
    'Access-Control-Allow-Origin': 出どころ,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-goog-api-key, x-goog-api-client',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function 答える(中身, 状態, 出どころ) {
  return new Response(JSON.stringify(中身), {
    status: 状態,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORSの頭(出どころ) },
  });
}

/**
 * 受けた道を、上流の道に直す。許した形だけ通す。
 *   /v1beta/models                              … 模型の一覧（GET）
 *   /v1beta/models/{model}:generateContent      … 生成（POST）
 *   /v1beta/models/{model}:streamGenerateContent… 流し読み（POST）
 * SDK は /v1beta/models/gemini-3.6-flash:generateContent の形で呼ぶ
 */
function 上流の道にする(url, 許す模型) {
  const 道 = url.pathname;
  if (道 === '/v1beta/models' || 道 === '/v1/models') return 道;
  const m = 道.match(/^\/(v1beta|v1)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
  if (!m) return null;
  const 模型 = m[2];
  if (!許す模型.includes(模型)) return null;
  return 道;
}

/** Firebase の ID トークンを確かめる。返すのは中身（sub, aud, ...） */
async function 証を確かめる(証, 企画たち) {
  const 部 = 証.split('.');
  if (部.length !== 3) throw new Error('形が違う');
  const 頭 = JSON.parse(base64urlを文字に(部[0]));
  const 中身 = JSON.parse(base64urlを文字に(部[1]));
  if (頭.alg !== 'RS256' || !頭.kid) throw new Error('署名の種類が違う');
  const 今 = Math.floor(Date.now() / 1000);
  if (typeof 中身.exp !== 'number' || 中身.exp <= 今) throw new Error('期限切れ');
  if (typeof 中身.iat === 'number' && 中身.iat > 今 + 300) throw new Error('発行日時が未来');
  if (!企画たち.includes(中身.aud)) throw new Error('企画が違う');
  if (中身.iss !== `https://securetoken.google.com/${中身.aud}`) throw new Error('発行元が違う');
  if (!中身.sub) throw new Error('人が無い');
  const 鍵 = await 公開鍵を取る(頭.kid);
  const 署名 = base64urlをバイトに(部[2]);
  const 本文 = new TextEncoder().encode(部[0] + '.' + 部[1]);
  const 良い = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, 鍵, 署名, 本文);
  if (!良い) throw new Error('署名が合わない');
  return 中身;
}

/** Google の公開鍵（JWK）を取って、kid で選ぶ。Cache-Control の分だけ控える */
async function 公開鍵を取る(kid) {
  if (!鍵の控え.鍵たち || 鍵の控え.期限 < Date.now()) {
    const r = await fetch(公開鍵の場所, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r.ok) throw new Error('公開鍵を取れない');
    const j = await r.json();
    const 頭 = r.headers.get('Cache-Control') || '';
    const m = 頭.match(/max-age=(\d+)/);
    const 秒 = m ? Number(m[1]) : 3600;
    鍵の控え = { 鍵たち: j.keys || [], 期限: Date.now() + Math.max(60, Math.min(秒, 86400)) * 1000 };
  }
  const jwk = 鍵の控え.鍵たち.find((k) => k.kid === kid);
  if (!jwk) {
    // 鍵が入れ替わった直後は控えが古い。一度だけ取り直す
    鍵の控え = { 鍵たち: null, 期限: 0 };
    const r = await fetch(公開鍵の場所);
    const j = await r.json();
    鍵の控え = { 鍵たち: j.keys || [], 期限: Date.now() + 3600 * 1000 };
    const 再 = 鍵の控え.鍵たち.find((k) => k.kid === kid);
    if (!再) throw new Error('公開鍵が見つからない');
    return crypto.subtle.importKey('jwk', 再, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

function base64urlをバイトに(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlを文字に(s) {
  return new TextDecoder().decode(base64urlをバイトに(s));
}
