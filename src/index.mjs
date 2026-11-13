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
 * ■ 混んでいるとき・遅いとき（模型の切り替え。上流へ送る）
 *   模型ごとに枠も混み具合も別なので、混んでいる（503）・どの鍵も上限（429）・答えが遅い（待ちの上限）
 *   ときは、連鎖（MODEL_CHAIN・MODEL_CHAIN_STREAM）の次の模型へ同じ体を送る。
 *   最後の模型が 503 のときだけ、2・4・8 秒待って 3 回まで送り直す（鍵も次のものに替える）。
 *   それでもだめなら 503 をそのまま返し、アプリがもう少し待ってもう一度呼ぶ。
 *   （1.5・3 秒の 2 回では足りず、配信した日にまた 503 が使う人まで届いた。2026-09-20）
 */

import { 保存を受ける, 古い保存を消す, 文の上限 } from './hozon.mjs';
import { 部員を確かめる } from './kojin.mjs';
import { 管理者を確かめる } from './kanri.mjs';
import { 一日の枠に収まるか, 古い一日の数を消す } from './ichinichi.mjs';
import { 鍵の置き場を作る, 署名を確かめる, 印を確かめる, 印を強いるか } from './kagi.mjs';

const 公開鍵の場所 = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const 上流 = 'https://generativelanguage.googleapis.com';

/** ログインの証の公開鍵（控えに無い番号での取り直しは 1 分に 1 回まで。src/kagi.mjs） */
const 証の鍵を選ぶ = 鍵の置き場を作る(公開鍵の場所);
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
    const 受けた時刻 = Date.now();
    const 出どころ = request.headers.get('Origin') || '';
    const 許す出どころ = 出どころを選ぶ(出どころ, env.ALLOWED_ORIGINS);
    const 待たずに = (約束) => (ctx && ctx.waitUntil ? ctx.waitUntil(約束) : 約束);

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

    // 改善のための保存は、大きすぎる体を読む前に断る（Content-Length で先に。文字の上限 256KB）
    if (url.pathname === '/hozon' && Number(request.headers.get('Content-Length') || 0) > 文の上限)
      return 答える({ error: '大きすぎます' }, 413, 許す出どころ);

    // 2. 証
    const 証 = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!証) return 答える({ error: 'ログインの証がありません' }, 401, 許す出どころ);
    let 本人;
    try {
      本人 = await 証を確かめる(証, env.FIREBASE_PROJECT_IDS.split(',').map((s) => s.trim()));
    } catch (e) {
      return 答える({ error: 'ログインの証が正しくありません', 訳: String((e && e.message) || e) }, 401, 許す出どころ);
    }

    // App Check の印（アプリが X-Firebase-AppCheck に付ける）。APPCHECK_MODE が enforce なら、無い・正しくないものを断る。
    // 既定（log）は数えるだけ（呼んだ記録の appcheck）。ほかの前ぶれと同時に確かめる
    const 印の約束 = 印を確かめる(request.headers.get('X-Firebase-AppCheck'), 本人.aud).catch(() => 'bad');
    const 印で止めるか = async () => 印を強いるか(env, 本人.aud) && (await 印の約束) !== 'ok';
    const 印で断る = () =>
      答える({ error: 'この端末の確かめに失敗しました。ブラウザを新しくして読み込み直してください', 印: 'appcheck' }, 401, 許す出どころ);

    // 部員のログインの確かめ（src/kojin.mjs）。所属の証を書く前なので、通してよい人かは見ない
    if (url.pathname === '/kojin') {
      const 結果 = await 部員を確かめる(request, env, 本人, {
        印の様子: await 印の約束,
        回数に収まるか,
        待たずに,
      });
      return 答える(結果.中身, 結果.状態, 許す出どころ);
    }

    // 管理者の合言葉（src/kanri.mjs。2026-11-14）。持ち主かは、その人の証で団体の private を読めるかで確かめる。
    // 回数は人ごとに 1 分 10 回（部員のログインと同じ枠の数え方）。まちがいの数は kanri.mjs が団体ごとに数える
    if (url.pathname === '/kanri') {
      if (!(await 回数に収まるか({ sub: '管理:' + 本人.sub }, env.RATE_KOJIN)))
        return 答える({ error: '呼びすぎです。1 分ほど待ってからお試しください' }, 429, 許す出どころ);
      if (await 印で止めるか()) return 印で断る();
      const 結果 = await 管理者を確かめる(request, env, 本人, 証);
      return 答える(結果.中身, 結果.状態, 許す出どころ);
    }

    // 2b. 通してよい人か（確認の済んだ団体の持ち主か、所属の証のある部員だけ。2026-11-03）。
    // アプリは入っている団体を X-Kyudo-Group に付ける。付いていれば Firestore を 1 回読むだけで決まる（下の 通してよい人か）
    const 通すの約束 = 通してよい人か(本人, 証, {
      団体: request.headers.get('X-Kyudo-Group') || '',
      印: request.headers.get('X-Firebase-AppCheck') || '',
      env,
      待たずに,
    });

    // 改善のための保存（src/hozon.mjs）。回数の上限は Gemini の中継とは別に数える。
    // 同じ上限を使うと、写真を読むたびに保存の 1〜6 回ぶん Gemini の枠が減り、
    // AI チャットが「呼びすぎ」で断られやすくなる（2026-09-26）
    if (url.pathname === '/hozon' || url.pathname.startsWith('/hozon/')) {
      const [通す, 収まる] = await Promise.all([通すの約束, 回数に収まるか(本人, env.RATE_HOZON)]);
      if (!通す) return 答える({ error: 'この機能は、団体または個人でログインした人だけが使えます' }, 403, 許す出どころ);
      if (!収まる) return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);
      if (await 印で止めるか()) return 印で断る();
      const 結果 = await 保存を受ける(request, url, env, 本人);
      return 答える(結果.中身, 結果.状態, 許す出どころ);
    }

    // 3. 道と模型（体を読む前に決まる）
    const 道 = 上流の道にする(url, env.ALLOWED_MODELS.split(',').map((s) => s.trim()));
    if (!道) {
      await 通すの約束.catch(() => {});
      return 答える({ error: 'この道は中継しません' }, 404, 許す出どころ);
    }
    const 流し読みか = /:streamGenerateContent$/.test(道);

    // 4. 前ぶれを同時に進める（2026-11-04）。前は 通してよいか（米国の Firestore を 2 回続けて読む）→ 回数 → 体を受け取る →
    // 直近に答えた模型（D1）を 1 つずつ待っていた。写真では体の受け取りの間にほかが済む
    const 体の約束 =
      request.method === 'GET' || request.method === 'HEAD' ? Promise.resolve(undefined) : request.arrayBuffer();
    const 模型の約束 = 直近に答えた模型(env, 流し読みか ? '流し読み' : '生成');
    // 回数。人ごとは前ぶれと同時に数える（数えられるのはその人の枠だけ）。全員合わせての回数は、通してよい人と
    // 分かってから数える（2026-11-07 のレビュー。同時に数えると、断られる匿名の口座を作り替えて呼び続けるだけで
    // 全員の枠が埋まり、みなが「混み合っています」になった）
    const [通す, 人で] = await Promise.all([通すの約束, 回数に収まるか(本人, env.RATE)]);
    if (!通す) {
      体の約束.catch(() => {});
      return 答える({ error: 'この機能は、団体または個人でログインした人だけが使えます' }, 403, 許す出どころ);
    }
    if (!人で) return 答える({ error: '呼びすぎです。少し待ってからもう一度お試しください' }, 429, 許す出どころ);
    if (!(await 回数に収まるか({ sub: '全員' }, env.RATE_ALL)))
      return 答える({ error: 'ただいまAIが混み合っています。しばらく待ってからもう一度お試しください' }, 429, 許す出どころ);
    if (await 印で止めるか()) return 印で断る();
    // 1 日の回数の上限（src/ichinichi.mjs）。返事は Gemini の 1 日の枠切れと同じ形にする。アプリは
    // 「PerDayPerProject」で 1 日の上限と見分け、送り直さずに「夕方に戻ります」と知らせる
    const 付いた団体 = request.headers.get('X-Kyudo-Group') || '';
    const 一日 = await 一日の枠に収まるか(env, {
      企画: 本人.aud,
      人: 本人.sub,
      団体: /^[0-9A-Za-z_-]{1,64}$/.test(付いた団体) ? 付いた団体 : '',
    });
    if (!一日.収まる) {
      体の約束.catch(() => {});
      console.log(`1 日の上限（${一日.越えた}）`);
      return 答える(
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: `今日のAIの利用上限に達しました（中継の 1 日の上限・${一日.越えた}。PerDayPerProject）`,
          },
        },
        429,
        許す出どころ
      );
    }

    // 上流へ。鍵はここで付ける。体は読み解かないが、鍵を替えて送り直せるよう一度手元に置く
    const 鍵たち = 鍵の一覧(env);
    if (!鍵たち.length) return 答える({ error: '中継に鍵が置かれていません' }, 500, 許す出どころ);
    const 種 = request.headers.get('Content-Type');
    const 依頼者 = request.headers.get('x-goog-api-client');
    let 体 = await 体の約束;
    // 体を字にするのは 1 回だけ（写真では大きく、無料枠の CPU 10ms を食う）。4MB を超えるもの・JSON でないものは字にしない
    const 体の字 =
      体 && 体.byteLength < 4 * 1024 * 1024 && /json/i.test(種 || '') ? new TextDecoder().decode(体) : null;
    // 道具（function calling）の返事の role。@google/generative-ai 0.24 は functionResponse を
    // role:"function" で送るが、いまの Gemini API（3.6-flash）は 'function' を受けず
    // 「Role 'function' is not supported」の 400 を返す（2026-09-14、AI チャットで実際に）。
    // 正しくは role:"user"。アプリは 2026-09-14 から自分で role:"user" を積むので、いまは
    // 古い束（更新前の PWA）のためだけに残している。文字列の置換ではなく JSON として読み、
    // contents[].role だけを直す（文字列の中に同じ字があっても触らない）
    if (体の字 !== null) {
      const 直した = 道具の返事のroleを直す(体の字);
      if (直した !== null) 体 = new TextEncoder().encode(直した);
    }
    // 上流へ。模型の切り替え・鍵の回し持ち・混んだときの待ちは 上流へ送る（検査できるよう外に出してある）
    const 送り始め = Date.now();
    // AI チャット（流し読みで systemInstruction のあるもの）は、連鎖の先頭の新しい模型から試す。
    // 写真の読み取りは流し読みでも頼んだ模型（3.6）から（3.8・3.7 は写真で 100 秒を超えた）
    const チャットか = 流し読みか && 体の字 !== null && 体の字.indexOf('"systemInstruction":') >= 0;
    // 試験で「その模型そのものの答え」を見たいときは、X-Kyudo-No-Chain: 1 を付けると切り替えない
    const 切り替えない = !!request.headers.get('X-Kyudo-No-Chain');
    let 候補 = 候補の模型たち(道, 切り替えない ? '' : チャットか ? env.MODEL_CHAIN_STREAM : env.MODEL_CHAIN, チャットか);
    // 直近に答えた模型から試す（答えない模型を毎回待たない。答えた模型を見る長さ の説明）
    if (候補.length > 1) 候補 = 先頭に回す(候補, await 模型の約束);
    else 模型の約束.catch(() => {});
    const 前ぶれ = 送り始め - 受けた時刻;
    const 送り = await 上流へ送る({
      候補,
      頼んだ模型: (String(道).match(/models\/([^/:]+):/) || [])[1],
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
    const 印の様子 = await 印の約束;
    console.log(`鍵 ${使った + 1}/${鍵たち.length} ${使った模型 || '-'} ${返事.status}${混んだ ? ` 混み${混んだ}` : ''} 前ぶれ${前ぶれ}ms ${先頭まで}ms 送った${送り.送った回数}${送り.遅かった ? ` 打ち切り${送り.遅かった}` : ''} 印${印の様子}`);
    // 答えた模型を実体の中でも控える（次の呼び出しで D1 を読まずに済む）
    if (返事.status === 200 && 使った模型) 答えた模型を控える(流し読みか ? '流し読み' : '生成', 使った模型);
    // 遅いときにどこで詰まったか後から見られるよう、1 回ごとに残す（待たない。書けなくても答えは返す）
    if (env.KAIZEN_DB) {
      待たずに(
        呼んだ記録を残す(env, {
          企画: 本人.aud,
          道,
          使った模型,
          状態: 返事.status,
          先頭まで,
          送った回数: 送り.送った回数,
          混んだ,
          遅かった: 送り.遅かった || 0,
          印: 印の様子,
          前ぶれ,
        }).catch((e) => console.warn('呼んだ記録を残せませんでした', e))
      );
    }
    return new Response(返事.body, { status: 返事.status, headers: 出す頭 });
  },

  // 毎日の定時の処理（wrangler.toml の [triggers]）。1 年を過ぎた改善のための保存を消す
  async scheduled(event, env, ctx) {
    ctx.waitUntil(古い呼んだ記録を消す(env).catch(() => {}));
    ctx.waitUntil(古い控えを消す(env).catch(() => {}));
    ctx.waitUntil(古い一日の数を消す(env).catch(() => {}));
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
  } catch {
    // 上限の仕組みが転んでも、Gemini の中継は止めない
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
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, x-goog-api-key, x-goog-api-client, X-Kyudo-No-Chain, X-Kyudo-Group, X-Firebase-AppCheck',
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
  const 今 = 注文.今 || Date.now;
  const 始め = 今();
  const 流し読みか = 候補.length && /:streamGenerateContent$/.test(候補[0].道);
  const 一つの上限 = 注文.待ちの上限 ?? (流し読みか ? 待ちの上限.流し読み : 待ちの上限.生成);
  const 締め切り = 始め + (注文.全体の締め切り ?? 全体の締め切り);
  const 切り替えの体 = [];
  // 考えない体にしないのは、頼まれた模型だけ（先頭に回した模型が頼まれた模型とは限らない。直近に答えた模型を先頭に回す）
  const 頼んだ模型 = 注文.頼んだ模型 ?? (候補[0] && 候補[0].模型);
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
            候補[順].模型 !== 頼んだ模型
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
      // 中身の無い 200 は健康とみなさない。最後の模型でなければ次の模型へ（前はそのまま返し、アプリが 1 回送り直していた）
      if (返事 && 返事.空の流れ && !最後の模型) {
        次の模型へ = true;
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
  } catch {
    return new Response('', { status: 502 });
  }
  if (先頭.done || !先頭.value) {
    // 中身の無い 200（最初の塊を待たずに流れが終わった）。最後の模型でなければ、上流へ送る が次の模型へ移る
    const 空 = new Response(new Uint8Array(0), { status: 返事.status, headers: 見出しを整える(返事.headers) });
    空.空の流れ = true;
    return 空;
  }
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
    } catch {
      /* 読めなければ 502 のまま */
    }
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

/**
 * 直近に答えた模型を見る長さ（ms）。この間に答えた模型を、連鎖の先頭に回す。
 * 打ち切った模型の控え（遅い模型）は Worker の実体ごとにしか持てず、呼ぶたびに別の実体に当たると効かない。
 * 2026-10-22〜25：3.8・3.7 が答えなくなり、AI チャットは 1 分おきの問いでも毎回 15 秒ずつ 2 回打ち切ってから
 * 3.6 に回った（最初の字まで 33 秒）。写真の読み取りも 3.6 が混むと 3.8・3.7 に 45 秒ずつ待ち、3.5 が答えるまで 70〜150 秒。
 * 呼んだ記録（chukei_calls）は実体をまたいで残るので、そこから直近に答えた模型を読む
 */
export const 答えた模型を見る長さ = 30 * 60 * 1000;

/**
 * 直近に答えた模型（なければ空）。流し読み（AI チャット）と生成（写真の読み取りなど）で別に見る。
 * 読めなくても（表が無い・D1 が答えない）空を返し、いつもの順で送る
 * @param {{KAIZEN_DB?: any}} env
 * @param {'流し読み'|'生成'} 種
 */
export async function 直近に答えた模型(env, 種, 今 = Date.now()) {
  // 実体の中で 60 秒控える（毎回 D1 を読まない。答えたら 答えた模型を控える がすぐ入れ替える）
  const 控え = 答えた模型の控え.get(種);
  if (控え && 控え.期限 > 今) return 控え.模型;
  if (!env || !env.KAIZEN_DB) return '';
  try {
    const 行 = await env.KAIZEN_DB.prepare(
      "SELECT used FROM chukei_calls WHERE kind = ?1 AND status = 200 AND used != '' AND at > ?2 ORDER BY at DESC LIMIT 1"
    )
      .bind(種, 今 - 答えた模型を見る長さ)
      .first();
    const 模型 = (行 && 行.used) || '';
    答えた模型の控え.set(種, { 模型, 期限: 今 + 答えた模型の控えの長さ });
    return 模型;
  } catch {
    return '';
  }
}

/** 直近に答えた模型の控え（流し読み・生成ごと。実体の生きている間だけ） */
const 答えた模型の控え = new Map();
export const 答えた模型の控えの長さ = 60 * 1000;
/** いま答えた模型を控える（次の呼び出しで D1 を読まずに先頭に回す） */
export function 答えた模型を控える(種, 模型, 今 = Date.now()) {
  if (模型) 答えた模型の控え.set(種, { 模型, 期限: 今 + 答えた模型の控えの長さ });
}
/** 検査で控えを空にする */
export function 答えた模型を忘れる() {
  答えた模型の控え.clear();
}

/** 候補の並びで、その模型を先頭に回す（ほかの並びは変えない）。候補に無ければそのまま */
export function 先頭に回す(候補, 模型) {
  const i = 候補.findIndex((x) => x.模型 === 模型);
  if (i <= 0) return 候補;
  return [候補[i], ...候補.slice(0, i), ...候補.slice(i + 1)];
}

/** 通してよいかの答えの控え（企画・人・団体ごと。実体の生きている間だけ。D1 の toosu にも置いて実体をまたいで使う） */
const 通す控え = new Map();
const 通す控えの長さ = { 通す: 10 * 60 * 1000, 通さない: 60 * 1000 };
/** Firestore に届かないとき、前に通した人を通し続けてよい長さ（最後に確かめてから） */
export const 届かないときの延長 = 60 * 60 * 1000;
/** 検査で控えを空にする */
export function 通す控えを忘れる() {
  通す控え.clear();
}

/** 控えの印（人を特定しないよう、企画・人・団体をまとめてハッシュにする） */
async function 控えの印(鍵) {
  const 値 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('toosu:' + 鍵));
  return [...new Uint8Array(値)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function 雲の控えを読む(env, 印) {
  try {
    const 行 = await env.KAIZEN_DB.prepare('SELECT pass, until, checked FROM toosu WHERE key = ?1').bind(印).first();
    return 行 ? { 通す: 行.pass === 1, 期限: Number(行.until) || 0, 確かめた: Number(行.checked) || 0 } : null;
  } catch {
    return null;
  }
}
function 雲の控えに書く(env, 印, 控え) {
  return env.KAIZEN_DB.prepare(
    'INSERT INTO toosu (key, pass, until, checked) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET pass = excluded.pass, until = excluded.until, checked = excluded.checked'
  )
    .bind(印, 控え.通す ? 1 : 0, 控え.期限, 控え.確かめた)
    .run()
    .catch(() => {});
}

/**
 * 中継を通してよい人か（2026-11-03 本人）。確認の済んだ団体の持ち主か、所属の証のある部員だけ通す。
 * 匿名のログインはいくらでも作れるので、ログインしているだけでは通さない（人を替えて Gemini の枠を使い切られる）。
 *
 * 決まり（firestore.rules）と同じ見方をここに書き写さず、その人の証で Firestore の団体を読めるかで決める
 *（読めるのは、確認の済んだ持ち主・猶予中の今ある団体・所属の証のある部員）。
 *   団体が分かる（アプリが X-Kyudo-Group を付けた） … groups/{団体} を 1 回読むだけ（2026-11-04。前は米国の Firestore を 2 回続けて読んでいた）
 *   分からない（前の版のアプリ） … 匿名は member_claims/{本人} から団体を引き、メールは自分のメールの団体を引いてから読む
 * Firestore に届かないとき（混み・障害）は通さない。前に通した人だけ、最後に確かめてから 1 時間まで通す（2026-11-04。前は誰でも通していた）。
 * 答えは控える（通す 10 分・通さない 1 分）。実体の中と D1（toosu。印はハッシュ）の両方に置き、別の実体に当たっても読み直さない
 * @param {{sub: string, aud: string, email?: string, firebase?: {sign_in_provider?: string}}} 本人
 * @param {string} 証 その人の ID トークン（Firestore にその人として聞く）
 * @param {{読む?: (道: string, 中身?: object) => Promise<Response>, 今?: number, 団体?: string, env?: object, 待たずに?: Function}} [道具]
 */
export async function 通してよい人か(本人, 証, 道具 = {}) {
  const 今 = 道具.今 || Date.now();
  const 団体 = /^[0-9A-Za-z_-]{1,64}$/.test(String(道具.団体 || '')) ? String(道具.団体) : '';
  const 鍵 = `${本人.aud}|${本人.sub}|${団体}`;
  let 控え = 通す控え.get(鍵);
  if (控え && 控え.期限 > 今) return 控え.通す;
  const env = 道具.env;
  const 印 = env && env.KAIZEN_DB ? await 控えの印(鍵) : '';
  if (印) {
    const 雲 = await 雲の控えを読む(env, 印);
    if (雲 && (!控え || 雲.確かめた > 控え.確かめた)) 控え = 雲;
    if (控え && 控え.期限 > 今) {
      通す控え.set(鍵, 控え);
      return 控え.通す;
    }
  }
  const 根 = `https://firestore.googleapis.com/v1/projects/${本人.aud}/databases/(default)/documents`;
  const 読む =
    道具.読む ||
    ((道, 中身) =>
      fetch(根 + 道, {
        method: 中身 ? 'POST' : 'GET',
        // 端末の App Check の印をそのまま添える。Firestore で App Check を強いると、印の無い読みは断られ、
        // 全員が「通さない」になる（2026-11-13。強いる前に気づいた）
        headers: {
          Authorization: 'Bearer ' + 証,
          'Content-Type': 'application/json',
          ...(道具.印 ? { 'X-Firebase-AppCheck': 道具.印 } : {}),
        },
        body: 中身 ? JSON.stringify(中身) : undefined,
      }));
  let 通す;
  try {
    通す = 団体 ? await 団体を一度で読めるか(団体, 読む) : await 団体を読めるか(本人, 読む);
  } catch {
    return !!(控え && 控え.通す && 今 - 控え.確かめた < 届かないときの延長);
  }
  const 新 = { 通す, 期限: 今 + (通す ? 通す控えの長さ.通す : 通す控えの長さ.通さない), 確かめた: 今 };
  通す控え.set(鍵, 新);
  if (通す控え.size > 5000) 通す控え.clear();
  if (印) {
    const 書く = 雲の控えに書く(env, 印, 新);
    if (道具.待たずに) 道具.待たずに(書く);
  }
  return 通す;
}

/** 団体が分かっているとき：その人の証で groups/{団体} を 1 回読めるか（決まりが決める） */
async function 団体を一度で読めるか(団体, 読む) {
  const r = await 読む(`/groups/${団体}`);
  if (r.status >= 500 || r.status === 429) throw new Error('届かない');
  // 団体の文書が無くても（404）、読むのを許されたなら決まりは通している
  return r.ok || r.status === 404;
}

async function 団体を読めるか(本人, 読む) {
  const 届かない = (r) => r.status >= 500 || r.status === 429;
  let 団体 = null;
  if (本人.firebase && 本人.firebase.sign_in_provider === 'anonymous') {
    const r = await 読む(`/member_claims/${encodeURIComponent(本人.sub)}`);
    if (届かない(r)) throw new Error('届かない');
    if (!r.ok) return false;
    const j = await r.json();
    団体 = j.fields && j.fields.groupId && j.fields.groupId.stringValue;
  } else {
    if (!本人.email) return false;
    const r = await 読む(':runQuery', {
      structuredQuery: {
        from: [{ collectionId: 'group_accounts' }],
        where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: 本人.email } } },
        limit: 1,
      },
    });
    if (届かない(r)) throw new Error('届かない');
    if (!r.ok) return false;
    const j = await r.json();
    const 帳面 = (Array.isArray(j) ? j : []).find((x) => x && x.document);
    団体 = 帳面 && (帳面.document.fields?.id?.stringValue || 帳面.document.name.split('/').pop());
  }
  if (!団体 || !/^[0-9A-Za-z_-]{1,64}$/.test(団体)) return false;
  const r = await 読む(`/groups/${団体}`);
  if (届かない(r)) throw new Error('届かない');
  // 団体の文書が無くても（404）、読むのを許されたなら決まりは通している
  return r.ok || r.status === 404;
}

/** Firebase の ID トークンを確かめる。返すのは中身（sub, aud, ...） */
async function 証を確かめる(証, 企画たち) {
  const { 中身 } = await 署名を確かめる(証, 証の鍵を選ぶ);
  if (!企画たち.includes(中身.aud)) throw new Error('企画が違う');
  if (中身.iss !== `https://securetoken.google.com/${中身.aud}`) throw new Error('発行元が違う');
  if (!中身.sub) throw new Error('人が無い');
  return 中身;
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
  // appcheck … App Check の印の様子（ok・none・bad）。pre_ms … 受けてから上流へ送り始めるまで（前ぶれ。証・通してよいか・回数・体）
  await env.KAIZEN_DB.prepare(
    'INSERT INTO chukei_calls (at, project, kind, requested, used, status, first_ms, sends, busy, slow, appcheck, pre_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
  )
    .bind(今, String(記録.企画 || ''), 種, 頼んだ模型, 記録.使った模型 || '', 記録.状態, 記録.先頭まで, 記録.送った回数 || 0, 記録.混んだ || 0, 記録.遅かった || 0, String(記録.印 || ''), Number(記録.前ぶれ) || 0)
    .run();
}

export async function 古い呼んだ記録を消す(env, 今 = Date.now()) {
  if (!env.KAIZEN_DB) return 0;
  const 結果 = await env.KAIZEN_DB.prepare('DELETE FROM chukei_calls WHERE at < ?1').bind(今 - 呼んだ記録の日数 * 86400000).run();
  return (結果 && 結果.meta && 結果.meta.changes) || 0;
}

/** 通してよいかの控え（toosu）の期限の過ぎたものと、部員のログインを試した数（kojin_tries）の古いものを消す */
export async function 古い控えを消す(env, 今 = Date.now()) {
  if (!env.KAIZEN_DB) return 0;
  const 甲 = await env.KAIZEN_DB.prepare('DELETE FROM toosu WHERE checked < ?1').bind(今 - 届かないときの延長 - 86400000).run();
  const 乙 = await env.KAIZEN_DB.prepare('DELETE FROM kojin_tries WHERE at < ?1').bind(今 - 呼んだ記録の日数 * 86400000).run();
  return ((甲 && 甲.meta && 甲.meta.changes) || 0) + ((乙 && 乙.meta && 乙.meta.changes) || 0);
}
