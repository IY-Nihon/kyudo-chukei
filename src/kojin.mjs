/**
 * 部員のログインの確かめ（POST /kojin。2026-11-04 本人：ログインの総当たりができないように）。
 *
 * ■ なぜ
 *   前は部員の端末が、匿名で入ったあと自分で逆引き表（groups/{団体}/member_lookup/{個人ID}）を引き、
 *   所属の証（member_claims/{uid}）を書いていた。匿名の口座は誰でもいくらでも作れ、逆引き表は 1 件ずつなら
 *   誰でも引けたので、個人ID（6 字）が合っているかを回数の上限なしに試せた（決まりは失敗を数えられない）。
 *   30 人の団体なら当たりが 30 個あり、約 3,000 万回で 1 人に当たる。試されるだけで Firestore の 1 日の
 *   無料の読み（5 万回）も食いつぶされ、全団体が止まる。
 *   いまは端末は逆引き表を読めず（決まりで持ち主だけ）、証も書けない。ここが回数を絞ってから、サービスアカウントで
 *   引いて確かめ、証を書く。
 *
 * ■ 受けるもの
 *   POST /kojin  Authorization: Bearer <匿名のログインの証>  体: {"団体": "<groups の鍵>", "鍵": "<個人ID か招待の合言葉>"}
 *   返す（200）: {"結果": "入れた", "memberId": "...", "名前": "..."} か {"結果": "見つからない"|"期限切れ"|"団体がまだ"|"4桁は終わり"}
 *   ほかの状態: 400 形が違う・401 証が違う・403 匿名でない・429 試しすぎ・503 Firestore に届かない
 *   鍵（FIREBASE_SA_KEYS）が置かれていなければ 404（古い中継と同じ答え。アプリは前の道で入る）
 *
 * ■ 確かめること（前の firestore.rules の member_claims の決まりと同じ）
 *   ・回数：通信元（IP）ごとに 1 分 10 回・団体ごとに 1 分 60 回（RATE_KOJIN・RATE_KOJIN_GROUP）
 *   ・団体：帳面（group_accounts）があり、確認済み（verified）か今ある団体の猶予のあいだ
 *   ・鍵：6 字（I・L・O・0・1 を除く大文字と数字）か、12/2 までの 4 桁か、期限内の招待の合言葉
 *   ・部員：逆引き表の memberId が名簿にいる
 *   試した結果は D1（kojin_tries）に数だけ残す（人・通信元・団体は置かない）
 *
 * ■ 無料枠
 *   サービスアカウントの鍵で署名するのは、1 時間に 1 回（取ったアクセストークンを実体の中で控える）。
 *   1 回の確かめで Firestore を 3 回読み 1 回書く（帳面・逆引き表・名簿・証）
 */

/** 今ある団体の確認の猶予の終わり（firestore.rules の inGracePeriod・アプリの src/mailKakunin.js と同じ日） */
export const 猶予の終わり = Date.parse('2026-11-10T00:00:00Z');
/** 4 桁の個人ID を使える終わり（firestore.rules の legacyIdUsable・アプリの src/kojinId.js と同じ日） */
export const 四桁の終わり = Date.parse('2026-12-03T00:00:00Z');
const 六字の形 = /^[A-HJKMNP-Z2-9]{6}$/;
const 四桁の形 = /^[0-9]{4}$/;
const IDの形 = /^[0-9A-Za-z_-]{1,64}$/;

/** サービスアカウントのアクセストークンの控え（企画ごと。実体の生きている間だけ） */
const 証の控え = new Map();
/** 検査で控えを空にする */
export function 証の控えを忘れる() {
  証の控え.clear();
}

/**
 * 置かれた鍵（FIREBASE_SA_KEYS）から、その企画のサービスアカウントを選ぶ。
 * 形は 企画→鍵の JSON の表（{"kyudoscoremanager": {...}, "kyudoscoremanager-stg": {...}}）か、鍵の並び（project_id で選ぶ）か、鍵 1 つ
 */
export function サービスアカウントを選ぶ(置いたもの, 企画) {
  if (!置いたもの) return null;
  let 中身;
  try {
    中身 = typeof 置いたもの === 'string' ? JSON.parse(置いたもの) : 置いたもの;
  } catch {
    return null;
  }
  const 使える = (鍵) =>
    鍵 && typeof 鍵 === 'object' && 鍵.client_email && 鍵.private_key && (!鍵.project_id || 鍵.project_id === 企画) ? 鍵 : null;
  if (Array.isArray(中身)) return 中身.map(使える).find(Boolean) || null;
  if (中身 && 中身.type === 'service_account') return 使える(中身);
  return 使える(中身 && 中身[企画]);
}

const b64url = (バイト) =>
  btoa(String.fromCharCode(...new Uint8Array(バイト)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const 字をb64url = (字) => b64url(new TextEncoder().encode(字));

function PEMをバイトに(pem) {
  const 中 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(中);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * サービスアカウントで Firestore を読み書きするアクセストークン（1 時間）。控えがあればそれを使う
 * @param {{client_email: string, private_key: string, private_key_id?: string}} 鍵
 * @param {string} 企画
 */
export async function サービスの証(鍵, 企画, { 送る = fetch, 今 = Date.now() } = {}) {
  const 控え = 証の控え.get(企画);
  if (控え && 控え.期限 > 今 + 60000) return 控え.証;
  const 秒 = Math.floor(今 / 1000);
  const 本文 =
    字をb64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(鍵.private_key_id ? { kid: 鍵.private_key_id } : {}) })) +
    '.' +
    字をb64url(
      JSON.stringify({
        iss: 鍵.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: 秒,
        exp: 秒 + 3600,
      })
    );
  const 秘密 = await crypto.subtle.importKey(
    'pkcs8',
    PEMをバイトに(鍵.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const 署名 = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', 秘密, new TextEncoder().encode(本文));
  const r = await 送る('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: 本文 + '.' + b64url(署名),
    }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('サービスアカウントの証を取れません');
  証の控え.set(企画, { 証: j.access_token, 期限: 今 + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

/** Firestore の REST の値を読む */
const 字 = (欄) => (欄 && typeof 欄.stringValue === 'string' ? 欄.stringValue : '');
const 真偽 = (欄) => !!(欄 && 欄.booleanValue === true);
const 時刻 = (欄) => (欄 && 欄.timestampValue ? Date.parse(欄.timestampValue) : NaN);

/**
 * 体（{団体, 鍵}）・団体の帳面・逆引き表から、入れてよいかを決める（雲には触らない。検査できるよう外に出す）。
 * @returns {'通す'|'見つからない'|'期限切れ'|'団体がまだ'|'4桁は終わり'}
 */
export function 入れてよいか({ 鍵, 帳面, 逆引き, 今 }) {
  if (!帳面) return '見つからない';
  if (!真偽(帳面.fields && 帳面.fields.verified) && !(今 < 猶予の終わり)) return '団体がまだ';
  if (!逆引き) return '見つからない';
  const 欄 = 逆引き.fields || {};
  // 消した印の行（アプリが行を消す代わりに書く。kyudoscoremanager_app の src/kojinId.js）は無いものとして扱う
  if (!字(欄.memberId) || 真偽(欄['消した'])) return '見つからない';
  if (真偽(欄['招待'])) {
    // 期限の無い招待の文書は使えない（前の決まりと同じ）
    const 期限 = 時刻(欄.expiresAt);
    return Number.isFinite(期限) && 期限 > 今 ? '通す' : '期限切れ';
  }
  if (六字の形.test(鍵)) return '通す';
  if (四桁の形.test(鍵)) return 今 < 四桁の終わり ? '通す' : '4桁は終わり';
  return '見つからない';
}

/**
 * POST /kojin を受ける。
 * @param {Request} request
 * @param {object} env FIREBASE_SA_KEYS・RATE_KOJIN・RATE_KOJIN_GROUP・KAIZEN_DB・APPCHECK_MODE
 * @param {{sub: string, aud: string, firebase?: {sign_in_provider?: string}}} 本人 確かめたログインの証の中身
 * @param {{印の様子?: string, 送る?: Function, 今?: number, 回数に収まるか: Function, 待たずに?: (p: Promise<any>) => void}} 道具
 * @returns {Promise<{状態: number, 中身: object}>}
 */
export async function 部員を確かめる(request, env, 本人, 道具) {
  const 鍵束 = サービスアカウントを選ぶ(env.FIREBASE_SA_KEYS, 本人.aud);
  // 鍵が無ければ、古い中継と同じ答え（アプリは前の道で入る。決まりを配るまでのつなぎ）
  if (!鍵束) return { 状態: 404, 中身: { error: 'この道は中継しません' } };
  if (request.method !== 'POST') return { 状態: 405, 中身: { error: 'POST で呼んでください' } };
  if (!(本人.firebase && 本人.firebase.sign_in_provider === 'anonymous'))
    return { 状態: 403, 中身: { error: '部員のログインは匿名の口座で呼んでください' } };
  if (Number(request.headers.get('Content-Length') || 0) > 2048) return { 状態: 413, 中身: { error: '大きすぎます' } };
  let 体;
  try {
    体 = JSON.parse((await request.text()).slice(0, 2048));
  } catch {
    return { 状態: 400, 中身: { error: 'JSON として読めません' } };
  }
  const 団体 = String((体 && 体.団体) || '');
  const 鍵 = String((体 && 体.鍵) || '');
  if (!IDの形.test(団体) || !IDの形.test(鍵)) return { 状態: 400, 中身: { error: '団体か鍵の形が違います' } };

  // 回数。通信元ごと（匿名の口座を作り替えても同じ通信元）と、団体ごと（通信元を替えて 1 つの団体を狙うのを遅らせる）
  const 通信元 = request.headers.get('CF-Connecting-IP') || '';
  const [通信元で, 団体で] = await Promise.all([
    道具.回数に収まるか({ sub: '通信元:' + 通信元 }, env.RATE_KOJIN),
    道具.回数に収まるか({ sub: `団体:${本人.aud}:${団体}` }, env.RATE_KOJIN_GROUP),
  ]);
  const 今 = 道具.今 || Date.now();
  const 残す = (結果) => {
    if (!env.KAIZEN_DB) return;
    const 書く = env.KAIZEN_DB.prepare('INSERT INTO kojin_tries (at, project, result) VALUES (?1, ?2, ?3)')
      .bind(今, String(本人.aud || ''), 結果)
      .run()
      .catch(() => {});
    if (道具.待たずに) 道具.待たずに(書く);
  };
  if (!通信元で || !団体で) {
    残す('試しすぎ');
    return { 状態: 429, 中身: { error: '試した回数が多すぎます。1 分ほど待ってからお試しください' } };
  }
  if (String(env.APPCHECK_MODE || '') === 'enforce' && 道具.印の様子 !== 'ok') {
    残す('印なし');
    return { 状態: 401, 中身: { error: 'この端末の確かめに失敗しました', 印: 'appcheck' } };
  }

  const 送る = 道具.送る || fetch;
  let 証;
  try {
    証 = await サービスの証(鍵束, 本人.aud, { 送る, 今 });
  } catch {
    残す('届かない');
    return { 状態: 503, 中身: { error: 'いまは確かめられません。少し待ってからお試しください' } };
  }
  const 根 = `https://firestore.googleapis.com/v1/projects/${本人.aud}/databases/(default)/documents`;
  const 読む = async (道) => {
    const r = await 送る(根 + 道, { headers: { Authorization: 'Bearer ' + 証 } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('届かない ' + r.status);
    return r.json();
  };
  try {
    const [帳面, 逆引き] = await Promise.all([
      読む(`/group_accounts/${団体}`),
      読む(`/groups/${団体}/member_lookup/${encodeURIComponent(鍵)}`),
    ]);
    const 答え = 入れてよいか({ 鍵, 帳面, 逆引き, 今 });
    if (答え !== '通す') {
      残す(答え);
      return { 状態: 200, 中身: { 結果: 答え } };
    }
    const memberId = 字(逆引き.fields.memberId);
    if (!IDの形.test(memberId)) {
      残す('見つからない');
      return { 状態: 200, 中身: { 結果: '見つからない' } };
    }
    // 名簿にいるか（退部・削除された人の逆引きが残っていても入れない）
    const 部員 = await 読む(`/groups/${団体}/members/${memberId}`);
    if (!部員) {
      残す('見つからない');
      return { 状態: 200, 中身: { 結果: '見つからない' } };
    }
    const 書いた = await 送る(`${根}/member_claims/${encodeURIComponent(本人.sub)}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + 証, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          groupId: { stringValue: 団体 },
          memberId: { stringValue: memberId },
          personalId: { stringValue: 鍵 },
          claimedAt: { timestampValue: new Date(今).toISOString() },
        },
      }),
    });
    if (!書いた.ok) throw new Error('書けない ' + 書いた.status);
    残す('入れた');
    return { 状態: 200, 中身: { 結果: '入れた', memberId, 名前: 字(部員.fields && 部員.fields.name) } };
  } catch {
    残す('届かない');
    return { 状態: 503, 中身: { error: 'いまは確かめられません。少し待ってからお試しください' } };
  }
}
