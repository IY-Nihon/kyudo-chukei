/**
 * アプリの改善のための保存（/hozon）。
 *
 * 使う人が AI に送ったものと、AI の答え・読み取りの結果を取っておく。2026-09-26 に運用者が
 * 決めた（AI チャットの質問と答え・写真読み取りの結果と直しと写真・出欠の予定表の読み取り）。
 * プライバシーポリシー第12条に書く。1 年で消す。
 *
 * ■ 置き場
 *   文字の記録 … D1（KAIZEN_DB、表 kaizen_logs）。1 年を過ぎた行は毎日の定時の処理で消す
 *   写真・PDF … KV（KAIZEN_PHOTOS）。書くときに 1 年の期限を付ける（KV が自分で消す）
 *   どちらも置かれていなければ 503 を返す（アプリは黙って捨てる。AI 機能は止めない）
 *
 * ■ 道
 *   POST /hozon                        {id, 種類, 中身} … 文字の記録を 1 件（JSON、256KB まで）
 *   PUT  /hozon/photo/{id}/{番}         体はそのままの写真・PDF（5MB まで）
 *   写真は JSON に埋めない。Workers の無料枠は 1 回の依頼で CPU 10ms までで、数 MB の JSON や
 *   base64 を読み解くと超える。体は読み解かずに KV へ流し込む
 *
 * ■ 守り
 *   ・ログインの証と出どころは、Gemini の中継と同じ確かめを通ったあとに来る（index.mjs）
 *   ・写真は、同じ人（証の sub）が先に書いた記録の id にしか付けられない
 */

export const 保存の種類 = ['チャット', '写真読み取り', '予定表'];
export const 保存の日数 = 365;
export const 文の上限 = 256 * 1024;
export const 写真の上限 = 5 * 1024 * 1024;
export const 写真の型 = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const idの形 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * /hozon への依頼を受ける。
 * @param {Request} request
 * @param {URL} url
 * @param {object} env KAIZEN_DB（D1）・KAIZEN_PHOTOS（KV）
 * @param {{sub: string, aud: string}} 本人 確かめたログインの証の中身
 * @param {number} [今]
 * @returns {Promise<{状態: number, 中身: object}>}
 */
export async function 保存を受ける(request, url, env, 本人, 今 = Date.now()) {
  if (!env.KAIZEN_DB) return { 状態: 503, 中身: { error: '保存の置き場がありません' } };
  const 道 = url.pathname;

  if (道 === '/hozon' && request.method === 'POST') {
    const 文 = await request.text();
    if (文.length > 文の上限) return { 状態: 413, 中身: { error: '大きすぎます' } };
    let 依頼;
    try {
      依頼 = JSON.parse(文);
    } catch {
      return { 状態: 400, 中身: { error: 'JSON として読めません' } };
    }
    if (!依頼 || !idの形.test(String(依頼.id || ''))) return { 状態: 400, 中身: { error: 'id の形が違います' } };
    if (!保存の種類.includes(依頼.種類)) return { 状態: 400, 中身: { error: '種類が違います' } };
    const 中身 = JSON.stringify(依頼.中身 === undefined ? null : 依頼.中身);
    const 団体 = 依頼.中身 && typeof 依頼.中身 === 'object' ? String(依頼.中身.団体 || '').slice(0, 40) : '';
    try {
      await env.KAIZEN_DB.prepare(
        'INSERT INTO kaizen_logs (id, created_at, kind, project, uid, group_id, content, photos) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)'
      )
        .bind(依頼.id, 今, 依頼.種類, String(本人.aud || ''), String(本人.sub || ''), 団体, 中身)
        .run();
    } catch (e) {
      // 同じ id（送り直し）は 409。ほかは置き場の不具合
      if (/UNIQUE|constraint/i.test(String((e && e.message) || e))) return { 状態: 409, 中身: { error: '同じ id があります' } };
      return { 状態: 500, 中身: { error: '保存できませんでした' } };
    }
    return { 状態: 200, 中身: { ok: true } };
  }

  const 写真の道 = 道.match(/^\/hozon\/photo\/([0-9a-f-]{36})\/(\d)$/);
  if (写真の道 && request.method === 'PUT') {
    if (!env.KAIZEN_PHOTOS) return { 状態: 503, 中身: { error: '写真の置き場がありません' } };
    const [, id, 番] = 写真の道;
    if (!idの形.test(id)) return { 状態: 400, 中身: { error: 'id の形が違います' } };
    const 型 = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!写真の型.includes(型)) return { 状態: 415, 中身: { error: '写真か PDF だけを受け付けます' } };
    const 長さ = Number(request.headers.get('Content-Length') || 0);
    if (!長さ) return { 状態: 411, 中身: { error: '大きさが分かりません' } };
    if (長さ > 写真の上限) return { 状態: 413, 中身: { error: '大きすぎます' } };
    // 同じ人が先に書いた記録にだけ付ける
    const 行 = await env.KAIZEN_DB.prepare('SELECT uid FROM kaizen_logs WHERE id = ?1').bind(id).first();
    if (!行 || 行.uid !== String(本人.sub || '')) return { 状態: 404, 中身: { error: '記録が見つかりません' } };
    await env.KAIZEN_PHOTOS.put(`photo/${id}/${番}`, request.body, {
      expirationTtl: 保存の日数 * 86400,
      metadata: { 型, 時刻: 今 },
    });
    await env.KAIZEN_DB.prepare('UPDATE kaizen_logs SET photos = photos + 1 WHERE id = ?1').bind(id).run();
    return { 状態: 200, 中身: { ok: true } };
  }

  return { 状態: 404, 中身: { error: 'この道は受けません' } };
}

/** 1 年を過ぎた文字の記録を消す（毎日の定時の処理から呼ぶ。写真は KV の期限で消える） */
export async function 古い保存を消す(env, 今 = Date.now()) {
  if (!env.KAIZEN_DB) return 0;
  const 結果 = await env.KAIZEN_DB.prepare('DELETE FROM kaizen_logs WHERE created_at < ?1')
    .bind(今 - 保存の日数 * 86400000)
    .run();
  return (結果 && 結果.meta && 結果.meta.changes) || 0;
}
