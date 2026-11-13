/**
 * 管理者の合言葉（POST /kanri。2026-11-14 本人：管理者モードを決まりで守る）。
 *
 * ■ なぜ
 *   前の管理者モードは画面の鍵だけで、団体の口座でログインした端末は決まり上なんでもできた。
 *   合言葉はここ（中継）だけが知り、合っていたら、その口座（uid）に期限つきの「管理者」の印を
 *   Firestore の admin_sessions/{団体}_{uid} に書く。決まり（firestore.rules の isGroupAdmin）は、
 *   消す・名簿・設定などをこの印のある口座だけに通す。印は端末からは書けない（決まりで write: false）。
 *
 * ■ 合言葉の置き場
 *   D1 の kanri（鍵 → 値）に、塩つきの PBKDF2-SHA256（10 万回）だけを置く。端末にも Firestore にも置かない
 *   （団体の端末から読めると、手元で総当たりされる）。
 *
 * ■ 受けるもの
 *   POST /kanri  Authorization: Bearer <団体の口座の証>  体: {"団体": "...", "操作": ..., ...}
 *     様子   … {合言葉あり}
 *     作る   {新しい}            … まだ無いときだけ。入り直した直後（5 分以内）の証が要る。作ったら印も書く
 *     入る   {合言葉}            … 合えば印を書く。{期限}
 *     変える {新しい, 今の?}      … 今の合言葉が合うか、入り直した直後の証（忘れたとき）
 *     出る                        … 印を消す
 *   返す: 200 {結果: ...}。400 形・403 持ち主でない・429 試しすぎ・503 届かない。鍵が無ければ 404
 *
 * ■ 試しすぎ
 *   団体ごとに、まちがいを数える。5 回まちがえると 15 分止める（合えば数を戻す）。
 */

import { サービスアカウントを選ぶ, サービスの証 } from './kojin.mjs';

const IDの形 = /^[0-9A-Za-z_-]{1,64}$/;
/** 合言葉の長さ（字） */
export const 合言葉の長さ = { 短い: 6, 長い: 64 };
/** 印の長さ（12 時間） */
export const 印の長さ = 12 * 60 * 60 * 1000;
/** 何回まちがえたら止めるか・何分止めるか */
export const まちがいの上限 = 5;
export const 止める長さ = 15 * 60 * 1000;
/** 入り直した直後とみなす長さ（作る・忘れたときの作り直し） */
export const 入り直しの長さ = 5 * 60 * 1000;
const 回数 = 100000;

const b64 = (バイト) => btoa(String.fromCharCode(...new Uint8Array(バイト)));
const b64をバイトに = (字) => Uint8Array.from(atob(字), (c) => c.charCodeAt(0));

/** 合言葉から、塩つきのハッシュを作る */
export async function 合言葉をハッシュに(合言葉, 塩 = crypto.getRandomValues(new Uint8Array(16)), 回 = 回数) {
  const 元 = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(合言葉).normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const 出 = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: 塩, iterations: 回 }, 元, 256);
  return { 塩: b64(塩), ハッシュ: b64(出), 回 };
}

/** 合言葉が控えと合うか（字の比べは長さをそろえて最後まで比べる） */
export async function 合言葉が合うか(合言葉, 控え) {
  if (!控え || !控え.塩 || !控え.ハッシュ) return false;
  const 作った = await 合言葉をハッシュに(合言葉, b64をバイトに(控え.塩), 控え.回 || 回数);
  const 甲 = 作った.ハッシュ;
  const 乙 = 控え.ハッシュ;
  let 違い = 甲.length ^ 乙.length;
  for (let i = 0; i < Math.max(甲.length, 乙.length); i++) 違い |= (甲.charCodeAt(i) || 0) ^ (乙.charCodeAt(i) || 0);
  return 違い === 0;
}

/** 合言葉の形（長さ・空白だけでない） */
export function 合言葉の形か(字) {
  const 文 = String(字 ?? '');
  const 長さ = [...文].length;
  return 長さ >= 合言葉の長さ.短い && 長さ <= 合言葉の長さ.長い && 文.trim().length > 0;
}

/** D1 の kanri（鍵 → 値の JSON）を読み書きする置き場 */
export function D1の置き場(db) {
  return {
    async 読む(鍵) {
      const 行 = await db.prepare('SELECT value FROM kanri WHERE key = ?1').bind(鍵).first();
      return 行 ? JSON.parse(行.value) : null;
    },
    async 書く(鍵, 値) {
      await db
        .prepare('INSERT INTO kanri (key, value, at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, at = ?3')
        .bind(鍵, JSON.stringify(値), Date.now())
        .run();
    },
  };
}

/**
 * POST /kanri を受ける。
 * @param {Request} request
 * @param {object} env FIREBASE_SA_KEYS・KAIZEN_DB
 * @param {{sub: string, aud: string, email?: string, auth_time?: number, firebase?: object}} 本人
 * @param {string} 証 呼んだ人のログインの証（持ち主かを、その人の証で private を読めるかで確かめる）
 * @param {{送る?: Function, 今?: number, 置き場?: {読む: Function, 書く: Function}}} 道具
 */
export async function 管理者を確かめる(request, env, 本人, 証, 道具 = {}) {
  const 鍵束 = サービスアカウントを選ぶ(env.FIREBASE_SA_KEYS, 本人.aud);
  if (!鍵束) return { 状態: 404, 中身: { error: 'この道は中継しません' } };
  if (request.method !== 'POST') return { 状態: 405, 中身: { error: 'POST で呼んでください' } };
  if (Number(request.headers.get('Content-Length') || 0) > 2048) return { 状態: 413, 中身: { error: '大きすぎます' } };
  let 体;
  try {
    体 = JSON.parse((await request.text()).slice(0, 2048));
  } catch {
    return { 状態: 400, 中身: { error: 'JSON として読めません' } };
  }
  const 団体 = String((体 && 体.団体) || '');
  const 操作 = String((体 && 体.操作) || '');
  if (!IDの形.test(団体) || !['様子', '作る', '入る', '変える', '出る'].includes(操作))
    return { 状態: 400, 中身: { error: '団体か操作の形が違います' } };
  const 今 = 道具.今 || Date.now();
  const 送る = 道具.送る || fetch;
  const 置き場 = 道具.置き場 || (env.KAIZEN_DB ? D1の置き場(env.KAIZEN_DB) : null);
  if (!置き場) return { 状態: 503, 中身: { error: 'いまは確かめられません' } };
  const 根 = `https://firestore.googleapis.com/v1/projects/${本人.aud}/databases/(default)/documents`;

  // 持ち主か：その人の証で、団体の private（持ち主だけが読める）を読めるか。文書が無くても読むのを許されれば 404
  try {
    const r = await 送る(`${根}/group_accounts/${団体}/private/_kanri`, {
      headers: { Authorization: 'Bearer ' + 証 },
    });
    if (r.status >= 500 || r.status === 429) throw new Error('届かない');
    if (!(r.ok || r.status === 404)) return { 状態: 403, 中身: { error: '団体の持ち主だけが使えます' } };
  } catch {
    return { 状態: 503, 中身: { error: 'いまは確かめられません。少し待ってからお試しください' } };
  }

  const 合言葉の鍵 = `合言葉|${本人.aud}|${団体}`;
  const まちがいの鍵 = `まちがい|${本人.aud}|${団体}`;
  const 入り直した直後 = Number.isFinite(本人.auth_time) && 今 - 本人.auth_time * 1000 <= 入り直しの長さ;

  let SAの証;
  const 印を書く = async () => {
    SAの証 = SAの証 || (await サービスの証(鍵束, 本人.aud, { 送る, 今 }));
    const 期限 = 今 + 印の長さ;
    const 書いた = await 送る(`${根}/admin_sessions/${団体}_${encodeURIComponent(本人.sub)}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + SAの証, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          groupId: { stringValue: 団体 },
          uid: { stringValue: 本人.sub },
          expiresAt: { timestampValue: new Date(期限).toISOString() },
        },
      }),
    });
    if (!書いた.ok) throw new Error('書けない ' + 書いた.status);
    return 期限;
  };
  const 印を消す = async () => {
    SAの証 = SAの証 || (await サービスの証(鍵束, 本人.aud, { 送る, 今 }));
    const r = await 送る(`${根}/admin_sessions/${団体}_${encodeURIComponent(本人.sub)}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + SAの証 },
    });
    if (!(r.ok || r.status === 404)) throw new Error('消せない ' + r.status);
  };

  try {
    const 控え = await 置き場.読む(合言葉の鍵);
    const まちがい = (await 置き場.読む(まちがいの鍵)) || { 数: 0, 止める: 0 };
    const 止まっている = まちがい.止める > 今;
    // 合言葉を確かめる（数える）。止まっているときは確かめずに断る
    const 確かめる = async (字) => {
      if (止まっている) return '止まっている';
      if (await 合言葉が合うか(字, 控え)) {
        if (まちがい.数) await 置き場.書く(まちがいの鍵, { 数: 0, 止める: 0 });
        return '合う';
      }
      const 数 = まちがい.数 + 1;
      await 置き場.書く(まちがいの鍵, 数 >= まちがいの上限 ? { 数: 0, 止める: 今 + 止める長さ } : { 数, 止める: 0 });
      return 数 >= まちがいの上限 ? '止めた' : '違う';
    };
    const 止めた答え = (止める) => ({
      状態: 429,
      中身: { error: `まちがいが続いたので、${Math.ceil((止める - 今) / 60000)} 分ほど待ってください`, 止める },
    });

    if (操作 === '様子') return { 状態: 200, 中身: { 結果: '様子', 合言葉あり: !!控え } };

    if (操作 === '出る') {
      await 印を消す();
      return { 状態: 200, 中身: { 結果: '出た' } };
    }

    if (操作 === '作る') {
      if (控え) return { 状態: 200, 中身: { 結果: 'もうある' } };
      if (!入り直した直後) return { 状態: 200, 中身: { 結果: '入り直しが要る' } };
      if (!合言葉の形か(体.新しい)) return { 状態: 400, 中身: { error: '合言葉は 6〜64 字にしてください' } };
      await 置き場.書く(合言葉の鍵, await 合言葉をハッシュに(体.新しい));
      const 期限 = await 印を書く();
      return { 状態: 200, 中身: { 結果: '作った', 期限 } };
    }

    if (操作 === '入る') {
      if (!控え) return { 状態: 200, 中身: { 結果: 'まだ無い' } };
      const 答え = await 確かめる(String(体.合言葉 ?? ''));
      if (答え === '止まっている') return 止めた答え(まちがい.止める);
      if (答え === '止めた') return 止めた答え(今 + 止める長さ);
      if (答え === '違う') return { 状態: 200, 中身: { 結果: '違う', 残り: まちがいの上限 - (まちがい.数 + 1) } };
      const 期限 = await 印を書く();
      return { 状態: 200, 中身: { 結果: '入れた', 期限 } };
    }

    // 変える
    if (!合言葉の形か(体.新しい)) return { 状態: 400, 中身: { error: '合言葉は 6〜64 字にしてください' } };
    if (!入り直した直後) {
      if (!控え) return { 状態: 200, 中身: { 結果: '入り直しが要る' } };
      const 答え = await 確かめる(String(体.今の ?? ''));
      if (答え === '止まっている') return 止めた答え(まちがい.止める);
      if (答え === '止めた') return 止めた答え(今 + 止める長さ);
      if (答え === '違う') return { 状態: 200, 中身: { 結果: '違う', 残り: まちがいの上限 - (まちがい.数 + 1) } };
    }
    await 置き場.書く(合言葉の鍵, await 合言葉をハッシュに(体.新しい));
    await 置き場.書く(まちがいの鍵, { 数: 0, 止める: 0 });
    const 期限 = await 印を書く();
    return { 状態: 200, 中身: { 結果: '変えた', 期限 } };
  } catch {
    return { 状態: 503, 中身: { error: 'いまは確かめられません。少し待ってからお試しください' } };
  }
}
