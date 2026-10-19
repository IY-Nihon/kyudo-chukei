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
/**
 * 全部の鍵が 429（上限）だった模型と、その控えの期限（Worker の生きている間だけ）。
 * 枠が切れた模型は、期限まで飛ばして次の模型へ移る（鍵 7 つを毎回なめると、それだけで 20 秒以上待たされる。
 * 2026-09-30、3.8・3.7 の枠が切れた日に、3.6 が混むたびに写真の読み取りが止まった）
 */
const 枠切れ = new Map();
/** 枠切れの控えを持つ長さ（ms）。1 分あたりの上限なら数分で戻る。1 日の上限なら次の日まで、また試すだけ */
export const 枠切れの控え = 5 * 60 * 1000;
/** 枠切れの控えを空にする（検査で、前のテストの控えを引き継がないため） */
export function 枠切れを忘れる() {
  枠切れ.clear();
  遅い模型.clear();
}

/**
 * 待ちの上限で打ち切った模型と、その控えの期限（流し読みと生成で別に持つ）。
 * 2026-10-18 深夜：AI チャットで 3.8・3.7 が続けて答えず、毎回 25 秒ずつ打ち切ってから 3.6 に回り、
 * 1 問に 54 秒・続けた問いも 33 秒かかった（中継の記録 chukei_calls）。一度打ち切った模型は、しばらく後ろへ回す
 */
const 遅い模型 = new Map();
/** 遅い模型を後ろへ回しておく長さ（ms） */
export const 遅いの控え = 3 * 60 * 1000;

/** 503（混んでいる）のとき、送り直す前に待つ長さ（ms）。並びの数だけ送り直す */
export const 混みの待ち = [2000, 4000, 8000];

/**
 * 最初の答えを待つ長さの上限（ms）。次の模型があるときだけ、これを過ぎたら打ち切って次へ移る。
 * 2026-10-13：3.6 が混んで 3.8 に回り、その 3.8 が答えないまま 130〜150 秒たって Cloudflare に切られた（524）。
 * AI チャット（流し読み）は最初の塊まで、写真の読み取りは答え全部まで（3.6 で 20〜35 秒、遅い日で 60 秒）
 */
// 2026-10-19：流し読みは 25 秒 → 15 秒。本番の 3.8 の最初の塊は 66 回で中央 3 秒・95% 12 秒・最長 22 秒。
// 答えない日は 25 秒待っても来ず、その分だけ待たせていた
export const 待ちの上限 = { 流し読み: 15000, 生成: 45000 };
/** 全部で待てる長さ。Cloudflare は 100 秒、答えの頭が来ないと切る。最後の模型はこの残りを全部使う */
export const 全体の締め切り = 95000;

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

    // 改善のための保存（src/hozon.mjs）。回数の上限は Gemini の中継とは別に数える。
    // 同じ上限を使うと、写真を読むたびに保存の 1〜6 回ぶん Gemini の枠が減り、
    // AI チャットが「呼びすぎ」で断られやすくなる（2026-09-26）
    if (url.pathname === '/hozon' || url.pathname.startsWith('/hozon/')) {
      if (!(await 回数に収まるか(本人, env.RATE_HOZON)))
        return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);
      const 結果 = await 保存を受ける(request, url, env, 本人);
      return 答える(結果.中身, 結果.状態, 許す出どころ);
    }

    // 3. 道と模型
    const 道 = 上流の道にする(url, env.ALLOWED_MODELS.split(',').map((s) => s.trim()));
    if (!道) return 答える({ error: 'この道は中継しません' }, 404, 許す出どころ);

    // 4. 回数
    if (!(await 回数に収まるか(本人, env.RATE)))
      return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);

    // 上流へ。鍵はここで付ける。体は読み解かないが、鍵を替えて送り直せるよう一度手元に置く
    const 鍵たち = 鍵の一覧(env);
    if (!鍵たち.length) return 答える({ error: '中継に鍵が置かれていません' }, 500, 許す出どころ);
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
    // 上流へ。模型の切り替え・鍵の回し持ち・混んだときの待ちは 上流へ送る（検査できるよう外に出してある）
    const 送り始め = Date.now();
    // AI チャット（流し読みで systemInstruction のあるもの）は、連鎖の先頭の新しい模型から試す。
    // 写真の読み取りは流し読みでも頼んだ模型（3.6）から（3.8・3.7 は写真で 100 秒を超えた）
    const チャットか =
      /:streamGenerateContent$/.test(道) && !!体 && new TextDecoder().decode(体.slice(0, 体.byteLength)).indexOf('"systemInstruction":') >= 0;
    const 送り = await 上流へ送る({
      // 試験で「その模型そのものの答え」を見たいときは、X-Kyudo-No-Chain: 1 を付けると切り替えない
      候補: 候補の模型たち(
        道,
        request.headers.get('X-Kyudo-No-Chain') ? '' : チャットか ? env.MODEL_CHAIN_STREAM : env.MODEL_CHAIN,
        チャットか
      ),
      鍵たち,
      始めの鍵: 次の鍵++ % 鍵たち.length,
      search: url.search || '',
      method: request.method,
      体,
      種,
      依頼者,
    });
    if (送り.つながらない) return 答える({ error: 'Gemini につながりませんでした', 訳: 送り.訳 }, 502, 許す出どころ);
    const { 返事, 使った, 使った模型, 混んだ } = 送り;
    // そのまま返す（流し読み（SSE）もこのままで通る）
    const 出す頭 = new Headers(返事.headers);
    for (const [k, v] of Object.entries(CORSの頭(許す出どころ))) 出す頭.set(k, v);
    出す頭.delete('content-security-policy');
    // どの鍵で答えたかは返事に載せない（載せると、鍵の数と回し方が外から読める）。
    // 運用者は wrangler tail で見る
    // 答えの最初の塊が来るまでの時間（流し読みは先頭を見てから返すので、文字が出始めるまでの時間）
    const 先頭まで = Date.now() - 送り始め;
    console.log(`鍵 ${使った + 1}/${鍵たち.length} ${使った模型 || '-'} ${返事.status}${混んだ ? ` 混み${混んだ}` : ''} ${先頭まで}ms 送った${送り.送った回数}${送り.遅かった ? ` 打ち切り${送り.遅かった}` : ''}`);
    // 遅いときにどこで詰まったか後から見られるよう、1 回ごとに残す（待たない。書けなくても答えは返す）
    if (env.KAIZEN_DB && ctx && ctx.waitUntil) {
      ctx.waitUntil(
        呼んだ記録を残す(env, {
          企画: 本人.aud,
          道,
          使った模型,
          状態: 返事.status,
          先頭まで,
          送った回数: 送り.送った回数,
          混んだ,
          遅かった: 送り.遅かった || 0,
        }).catch((e) => console.warn('呼んだ記録を残せませんでした', e))
      );
    }
    return new Response(返事.body, { status: 返事.status, headers: 出す頭 });
  },

  // 毎日の定時の処理（wrangler.toml の [triggers]）。1 年を過ぎた改善のための保存を消す
  async scheduled(event, env, ctx) {
    ctx.waitUntil(古い呼んだ記録を消す(env).catch(() => {}));
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

/**
 * 人（証の sub）ごとの回数の上限に収まるか。上限の仕組みが無ければ通す（守りが1つ減るだけ）。
 * 数え は使う上限（Gemini の中継は env.RATE、保存は env.RATE_HOZON）。既定で片方へ寄せない
 * （寄せると、保存の上限を置いていないときに Gemini の枠を減らす）
 */
export async function 回数に収まるか(本人, 数え) {
  if (!数え || !本人.sub) return true;
  try {
    const { success } = await 数え.limit({ key: 本人.sub });
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-goog-api-key, x-goog-api-client, X-Kyudo-No-Chain',
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

/**
 * 上流（Gemini）へ送る。使う模型が混んでいる（503）・どの鍵も上限（429）・もう無い（404）ときは、
 * 次の模型で同じ体をもう一度送る。模型ごとに枠も混み具合も別（無料枠の上限は模型ごと：
 * 2026-09-29 に gemini-3.6-flash が 4 時間以上 503 のまま、写真の読み取りが全部止まった）。
 * 鍵は、429・403 などなら次の鍵に替える（全部だめなら次の模型へ）。最後の模型が混んでいるときだけ、
 * 待って送り直す（混みの待ち）。
 * @param {{候補:{模型:string,道:string}[], 鍵たち:string[], 始めの鍵:number, search:string, method:string,
 *   体?:ArrayBuffer, 種?:string|null, 依頼者?:string|null, fetch?:Function, 待つ?:(ms:number)=>Promise<void>}} 注文
 */
export async function 上流へ送る(注文) {
  const { 候補, 鍵たち, search, method, 体, 種, 依頼者 } = 注文;
  const 送る = 注文.fetch || fetch;
  const 待つ = 注文.待つ || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let 番 = 注文.始めの鍵;
  let 返事 = null;
  let 使った = -1;
  let 使った模型 = '';
  let 混んだ = 0;
  let 送った回数 = 0;
  let 遅かった = 0;
  const 始め = (注文.今 || Date.now)();
  const 今 = 注文.今 || Date.now;
  const 流し読みか = 候補.length && /:streamGenerateContent$/.test(候補[0].道);
  const 一つの上限 = 注文.待ちの上限 ?? (流し読みか ? 待ちの上限.流し読み : 待ちの上限.生成);
  const 締め切り = 始め + (注文.全体の締め切り ?? 全体の締め切り);
  const 切り替えの体 = [];
  const 遅いの鍵 = (模型) => (流し読みか ? '流し読み:' : '生成:') + 模型;
  const 遅いと覚える = (模型) => 模型 && 遅い模型.set(遅いの鍵(模型), Date.now() + 遅いの控え);
  for (let 順 = 0; 順 < 候補.length; 順++) {
    const 最後の模型 = 順 === 候補.length - 1;
    使った模型 = 候補[順].模型;
    // 枠が切れたばかりの模型は飛ばす（最後の模型は、切れていても試す）
    if (!最後の模型 && 候補[順].模型 && (枠切れ.get(候補[順].模型) || 0) > Date.now()) continue;
    // さっき打ち切ったばかりの模型も飛ばす（最後の模型は試す）
    if (!最後の模型 && 候補[順].模型 && (遅い模型.get(遅いの鍵(候補[順].模型)) || 0) > Date.now()) continue;
    const 今のURL = 上流 + 候補[順].道 + search;
    let 鍵を替えた = 0;
    混んだ = 0;
    let 次の模型へ = false;
    for (;;) {
      const 頭 = new Headers();
      頭.set('x-goog-api-key', 鍵たち[番]);
      if (種) 頭.set('Content-Type', 種);
      if (依頼者) 頭.set('x-goog-api-client', 依頼者);
      // 次の模型があるなら、上限を過ぎたら打ち切る（最後の模型は締め切りまで待つ）
      const 残り = 締め切り - 今();
      const 上限 = 最後の模型 ? null : Math.min(一つの上限, 残り - 5000);
      if (上限 !== null && 上限 <= 0) {
        次の模型へ = true;
        break;
      }
      const 止め = 上限 !== null && typeof AbortController !== 'undefined' ? new AbortController() : null;
      let 打ち切った = false;
      const 時計 = 止め
        ? setTimeout(() => {
            打ち切った = true;
            止め.abort();
          }, 上限)
        : null;
      try {
        送った回数++;
        返事 = await 送る(今のURL, {
          method,
          ...(止め ? { signal: 止め.signal } : {}),
          headers: 頭,
          body: (切り替えの体[順] ??=
            順 > 0
              ? チャットの考えを絞る(考えない体(体, 候補[順].道), 候補[順].模型, 候補[順].道)
              : チャットの考えを絞る(体, 候補[順].模型, 候補[順].道)),
        });
      } catch (e) {
        if (時計) clearTimeout(時計);
        if (打ち切った) {
          遅かった++;
          遅いと覚える(候補[順].模型);
          次の模型へ = true;
          break;
        }
        return { つながらない: true, 訳: String((e && e.message) || e) };
      }
      使った = 番;
      返事 = await 流れの先頭を見る(返事, 候補[順].道);
      if (時計) clearTimeout(時計);
      if (打ち切った) {
        遅かった++;
        遅いと覚える(候補[順].模型);
        次の模型へ = true;
        if (返事 && 返事.body) await 返事.body.cancel().catch(() => {});
        break;
      }
      const 訳 = await 送り直す訳(返事);
      if (訳 === '鍵' && 鍵を替えた < 鍵たち.length - 1) 鍵を替えた++;
      // 混んでいる：次の模型があれば待たずに移る。最後の模型なら、待って送り直す
      else if (訳 === '混み' && !最後の模型) 次の模型へ = true;
      else if (訳 === '混み' && 混んだ < 混みの待ち.length) await 待つ(混みの待ち[混んだ++]);
      // どの鍵も上限（429）、または模型が無い（404）：次の模型へ
      else if (!最後の模型 && (訳 === '鍵' || 返事.status === 404)) {
        次の模型へ = true;
        if (訳 === '鍵' && 候補[順].模型) 枠切れ.set(候補[順].模型, Date.now() + 枠切れの控え);
      }
      else break;
      // 使わない返事の体は捨てる（つなぎっぱなしにしない）
      if (返事.body) await 返事.body.cancel().catch(() => {});
      番 = (番 + 1) % 鍵たち.length;
      if (次の模型へ) break;
    }
    if (!次の模型へ) break;
  }
  return { 返事, 使った, 使った模型, 混んだ, 送った回数, 遅かった };
}

/**
 * 考える量が既定だと遅い模型。切り替えでここへ送る AI チャットは、考える量を チャットの考える量 に絞る。
 * 2026-10-13 の深夜に測った（3.7 は量で差が無かったので既定のまま）。3.8：既定 125 秒で打ち切り・47・17・57 秒、0 は 73・76・19 秒、1024 は 24・5・16 秒。
 * 「10秒以内に回答してください」と指示に足す案は 17・57 秒で当てにならなかったのでやめた
 */
export const 考えを絞る模型 = ['gemini-3.8-flash'];
export const チャットの考える量 = 1024;

/**
 * AI チャット（流し読みで systemInstruction のあるもの）を 考えを絞る模型 へ送るとき、考える量を絞る。
 * 依頼が自分で thinkingConfig を持っているときと、それ以外の依頼はそのまま返す。
 * @param {ArrayBuffer|Uint8Array|undefined} 体
 * @param {string} 模型
 * @param {string} 道
 */
export function チャットの考えを絞る(体, 模型, 道) {
  if (!体 || !体.byteLength || !考えを絞る模型.includes(模型) || !/:streamGenerateContent$/.test(道)) return 体;
  const 文 = new TextDecoder().decode(体);
  if (文.indexOf('"systemInstruction":') < 0 || 文.indexOf('"thinkingConfig":') >= 0) return 体;
  return 考える量を差す(体, 文, チャットの考える量);
}

/**
 * 切り替え先の模型に送る体。写真の読み取り（流し読みでも JSON 出力で道具なしのもの）は、generationConfig の
 * thinkingConfig を { thinkingBudget: 0 } にする。3.8・3.7・3.5 は考える量が既定だと 100 秒を超え、
 * Cloudflare が 524 で切る（2026-09-29 に実測。3.8 は既定で 158 秒 503、考えないと 12 秒）。
 * 依頼が自分で thinkingConfig を持っているとき、流し読み（AI チャット）、JSON として読めない体は、そのまま返す。
 * @param {ArrayBuffer|Uint8Array|undefined} 体
 * @param {string} 道
 */
export function 考えない体(体, 道) {
  if (!体 || !体.byteLength) return 体;
  // 体は写真つきで 1MB 前後になる。JSON として読み直して書き直すと、Cloudflare の CPU の上限を超えて
  // 中継が落ちた（2026-09-30。3.6 が混んで 3.8→3.7→3.5 と移るたびに、鍵の数だけ繰り返した）。
  // 文字として 1 回読み、印の文字を探して、差し込むだけにする。
  // 写真の base64 には引用符が入らず、文の中の引用符は \" と書かれるので、"tools": のような検索は本物の項目だけに当たる
  const 文 = new TextDecoder().decode(体);
  if (文.indexOf('"thinkingConfig":') >= 0) return 体;
  if (/:streamGenerateContent$/.test(道)) {
    // 流し読みは AI チャットも使う。写真の読み取り（JSON 出力で、道具・system 指示なし）だけ考えない
    if (文.indexOf('"tools":') >= 0 || 文.indexOf('"systemInstruction":') >= 0 || 文.indexOf('"responseMimeType":"application/json"') < 0) return 体;
  }
  if (文.charAt(文.length - 1) !== '}' && 文.trimEnd().charAt(文.trimEnd().length - 1) !== '}') return 体;
  return 考える量を差す(体, 文, 0);
}

/** 体の generationConfig に thinkingConfig（考える量）を文字で差し込む。差せない形ならそのまま返す */
function 考える量を差す(体, 文, 量) {
  if (文.charAt(文.length - 1) !== '}' && 文.trimEnd().charAt(文.trimEnd().length - 1) !== '}') return 体;
  const 差す = `"thinkingConfig":{"thinkingBudget":${量}}`;
  const i = 文.indexOf('"generationConfig":{');
  let 直した;
  if (i >= 0) {
    const 頭 = i + '"generationConfig":{'.length;
    直した = 文.slice(0, 頭) + 差す + (文.charAt(頭) === '}' ? '' : ',') + 文.slice(頭);
  } else {
    const 末 = 文.lastIndexOf('}');
    if (末 < 1 || 文.trim() === '{}') return 体;
    直した = 文.slice(0, 末) + ',"generationConfig":{' + 差す + '}' + 文.slice(末);
  }
  return new TextEncoder().encode(直した);
}

/**
 * 流し読み（:streamGenerateContent）は、HTTP 200 を返してから、流れの中身でエラーを返すことがある
 *（2026-09-30：混み合っている時に、200 の体が {"error":{"code":503,…}} だけの JSON だった）。
 * 状態だけ見ていると送り直しも模型の切り替えも働かず、アプリの SDK は「Failed to parse stream」で止まる。
 * 最初の塊だけ先に読み、data: で始まらず { で始まる（＝エラーの JSON）なら、そのエラーの code を
 * 状態にした返事にして返す（送り直す訳が 503・429 を見分けられる）。普通の流れは、読んだ塊を頭に戻して返す。
 * 流し読み以外・体が無いもの・200 でないものは、そのまま返す。
 * @param {Response} 返事
 * @param {string} 道
 */
export async function 流れの先頭を見る(返事, 道) {
  if (!/:streamGenerateContent$/.test(道) || !返事 || !返事.body || 返事.status !== 200) return 返事;
  const 読む = 返事.body.getReader();
  let 先頭;
  try {
    先頭 = await 読む.read();
  } catch (e) {
    return new Response('', { status: 502 });
  }
  if (先頭.done || !先頭.value) return new Response(new Uint8Array(0), { status: 返事.status, headers: 見出しを整える(返事.headers) });
  const 文 = new TextDecoder().decode(先頭.value.subarray(0, 400)).trimStart();
  if (文.startsWith('{')) {
    // エラーの JSON。残りも読んで（小さい）、code を状態にして返す
    let 全部 = new TextDecoder().decode(先頭.value);
    for (;;) {
      const 次 = await 読む.read().catch(() => ({ done: true }));
      if (次.done) break;
      全部 += new TextDecoder().decode(次.value);
    }
    let 番号 = 502;
    try {
      const c = JSON.parse(全部).error.code;
      if (Number.isInteger(c) && c >= 400 && c < 600) 番号 = c;
    } catch (e) {}
    return new Response(全部, { status: 番号, headers: { 'Content-Type': 'application/json' } });
  }
  const 続き = new ReadableStream({
    start(c) {
      c.enqueue(先頭.value);
    },
    async pull(c) {
      try {
        const 次 = await 読む.read();
        if (次.done) c.close();
        else c.enqueue(次.value);
      } catch (e) {
        c.error(e);
      }
    },
    cancel(理由) {
      return 読む.cancel(理由);
    },
  });
  return new Response(続き, { status: 返事.status, headers: 見出しを整える(返事.headers) });
}

/**
 * 読み直した流れに付ける見出し。元の返事の Content-Encoding・Content-Length・Transfer-Encoding は外す
 * （体はもう解凍されて流れになっている。付けたままだと、ブラウザが「Failed to fetch」で受け取れない。
 * 2026-09-30、流し読みの先頭を見る修正でこれを踏み、AI チャットと写真の読み取りが止まった）
 */
export function 見出しを整える(元) {
  const 頭 = new Headers(元);
  for (const k of ['content-encoding', 'content-length', 'transfer-encoding']) 頭.delete(k);
  return 頭;
}

/**
 * 模型の切り替えの候補。要求された模型を先頭に、連鎖（MODEL_CHAIN。, 区切り。新しい順）の
 * 残りを並べた順に返す。要求した模型が連鎖に無い、または模型を含まない道（一覧）は、そのまま 1 つだけ。
 * 返すのは { 模型, 道 } の並び（道は模型の名前だけを入れ替えたもの）。
 * @param {string} 道 上流の道（/v1beta/models/{model}:generateContent など）
 * @param {string|undefined} 連鎖
 * @returns {{模型:string, 道:string}[]}
 */
export function 候補の模型たち(道, 連鎖, 頭から = false) {
  const m = String(道).match(/^(\/(?:v1beta|v1)\/models\/)([^/:]+)(:(?:generateContent|streamGenerateContent))$/);
  if (!m) return [{ 模型: '', 道 }];
  const 並び = String(連鎖 || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!並び.includes(m[2])) return [{ 模型: m[2], 道 }];
  // 頭から：頼んだ模型に関わらず、連鎖の先頭（新しい模型）から試す。AI チャットはこれ（2026-10-13 に運用者が 3.8 から順にと決めた）
  if (頭から) return 並び.map((模型) => ({ 模型, 道: m[1] + 模型 + m[3] }));
  return [m[2], ...並び.filter((x) => x !== m[2])].map((模型) => ({ 模型, 道: m[1] + 模型 + m[3] }));
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

/** 呼んだ記録（chukei_calls）を残す日数。遅さを調べるためだけなので短く */
export const 呼んだ記録の日数 = 90;

/**
 * Gemini を 1 回呼んだ記録を残す。人を特定するもの（uid・中身）は置かない。
 * 何の模型で答えたか・最初の答えまで何ミリ秒か・何回送ったか（鍵や模型の切り替え）・混みの待ちの回数。
 */
export async function 呼んだ記録を残す(env, 記録, 今 = Date.now()) {
  const 種 = /:streamGenerateContent$/.test(記録.道) ? '流し読み' : '生成';
  const 頼んだ模型 = (String(記録.道).match(/models\/([^/:]+):/) || [])[1] || '';
  await env.KAIZEN_DB.prepare(
    'INSERT INTO chukei_calls (at, project, kind, requested, used, status, first_ms, sends, busy, slow) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
  )
    .bind(今, String(記録.企画 || ''), 種, 頼んだ模型, 記録.使った模型 || '', 記録.状態, 記録.先頭まで, 記録.送った回数 || 0, 記録.混んだ || 0, 記録.遅かった || 0)
    .run();
}

export async function 古い呼んだ記録を消す(env, 今 = Date.now()) {
  if (!env.KAIZEN_DB) return 0;
  const 結果 = await env.KAIZEN_DB.prepare('DELETE FROM chukei_calls WHERE at < ?1').bind(今 - 呼んだ記録の日数 * 86400000).run();
  return (結果 && 結果.meta && 結果.meta.changes) || 0;
}
