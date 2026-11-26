/**
 * ライブのリンクの期限を延ばす（POST /enchou。2026-11-26 B3 本人「見本のとおり」）。
 *
 * ■ なぜ中継か
 *   リンクで配ったライブの期限は Realtime Database の live_limits（編集用と閲覧用の枝ごと）にあり、決まりは延ばすのを
 *   誰にも許さない（縮めるのは置いた口座だけ）。延ばせるのは配った人・団体アカウント・その団体の部員で、退部・卒業した人と
 *   リンクで来た部外の人は延ばせない（11/22 ⑳・11/25 ⑤ 本人）。Realtime Database の決まりは Firestore の所属を
 *   見られないので、ここで所属を確かめてからサービスアカウントで書く。サービスアカウントには Realtime Database を
 *   書ける役割（Firebase Realtime Database 管理者）が要る（README の「ライブの期限を延ばす」）。
 *
 * ■ 受けるもの
 *   POST /enchou  Authorization: Bearer <ログインの証>  体: {"団体": "<groups の鍵>", "名前": "<ライブ名>", "持ち": <ミリ秒>}
 *   返す（200）: {"結果": "延ばした", "期限": <新しい期限のミリ秒>}
 *   ほかの状態: 400 形が違う・403 延ばせない人・404 配っていないライブか鍵が無い・409 今の期限より短い・410 期限が切れた・
 *   503 届かない（Firestore・Realtime Database。サービスアカウントに役割が無いときも）
 *
 * ■ 確かめること
 *   ・人：団体アカウント（証のメールが確認済みで、団体の帳面 group_accounts のメールと同じ）か、
 *        部員（所属の証 member_claims/{uid} がその団体で、名簿にいて在籍している。src/zaiseki.mjs）
 *   ・ライブ：団体の文書の liveSecret（団体の枝）の live_sessions/{枝}/{名前}/state に、配った枝（共有の枝）がある
 *   ・期限：配った枝の期限がまだ切れていない。新しい期限は今から 持ち（12 時間・24 時間・7 日のどれか）で、今の期限より後
 *   新しい期限は、配った枝と閲覧の枝の期限（live_limits）と、盤面・閲覧用の写し・団体の枝の道しるべの 期限 に書く
 */
import { サービスアカウントを選ぶ, サービスの証, RTDBの範囲 } from './kojin.mjs';
import { 在籍しているか } from './zaiseki.mjs';

const IDの形 = /^[0-9A-Za-z_-]{1,64}$/;
/** 選べる長さ（アプリの src/liveShare.js の 期限の選択肢 から「期限なし」を除いたもの） */
export const 延ばせる持ち = [12 * 3600000, 24 * 3600000, 7 * 24 * 3600000];
/** ライブ名に使えない字（Realtime Database の道を壊す。アプリの syncRules.js の ライブ名に使えない字 と同じ） */
const 名前に使えない = /[/.#$[\]\u0000-\u001f\u007f]/;
/** 枝の形（database.rules.json と同じ 20〜64 字） */
const 枝の形 = (枝) => typeof 枝 === 'string' && 枝.length >= 20 && 枝.length <= 64 && !名前に使えない.test(枝);

const 字の欄 = (欄) => (欄 && typeof 欄.stringValue === 'string' ? 欄.stringValue : '');

/**
 * 体を読んで確かめる（雲には触らない。検査できるよう外に出す）
 * @returns {{団体: string, 名前: string, 持ち: number} | null}
 */
export function 頼みを読む(体) {
  const 団体 = String((体 && 体.団体) || '');
  const 名前 = String((体 && 体.名前) || '');
  const 持ち = Number(体 && 体.持ち);
  if (!IDの形.test(団体)) return null;
  if (!名前 || 名前.length > 200 || 名前に使えない.test(名前)) return null;
  if (!延ばせる持ち.includes(持ち)) return null;
  return { 団体, 名前, 持ち };
}

/**
 * @param {Request} request
 * @param {object} env FIREBASE_SA_KEYS
 * @param {object} 本人 確かめた証の中身（aud・sub・email・email_verified・firebase.sign_in_provider）
 * @param {{送る?: Function, 今?: number, RTDBの根?: string}} 道具
 */
export async function 期限を延ばす(request, env, 本人, 道具 = {}) {
  const 鍵束 = サービスアカウントを選ぶ(env.FIREBASE_SA_KEYS, 本人.aud);
  if (!鍵束) return { 状態: 404, 中身: { error: 'この道は中継しません' } };
  if (request.method !== 'POST') return { 状態: 405, 中身: { error: 'POST で呼んでください' } };
  if (Number(request.headers.get('Content-Length') || 0) > 2048) return { 状態: 413, 中身: { error: '大きすぎます' } };
  let 頼み;
  try {
    頼み = 頼みを読む(JSON.parse((await request.text()).slice(0, 2048)));
  } catch {
    頼み = null;
  }
  if (!頼み) return { 状態: 400, 中身: { error: '形が違います' } };
  const { 団体, 名前, 持ち } = 頼み;
  const 送る = 道具.送る || fetch;
  const 今 = 道具.今 || Date.now();
  const 文書の根 = `https://firestore.googleapis.com/v1/projects/${本人.aud}/databases/(default)/documents`;
  const RTDBの根 = (道具.RTDBの根 || `https://${本人.aud}-default-rtdb.firebaseio.com`).replace(/\/+$/, '');
  const 届かない = { 状態: 503, 中身: { error: 'いまは延ばせません。少し待ってからお試しください' } };

  let 文書の証;
  let RTDBの証;
  try {
    [文書の証, RTDBの証] = await Promise.all([
      サービスの証(鍵束, 本人.aud, { 送る, 今 }),
      サービスの証(鍵束, 本人.aud, { 送る, 今, 範囲: RTDBの範囲 }),
    ]);
  } catch {
    return 届かない;
  }
  const 文書を読む = async (道) => {
    const r = await 送る(`${文書の根}/${道}`, { headers: { Authorization: 'Bearer ' + 文書の証 } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('届かない ' + r.status);
    return (await r.json()).fields || {};
  };
  const RTDBの道 = (道) => `${RTDBの根}/${道.split('/').map(encodeURIComponent).join('/')}.json`;
  const RTDBを読む = async (道) => {
    const r = await 送る(RTDBの道(道), { headers: { Authorization: 'Bearer ' + RTDBの証 } });
    if (!r.ok) throw new Error('届かない ' + r.status);
    return r.json();
  };

  try {
    // 人：団体アカウントか、在籍している部員か
    const [帳面, 団体の文書] = await Promise.all([文書を読む(`group_accounts/${団体}`), 文書を読む(`groups/${団体}`)]);
    if (!帳面) return { 状態: 403, 中身: { error: 'この団体のライブは延ばせません' } };
    const 匿名 = !!(本人.firebase && 本人.firebase.sign_in_provider === 'anonymous');
    let 通す = false;
    if (!匿名) {
      const メール = String(本人.email || '').toLowerCase();
      通す = !!メール && 本人.email_verified === true && メール === 字の欄(帳面.email).toLowerCase();
    } else {
      const 証の欄 = await 文書を読む(`member_claims/${encodeURIComponent(本人.sub)}`);
      const memberId = 証の欄 && 字の欄(証の欄.groupId) === 団体 ? 字の欄(証の欄.memberId) : '';
      if (memberId) {
        const 名簿 = await 文書を読む(`groups/${団体}/members/${encodeURIComponent(memberId)}`);
        通す = !!名簿 && 在籍しているか(名簿);
      }
    }
    if (!通す)
      return { 状態: 403, 中身: { error: '期限を延ばせるのは、団体のアカウントと在籍しているメンバーだけです' } };

    // ライブ：団体の枝の道しるべ（または盤面）に配った枝がある
    const 団の枝 = 字の欄((団体の文書 || {}).liveSecret);
    if (!枝の形(団の枝)) return { 状態: 404, 中身: { error: 'このライブは配られていません' } };
    const 道しるべ = (await RTDBを読む(`live_sessions/${団の枝}/${名前}/state`)) || {};
    const 共の枝 = 道しるべ.共有の枝;
    const 見の枝 = 枝の形(道しるべ.閲覧の枝) ? 道しるべ.閲覧の枝 : null;
    if (!枝の形(共の枝)) return { 状態: 404, 中身: { error: 'このライブは配られていません' } };

    // 期限：まだ切れていない・今より後へ
    const 今の期限 = await RTDBを読む(`live_limits/${共の枝}`);
    if (typeof 今の期限 !== 'number' || 今の期限 <= 今)
      return { 状態: 410, 中身: { error: 'リンクの期限が切れています。続けるときは、新しくライブを配ってください' } };
    const 新しい期限 = 今 + 持ち;
    if (新しい期限 <= 今の期限) return { 状態: 409, 中身: { error: '今の期限より短くはできません', 期限: 今の期限 } };

    // 書く（まとめて 1 回）。写しは在るときだけ（無い枝に 期限 だけの写しを作らない）
    const 書くもの = {
      [`live_limits/${共の枝}`]: 新しい期限,
      [`live_sessions/${共の枝}/${名前}/state/期限`]: 新しい期限,
      [`live_sessions/${団の枝}/${名前}/state/期限`]: 新しい期限,
    };
    if (見の枝) {
      書くもの[`live_limits/${見の枝}`] = 新しい期限;
      const 写しの期限 = await RTDBを読む(`live_view/${見の枝}/${名前}/state/期限`);
      if (写しの期限 !== null) 書くもの[`live_view/${見の枝}/${名前}/state/期限`] = 新しい期限;
    }
    const r = await 送る(`${RTDBの根}/.json`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + RTDBの証, 'Content-Type': 'application/json' },
      body: JSON.stringify(書くもの),
    });
    if (!r.ok) throw new Error('書けない ' + r.status);
    return { 状態: 200, 中身: { 結果: '延ばした', 期限: 新しい期限 } };
  } catch {
    return 届かない;
  }
}
