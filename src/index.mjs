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
 *   体はそのまま Gemini へ流す（読み解かない。写真が入っていて大きいので、
 *   Worker の CPU をほとんど使わずに済む）。
 *
 * ■ 確かめること
 *   1. 出どころ（Origin）が ALLOWED_ORIGINS にある（ブラウザから呼ぶ前提）
 *   2. Authorization: Bearer <Firebase ID トークン> が本物（Google の公開鍵で署名を検める。
 *      有効期限内、aud が FIREBASE_PROJECT_IDS のどれか、iss がその企画）
 *   3. 模型が ALLOWED_MODELS にある
 *   4. 人（sub）ごとの回数が上限内
 */

const 公開鍵の場所 = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const 上流 = 'https://generativelanguage.googleapis.com';

/** 公開鍵の控え（Worker の生きている間だけ） */
let 鍵の控え = { 鍵たち: null, 期限: 0 };

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

    // 3. 道と模型
    const 道 = 上流の道にする(url, env.ALLOWED_MODELS.split(',').map((s) => s.trim()));
    if (!道) return 答える({ error: 'この道は中継しません' }, 404, 許す出どころ);

    // 4. 回数
    if (env.RATE && 本人.sub) {
      try {
        const { success } = await env.RATE.limit({ key: 本人.sub });
        if (!success) return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);
      } catch (e) {
        // 上限の仕組みが無くても中継は続ける（守りが1つ減るだけ）
      }
    }

    // 上流へ。鍵はここで付ける。体はそのまま流す
    const 上流のURL = 上流 + 道 + (url.search || '');
    const 頭 = new Headers();
    頭.set('x-goog-api-key', env.GEMINI_API_KEY);
    const 種 = request.headers.get('Content-Type');
    if (種) 頭.set('Content-Type', 種);
    const 依頼者 = request.headers.get('x-goog-api-client');
    if (依頼者) 頭.set('x-goog-api-client', 依頼者);
    let 返事;
    try {
      返事 = await fetch(上流のURL, {
        method: request.method,
        headers: 頭,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      });
    } catch (e) {
      return 答える({ error: 'Gemini につながりませんでした', 訳: String((e && e.message) || e) }, 502, 許す出どころ);
    }
    // そのまま返す（流し読み（SSE）もこのままで通る）
    const 出す頭 = new Headers(返事.headers);
    for (const [k, v] of Object.entries(CORSの頭(許す出どころ))) 出す頭.set(k, v);
    出す頭.delete('content-security-policy');
    return new Response(返事.body, { status: 返事.status, headers: 出す頭 });
  },
};

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
