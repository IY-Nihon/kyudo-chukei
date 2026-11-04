/**
 * 公開鍵（JWK）の置き場と、署名つきの証（JWT）の確かめ。
 * Firebase のログインの証（ID トークン）と App Check の印の両方で使う。
 *
 * ■ 偽の証を何度も送られても、公開鍵を取り直し続けない（2026-11-04）
 *   前は控えに無い鍵の番号（kid）が来るたびに Google から鍵を取り直していた。偽の証を送り続けられると、
 *   そのたびに外へ取りに行き（1 回の呼び出しで使える外への呼び出しにも数えられる）、取れなかったときも確かめずに読んでいた。
 *   いまは控えに無い番号での取り直しは 1 分に 1 回まで、取れたかを見て、取り込んだ鍵は使い回す。
 */

/**
 * @param {string} 場所 JWK の一覧の URL
 * @param {{送る?: Function, 最短の取り直し?: number}} [設定]
 * @returns {(kid: string, 今?: number) => Promise<CryptoKey>}
 */
export function 鍵の置き場を作る(場所, { 送る = (...引数) => fetch(...引数), 最短の取り直し = 60 * 1000 } = {}) {
  let 控え = { 鍵たち: null, 期限: 0 };
  let 最後に取った = 0;
  const 取り込んだ = new Map();
  async function 取る(今) {
    最後に取った = 今;
    const r = await 送る(場所, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r || !r.ok) throw new Error('公開鍵を取れない');
    const j = await r.json();
    const m = String((r.headers && r.headers.get && r.headers.get('Cache-Control')) || '').match(/max-age=(\d+)/);
    const 秒 = m ? Number(m[1]) : 3600;
    控え = { 鍵たち: Array.isArray(j && j.keys) ? j.keys : [], 期限: 今 + Math.max(60, Math.min(秒, 86400)) * 1000 };
    取り込んだ.clear();
  }
  return async function 鍵を選ぶ(kid, 今 = Date.now()) {
    if (!控え.鍵たち || 控え.期限 < 今) await 取る(今);
    let jwk = 控え.鍵たち.find((k) => k.kid === kid);
    // 鍵が入れ替わった直後は控えが古い。取り直すのは 1 分に 1 回まで（偽の番号で取り直し続けない）
    if (!jwk && 今 - 最後に取った >= 最短の取り直し) {
      await 取る(今);
      jwk = 控え.鍵たち.find((k) => k.kid === kid);
    }
    if (!jwk) throw new Error('公開鍵が見つからない');
    if (!取り込んだ.has(kid)) {
      const 約束 = crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      約束.catch(() => 取り込んだ.delete(kid));
      取り込んだ.set(kid, 約束);
    }
    return 取り込んだ.get(kid);
  };
}

export function base64urlをバイトに(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64urlを文字に(s) {
  return new TextDecoder().decode(base64urlをバイトに(s));
}

/**
 * RS256 の JWT を分けて、署名を確かめる。中身の決まり（期限・発行元など）は呼ぶ側が見る。
 * @returns {Promise<{頭: object, 中身: object}>}
 */
export async function 署名を確かめる(証, 鍵を選ぶ, 今 = Date.now()) {
  const 部 = String(証 || '').split('.');
  if (部.length !== 3) throw new Error('形が違う');
  const 頭 = JSON.parse(base64urlを文字に(部[0]));
  const 中身 = JSON.parse(base64urlを文字に(部[1]));
  if (頭.alg !== 'RS256' || !頭.kid) throw new Error('署名の種類が違う');
  const 秒 = Math.floor(今 / 1000);
  if (typeof 中身.exp !== 'number' || 中身.exp <= 秒) throw new Error('期限切れ');
  if (typeof 中身.iat === 'number' && 中身.iat > 秒 + 300) throw new Error('発行日時が未来');
  const 鍵 = await 鍵を選ぶ(頭.kid, 今);
  const 良い = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    鍵,
    base64urlをバイトに(部[2]),
    new TextEncoder().encode(部[0] + '.' + 部[1])
  );
  if (!良い) throw new Error('署名が合わない');
  return { 頭, 中身 };
}

/** App Check の印の公開鍵 */
const 印の鍵を選ぶ = 鍵の置き場を作る('https://firebaseappcheck.googleapis.com/v1/jwks');

/**
 * App Check の印（X-Firebase-AppCheck）を確かめる。'ok'（正しい）・'none'（付いていない）・'bad'（正しくない）。
 * 印は reCAPTCHA の判定で端末が取る（アプリの src/setupAppCheck.js）。台本やよその頁から呼ぶと付かない
 * @param {string|null} 印
 * @param {string} 企画 ログインの証の企画（aud が projects/{企画} を含むこと）
 */
export async function 印を確かめる(印, 企画, { 鍵を選ぶ = 印の鍵を選ぶ, 今 = Date.now() } = {}) {
  if (!印) return 'none';
  try {
    const { 中身 } = await 署名を確かめる(印, 鍵を選ぶ, 今);
    if (!/^https:\/\/firebaseappcheck\.googleapis\.com\/\d+$/.test(String(中身.iss || ''))) return 'bad';
    const 宛 = Array.isArray(中身.aud) ? 中身.aud : [中身.aud];
    if (!宛.includes('projects/' + 企画)) return 'bad';
    return 'ok';
  } catch {
    return 'bad';
  }
}
