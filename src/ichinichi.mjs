/**
 * 1 日の回数の上限（2026-11-13）。
 *
 * ■ なぜ要るか
 *   1 分あたりの上限（RATE 40 回・RATE_ALL 300 回）だけだと、1 人が 1 分 40 回を 1 日続けて 5 万回呼べる。
 *   Gemini の無料枠は全団体で分け合っているので、1 つの団体・1 人が使い切ると、みなが夕方まで使えなくなる。
 *   11/12 の夜に、作ったばかりの団体から AI を探る呼び出しがあった（notes の ai-saguri-2026-11-13）。
 *
 * ■ 数え方
 *   通してよい人・App Check の印を通ったあとの、Gemini への呼び出しだけを数える（/hozon・/kojin は数えない）。
 *   人ごと（証の sub）と、団体ごと（アプリが付ける X-Kyudo-Group。通してよい人かで読めると確かめた団体）。
 *   日の境目は Gemini の枠と同じ米国太平洋時間の 0 時（日本の 16 時・冬は 17 時）。アプリの「夕方に戻ります」の
 *   知らせがそのまま合う。
 *   D1 の ichinichi に置く。鍵はハッシュで、人も団体も分からない。古い日は定時の処理が消す。
 *   D1 に届かないときは通す（守りが 1 つ減るだけ。中継は止めない）。
 */

/** 上限（wrangler.toml の DAILY_PERSON・DAILY_GROUP が無いとき）。0 は数えない */
export const 既定の一日の上限 = { 人: 300, 団体: 1000 };

/** 枠の日（米国太平洋時間の YYYY-MM-DD） */
export function 枠の日(今 = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(今));
}

async function 印にする(字) {
  const 値 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ichinichi:' + 字));
  return [...new Uint8Array(値)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function 上限を読む(値, 既定) {
  if (値 === undefined || 値 === null || 値 === '') return 既定;
  const 数 = Number(値);
  return Number.isFinite(数) && 数 >= 0 ? Math.floor(数) : 既定;
}

/**
 * 1 回ぶん数えて、上限に収まるかを返す。
 * @param {object} env KAIZEN_DB・DAILY_PERSON・DAILY_GROUP
 * @param {{企画: string, 人: string, 団体?: string}} 誰
 * @returns {Promise<{収まる: boolean, 越えた: ''|'人'|'団体'}>}
 */
export async function 一日の枠に収まるか(env, 誰, 今 = Date.now()) {
  const 通す = { 収まる: true, 越えた: '' };
  if (!env || !env.KAIZEN_DB || !誰 || !誰.人) return 通す;
  const 上限 = {
    人: 上限を読む(env.DAILY_PERSON, 既定の一日の上限.人),
    団体: 上限を読む(env.DAILY_GROUP, 既定の一日の上限.団体),
  };
  const 日 = 枠の日(今);
  const 数える = [];
  if (上限.人 > 0) 数える.push({ 種: '人', 鍵: `${日}|${誰.企画}|人|${誰.人}` });
  if (上限.団体 > 0 && 誰.団体) 数える.push({ 種: '団体', 鍵: `${日}|${誰.企画}|団体|${誰.団体}` });
  if (!数える.length) return 通す;
  try {
    const 文 = env.KAIZEN_DB.prepare(
      'INSERT INTO ichinichi (key, day, n) VALUES (?1, ?2, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n'
    );
    const 印たち = await Promise.all(数える.map((項) => 印にする(項.鍵)));
    const 結果 = await env.KAIZEN_DB.batch(印たち.map((印) => 文.bind(印, 日)));
    for (let i = 0; i < 数える.length; i++) {
      const 行 = 結果[i] && 結果[i].results && 結果[i].results[0];
      if (行 && Number(行.n) > 上限[数える[i].種]) return { 収まる: false, 越えた: 数える[i].種 };
    }
  } catch (e) {
    console.warn('1 日の回数を数えられませんでした', e);
  }
  return 通す;
}

/** 3 日より前の日の数を消す（定時の処理） */
export async function 古い一日の数を消す(env, 今 = Date.now()) {
  if (!env || !env.KAIZEN_DB) return 0;
  const 結果 = await env.KAIZEN_DB.prepare('DELETE FROM ichinichi WHERE day < ?1')
    .bind(枠の日(今 - 3 * 86400000))
    .run();
  return (結果 && 結果.meta && 結果.meta.changes) || 0;
}
