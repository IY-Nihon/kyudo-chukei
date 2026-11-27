/**
 * 部員（自分）の記録（POST /jibun。3 段目・2026-11-19 本人）。
 *
 * ■ なぜ
 *   役に「ほかの人の記録も見られる（全員を見る）」の無い個人ログイン（部員（自分）＝役の無い人みな）は、
 *   決まり（アプリの firestore.rules の memberSeesAll）で記録（sessions）とゴミ箱を直接読めない。練習 1 回の記録は
 *   1 文書で、同じ練習の全員の ○× が入っているため。ここがサービスアカウントで読み、その人の行だけにして渡す。
 *   ほかの人の列は、名前も ○× も無い空の列として残す（消すと射位の数え方が狂う。アプリの src/chatScope.js と同じ）。
 *   自分の列でも、途中交代の相手の射は空にし、相手の名前は「（他の人）」にする。出欠は自分の分だけ。
 *
 * ■ 受けるもの
 *   POST /jibun  Authorization: Bearer <部員のログインの証（匿名の口座）>
 *   体: {"団体": "<groups の鍵>", "形": "差分"|"全部"|"id", "境目": {"記録": ms, "ごみ箱": ms}, "続き": {...}, "ids": [...],
 *        "件": 数}  件 … このページで読む数（1〜25。無ければ 5。前のページの答えの 次の件 をそのまま入れる）
 *     差分 … 境目より後に変わった記録（lastModified が日時型のもの。アプリの差分の同期と同じ）と、ゴミ箱へ移った記録の id
 *     全部 … 全部の記録（文書の名前の順に、続きで分けて）
 *     id   … その id の記録（5 件まで。端末の控えから外した記録の取り直し）
 * ■ 返す（200）
 *   {"記録": [...], "外す": [id], "消えた": [{"id", "時"}], "続き": {...}|null, "境目": {"記録": ms, "ごみ箱": ms},
 *    "次の件": 数}
 *     記録 … その人の写っている記録を、その人の行だけにしたもの（日時はミリ秒）
 *     外す … 読んだが、その人の写っていない（写らなくなった）記録・無かった記録の id（端末から外す）
 *     消えた … ゴミ箱へ移った記録の id とその時刻（差分の最初のページだけ。端末は、それより後に直した手元の記録は残す）
 *     続き … まだ続きがあれば、次に体へそのまま入れる。無ければ null
 *     境目 … このページで読んだ文書の lastModified（日時型）のいちばん新しいもの。端末はページをまたいで大きい方を取る
 *     次の件 … 次のページで頼むとよい数。このページの答えの大きさから決める（大きい記録なら少なく。下の「無料枠」）
 *   ほかの状態: 400 形が違う・403 匿名でない／所属の証が無い・429 呼びすぎ（index.mjs）・503 Firestore に届かない
 *   鍵（FIREBASE_SA_KEYS）が置かれていなければ 404（古い中継と同じ。アプリは前の道で記録を直接読む）
 *
 * ■ 確かめること（決まりの isClaimedMember と同じ）
 *   所属の証（member_claims/{uid}）の団体が体の団体と同じ・名簿にいて在籍している（卒業・退部でない。11/26）・
 *   4 桁の証は 12/3 まで・団体が確認済み（か猶予の間）。確かめは 1 分控えるので、卒業・退部にしてから最大 1 分は渡ることがある
 *
 * ■ 無料枠
 *   1 回で Firestore を 3 回（証・帳面・名簿）と記録の 1 ページ（25 件まで）読む。Workers の無料枠は 1 回の CPU が
 *   10ms。答えの字を読む（JSON）のが重く、手元で測ると 1 ページの答えが 500KB で約 2ms、射手 30 人 × 40 射の矢所つき
 *   （1 件約 160KB）は 25 件で約 24ms だった（11/20）。だから最初のページは 5 件にし、答えの大きさから次の件数を決めて返す
 *  （ふつうの記録ならすぐ 25 件ずつ、矢所つきの大きい記録なら少しずつ）。絞るときは要る欄だけ作る
 */

import { サービスアカウントを選ぶ, サービスの証, 猶予の終わり, 四桁の終わり } from './kojin.mjs';
import { 在籍しているか } from './zaiseki.mjs';

/** 1 回で返す記録の数の上限（CPU の上限に収めるため。上の「無料枠」） */
export const ページ = 25;
/** 件を頼まれないときの 1 ページの数（最初のページ。記録の大きさが分からないので小さく） */
export const 初めの件 = 5;
/** 1 ページの答えの大きさの目安（字の数）。次の件はこれに収まるように決める */
export const 目安の大きさ = 500 * 1024;
/** id で取り直すときの上限（端末も 5 件ずつ頼む） */
export const idの上限 = 5;
/**
 * 所属の確かめ（証・帳面・名簿の 3 回の読み）を控える長さ。全部を取るときは続けて何十回も呼ぶので、そのたびに読むと
 * 読みの数が倍になる。控えは Worker の実体の中だけ。名簿から外された人は、長くてもこの間だけ読める（11/20 の見直し）
 */
export const 確かめの控えの長さ = 60 * 1000;
const 確かめの控え = new Map();
/** 検査で控えを空にする */
export function 確かめの控えを忘れる() {
  確かめの控え.clear();
}
/** 差分の最初のページで見るゴミ箱の数 */
export const ごみ箱の上限 = 300;
/** 他の人の氏名の代わり（アプリの src/chatScope.js と同じ） */
export const 他の人 = '（他の人）';

/** 団体の鍵の形（groups の鍵。6 桁の団体 ID など） */
const IDの形 = /^[0-9A-Za-z_-]{1,64}$/;
/**
 * 記録・メンバーの id として受けてよいか。Firestore の文書の id は / 以外の字を何でも使える（検証環境には日本語の id の
 * 記録がある）ので、字の種類では絞らない。/ を含まない・. と .. でない・長すぎない、だけを見る（11/20 の見直し）
 */
const 文書のidか = (id) =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 400 &&
  !id.includes('/') &&
  id !== '.' &&
  id !== '..';
const 四桁の形 = /^[0-9]{4}$/;

// ── Firestore の REST の値を、ふつうの値に直す（日時はミリ秒） ──
function 値に(欄) {
  if (!欄 || typeof 欄 !== 'object') return undefined;
  if ('stringValue' in 欄) return 欄.stringValue;
  if ('integerValue' in 欄) return Number(欄.integerValue);
  if ('doubleValue' in 欄) return Number(欄.doubleValue);
  if ('booleanValue' in 欄) return !!欄.booleanValue;
  if ('nullValue' in 欄) return null;
  if ('timestampValue' in 欄) return Date.parse(欄.timestampValue);
  if ('arrayValue' in 欄) return ((欄.arrayValue && 欄.arrayValue.values) || []).map(値に);
  if ('mapValue' in 欄) return 中身に((欄.mapValue && 欄.mapValue.fields) || {});
  return undefined;
}
/** 文書の fields を、ふつうの値の表に直す */
export function 中身に(欄たち) {
  const 出 = {};
  for (const [鍵, 欄] of Object.entries(欄たち || {})) {
    const 値 = 値に(欄);
    if (値 !== undefined) 出[鍵] = 値;
  }
  return 出;
}
const 字 = (欄) => (欄 && typeof 欄.stringValue === 'string' ? 欄.stringValue : '');
const 真偽 = (欄) => !!(欄 && 欄.booleanValue === true);
/** lastModified が日時型ならその文字（続きにそのまま使う。ナノ秒まで保つ）。数の古い形は null */
const 日時の字 = (文書) => {
  const 欄 = 文書 && 文書.fields && 文書.fields.lastModified;
  return 欄 && typeof 欄.timestampValue === 'string' ? 欄.timestampValue : null;
};
// Firestore の REST は、名前の中の id をそのまま返す（% で表さない。まとめて取るときも、そのままの名前でしか見つからない）。
// だから %を戻さない（% を含む id を壊し、% の後ろが数字でないと落ちる。11/20 の見直し）
const 名のid = (名) =>
  String(名 || '')
    .split('/')
    .pop();
const 文書のid = (文書) => 名のid(文書 && 文書.name);

// ── その人の行だけにする（アプリの src/syncRules.js の 自分の射手か・src/statsRules.js・src/chatScope.js と同じ決まり） ──

/** その列が自分のものか（交代で入った列も）。部員 ID の付いた列・交代は ID だけで、名前で拾うのは ID の無いものだけ */
export function 自分の射手か(射手, 自分id, 自分名) {
  if (!射手) return false;
  if (自分id && 射手.memberId === 自分id) return true;
  if ((!自分id || !射手.memberId) && 自分名 && 射手.name === 自分名) return true;
  const 交代のid =
    射手.substitutionIds && typeof 射手.substitutionIds === 'object' ? 射手.substitutionIds : {};
  if (自分id && Object.values(交代のid).includes(自分id)) return true;
  if (自分名 && 射手.substitutions && typeof 射手.substitutions === 'object') {
    for (const [位置, 相手] of Object.entries(射手.substitutions)) {
      if ((!自分id || !交代のid[位置]) && 相手 === 自分名) return true;
    }
  }
  return false;
}

/** 途中交代を踏まえて、その 1 射を引いた人の部員 ID（statsRules と同じ） */
function その射の部員id(射手, 射目) {
  let id = 射手.memberId;
  const 交代のid = 射手.substitutionIds;
  const 位置たち = new Set();
  for (const 元 of [射手.substitutions, 交代のid]) {
    if (元 && typeof 元 === 'object') for (const 鍵 of Object.keys(元)) 位置たち.add(Number(鍵));
  }
  const 順 = [...位置たち].filter((数) => Number.isFinite(数)).sort((甲, 乙) => 甲 - 乙);
  for (const 位置 of 順) {
    if (位置 > 射目) break;
    id = (交代のid && 交代のid[位置]) || undefined;
  }
  return id == null || id === '' ? undefined : id;
}
/** 途中交代を踏まえて、その 1 射を引いた人の表示の名前（statsRules と同じ） */
function その射の名前(射手, 射目) {
  let 名前 = 射手.name || '';
  const 交代 = 射手.substitutions;
  if (交代 && typeof 交代 === 'object') {
    const 順 = Object.keys(交代)
      .map(Number)
      .filter((数) => Number.isFinite(数))
      .sort((甲, 乙) => 甲 - 乙);
    for (const 位置 of 順) {
      if (位置 > 射目) break;
      名前 = 交代[位置] || '';
    }
  }
  return 名前;
}

/**
 * 矢所を並びにする。前の版の記録には「0・1・2…」を鍵にした表の形がある（アプリの syncRules の normalizeArrowLocations も
 * 並びに直して使う）。並びでも表でもなければ空（11/20 の見直し）。○× は並びのときだけ使う（アプリも保存した記録では
 * 並びでない ○× を空として扱う。syncRules の 記録の射手を整える）
 */
function 矢所の並び(値) {
  if (Array.isArray(値)) return 値;
  if (!値 || typeof 値 !== 'object') return [];
  const 鍵たち = Object.keys(値);
  if (!鍵たち.length || !鍵たち.every((鍵) => /^\d+$/.test(鍵))) return [];
  const 出 = Array(Math.max(...鍵たち.map(Number)) + 1).fill(null);
  for (const 鍵 of 鍵たち) 出[Number(鍵)] = 値[鍵];
  return 出;
}

/** 自分の列を、自分の射と自分の名前だけにする（chatScope の 射手を絞る と同じ） */
function 射手を絞る(射手, 自分id, 自分名) {
  const 自分の名前か = (名前) => !!名前 && !!自分名 && 名前 === 自分名;
  const 自分の列 =
    (自分id && 射手.memberId === 自分id) || ((!自分id || !射手.memberId) && 自分の名前か(射手.name));
  const 元の交代id =
    射手.substitutionIds && typeof 射手.substitutionIds === 'object' ? 射手.substitutionIds : {};
  const 交代 = {};
  for (const [位置, 相手] of Object.entries(射手.substitutions || {})) {
    const 相手id = 元の交代id[位置];
    const 自分の交代 = (自分id && 相手id === 自分id) || ((!自分id || !相手id) && 自分の名前か(相手));
    交代[位置] = 相手 === '' || 相手 == null ? '' : 自分の交代 ? 相手 : 他の人;
  }
  const 交代のid = {};
  for (const [位置, id] of Object.entries(元の交代id)) 交代のid[位置] = 自分id && id === 自分id ? id : '';
  const 自分の射か = (射目) =>
    (自分id && その射の部員id(射手, 射目) === 自分id) ||
    (自分名 && !その射の部員id(射手, 射目) && 自分の名前か(その射の名前(射手, 射目)));
  const 印たち = Array.isArray(射手.marks) ? 射手.marks : [];
  const 矢所たち = 矢所の並び(射手.arrowLocations);
  const 絞った矢所 = 矢所たち.map((矢所, 射目) => (矢所 && 自分の射か(射目) ? 矢所 : null));
  return {
    id: 射手.id,
    name: 自分の列 ? 射手.name : 他の人,
    ...(自分id && 射手.memberId === 自分id ? { memberId: 自分id } : {}),
    marks: 印たち.map((印, 射目) => (自分の射か(射目) ? (印 == null ? '' : 印) : '')),
    ...(絞った矢所.some(Boolean) ? { arrowLocations: 絞った矢所 } : {}),
    ...(自分の列 && 射手.bowWeight ? { bowWeight: 射手.bowWeight } : {}),
    substitutions: 交代,
    substitutionIds: 交代のid,
    isGuest: false,
  };
}

/** ほかの人の列を、名前も ○× も無い空の列にする（並びと 区切り・計 の印だけ残す。chatScope の 空の列にする と同じ） */
function 空の列にする(射手) {
  if (!射手 || typeof 射手 !== 'object') return 射手;
  const 列 = { id: 射手.id, name: '', marks: [], substitutions: {}, substitutionIds: {}, isGuest: false };
  if (射手.isSeparator) 列.isSeparator = true;
  if (射手.isTotalCalculator) 列.isTotalCalculator = true;
  return 列;
}

/**
 * 記録（ふつうの値の表）を、その人の行だけの形にする。その人が写っていなければ null。
 * 渡す欄は画面が使うものだけ（題・覚え書き・タグ・日付・射数・統計に入れるか・射手・自分の出欠・更新時刻）
 */
export function 自分の行だけにする(記録, 自分id, 自分名) {
  if (!記録 || typeof 記録 !== 'object') return null;
  const 射手たち = Array.isArray(記録.archers) ? 記録.archers : [];
  if (!射手たち.some((射手) => 自分の射手か(射手, 自分id, 自分名))) return null;
  const 出欠 = 記録.attendance && typeof 記録.attendance === 'object' ? 記録.attendance : null;
  return {
    id: 記録.id,
    ...(記録.date !== undefined ? { date: 記録.date } : {}),
    ...(記録.title !== undefined ? { title: 記録.title } : {}),
    ...(記録.note !== undefined ? { note: 記録.note } : {}),
    ...(Array.isArray(記録.tags) ? { tags: 記録.tags } : {}),
    ...(記録.includeInStats !== undefined ? { includeInStats: 記録.includeInStats } : {}),
    ...(記録.shotCount !== undefined ? { shotCount: 記録.shotCount } : {}),
    ...(記録.lastModified !== undefined ? { lastModified: 記録.lastModified } : {}),
    archers: 射手たち.map((射手) =>
      自分の射手か(射手, 自分id, 自分名) ? 射手を絞る(射手, 自分id, 自分名) : 空の列にする(射手)
    ),
    archerNames: 自分名 ? [自分名] : [],
    ...(出欠 && 自分id && 出欠[自分id] !== undefined ? { attendance: { [自分id]: 出欠[自分id] } } : {}),
  };
}

/** 続き（前のページの最後の文書）の形を確かめる。違えば null */
function 続きを読む(続き, 記録の根, 形) {
  if (!続き || typeof 続き !== 'object') return null;
  const 名 = String(続き.名 || '');
  if (!名.startsWith(記録の根) || !文書のidか(名.slice(記録の根.length))) return null;
  if (形 === '差分') {
    const 時 = String(続き.時 || '');
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(時)) return null;
    return { 名, 時 };
  }
  return { 名 };
}

/**
 * POST /jibun を受ける。
 * @returns {Promise<{状態: number, 中身: object}>}
 */
export async function 自分の記録を返す(request, env, 本人, 道具 = {}) {
  const 鍵束 = サービスアカウントを選ぶ(env.FIREBASE_SA_KEYS, 本人.aud);
  if (!鍵束) return { 状態: 404, 中身: { error: 'この道は中継しません' } };
  if (request.method !== 'POST') return { 状態: 405, 中身: { error: 'POST で呼んでください' } };
  if (!(本人.firebase && 本人.firebase.sign_in_provider === 'anonymous'))
    return { 状態: 403, 中身: { error: '個人でログインした人だけが使えます' } };
  if (Number(request.headers.get('Content-Length') || 0) > 8192)
    return { 状態: 413, 中身: { error: '大きすぎます' } };
  let 体;
  try {
    体 = JSON.parse((await request.text()).slice(0, 8192));
  } catch {
    return { 状態: 400, 中身: { error: 'JSON として読めません' } };
  }
  const 団体 = String((体 && 体.団体) || '');
  const 形 = String((体 && 体.形) || '');
  if (!IDの形.test(団体) || !['差分', '全部', 'id'].includes(形))
    return { 状態: 400, 中身: { error: '形が違います' } };
  const 境目 = (体 && 体.境目) || {};
  const 記録の境目 = Math.max(0, Number(境目.記録) || 0);
  const ごみ箱の境目 = Math.max(0, Number(境目.ごみ箱) || 0);
  const ids = 形 === 'id' ? (Array.isArray(体.ids) ? 体.ids.map(String) : []) : [];
  if (形 === 'id' && (!ids.length || ids.length > idの上限 || !ids.every(文書のidか)))
    return { 状態: 400, 中身: { error: 'id の形が違います' } };
  const 文書の根 = `projects/${本人.aud}/databases/(default)/documents`;
  const 記録の根 = `${文書の根}/groups/${団体}/sessions/`;
  const 続き = 体 && 体.続き ? 続きを読む(体.続き, 記録の根, 形) : null;
  if (体 && 体.続き && !続き) return { 状態: 400, 中身: { error: '続きの形が違います' } };
  const 件 = Math.min(ページ, Math.max(1, Math.floor(Number(体 && 体.件) || 初めの件)));

  const 送る = 道具.送る || fetch;
  const 今 = 道具.今 || Date.now();
  let 証;
  try {
    証 = await サービスの証(鍵束, 本人.aud, { 送る, 今 });
  } catch {
    return { 状態: 503, 中身: { error: 'いまは記録を取れません。少し待ってからお試しください' } };
  }
  const 根 = `https://firestore.googleapis.com/v1/${文書の根}`;
  const 頭 = { Authorization: 'Bearer ' + 証, 'Content-Type': 'application/json' };
  const 読む = async (道) => {
    const r = await 送る(根 + 道, { headers: { Authorization: 'Bearer ' + 証 } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('届かない ' + r.status);
    return r.json();
  };
  /** 記録の答えの大きさ（字の数。次の件を決める） */
  let 答えの大きさ = 0;
  const 問う = async (問い, 大きさを数える = false) => {
    const r = await 送る(`${根}/groups/${団体}:runQuery`, {
      method: 'POST',
      headers: 頭,
      body: JSON.stringify({ structuredQuery: 問い }),
    });
    if (!r.ok) throw new Error('届かない ' + r.status);
    const 字の答え = await r.text();
    if (大きさを数える) 答えの大きさ = 字の答え.length;
    const 行たち = JSON.parse(字の答え);
    return (Array.isArray(行たち) ? 行たち : []).map((行) => 行 && 行.document).filter(Boolean);
  };

  try {
    // 所属の証と団体の帳面（決まりの isClaimedMember と同じことを確かめる）。続けて呼ばれたら控えを使う
    const 控えの鍵 = `${本人.aud}|${本人.sub}|${団体}`;
    const 控え = 確かめの控え.get(控えの鍵);
    let memberId;
    let 自分名;
    if (控え && 控え.期限 > 今) ({ memberId, 自分名 } = 控え);
    else {
      const [証の文書, 帳面] = await Promise.all([
        読む(`/member_claims/${encodeURIComponent(本人.sub)}`),
        読む(`/group_accounts/${団体}`),
      ]);
      const 証の欄 = (証の文書 && 証の文書.fields) || {};
      memberId = 字(証の欄.memberId);
      if (!証の文書 || 字(証の欄.groupId) !== 団体 || !文書のidか(memberId))
        return { 状態: 403, 中身: { error: 'この団体の所属の証がありません' } };
      if (四桁の形.test(字(証の欄.personalId)) && 今 >= 四桁の終わり)
        return { 状態: 403, 中身: { error: '4 桁の個人ID は使えなくなりました' } };
      const 帳面の欄 = (帳面 && 帳面.fields) || {};
      if (!帳面 || !(真偽(帳面の欄.verified) || 今 < 猶予の終わり))
        return { 状態: 403, 中身: { error: '団体のメールアドレスの確認がまだです' } };
      // URL の道には % で表して入れる（id に ? や # や日本語が入っていても届くように）
      const 部員 = await 読む(`/groups/${団体}/members/${encodeURIComponent(memberId)}`);
      if (!部員) return { 状態: 403, 中身: { error: '名簿にいません' } };
      // 卒業・退部にした人には渡さない（2026-11-26 本人。決まりの isClaimedMember と同じ見方。src/zaiseki.mjs）
      if (!在籍しているか(部員.fields)) return { 状態: 403, 中身: { error: '在籍していません' } };
      自分名 = 字(部員.fields && 部員.fields.name);
      if (確かめの控え.size > 2000) 確かめの控え.clear(); // 実体の中で増えすぎないように
      確かめの控え.set(控えの鍵, { memberId, 自分名, 期限: 今 + 確かめの控えの長さ });
    }

    // 記録を読む
    let 文書たち = [];
    let 無かったid = [];
    let 次 = null;
    const 消えた = [];
    let ごみ箱の最新 = 0;
    if (形 === 'id') {
      const r = await 送る(`${根}:batchGet`, {
        method: 'POST',
        headers: 頭,
        body: JSON.stringify({ documents: ids.map((id) => 記録の根 + id) }),
      });
      if (!r.ok) throw new Error('届かない ' + r.status);
      const 返り = await r.json();
      for (const 一つ of Array.isArray(返り) ? 返り : []) {
        if (一つ && 一つ.found) 文書たち.push(一つ.found);
        else if (一つ && 一つ.missing) 無かったid.push(名のid(一つ.missing));
      }
    } else if (形 === '差分') {
      文書たち = await 問う(
        {
          from: [{ collectionId: 'sessions' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'lastModified' },
              op: 'GREATER_THAN_OR_EQUAL',
              value: { timestampValue: new Date(記録の境目).toISOString() },
            },
          },
          orderBy: [
            { field: { fieldPath: 'lastModified' }, direction: 'ASCENDING' },
            { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
          ],
          limit: 件,
          ...(続き
            ? {
                startAt: {
                  values: [{ timestampValue: 続き.時 }, { referenceValue: 続き.名 }],
                  before: false,
                },
              }
            : {}),
        },
        true
      );
      if (文書たち.length === 件) {
        const 最後 = 文書たち[文書たち.length - 1];
        次 = { 名: 最後.name, 時: 日時の字(最後) };
      }
      // ゴミ箱へ移った記録（最初のページだけ。id と時刻だけ読む）
      if (!続き) {
        const 捨てた = await 問う({
          from: [{ collectionId: 'trash' }],
          select: { fields: [{ fieldPath: 'lastModified' }] },
          where: {
            fieldFilter: {
              field: { fieldPath: 'lastModified' },
              op: 'GREATER_THAN_OR_EQUAL',
              value: { timestampValue: new Date(ごみ箱の境目).toISOString() },
            },
          },
          orderBy: [{ field: { fieldPath: 'lastModified' }, direction: 'ASCENDING' }],
          limit: ごみ箱の上限,
        });
        for (const 文書 of 捨てた) {
          const 時 = 日時の字(文書) ? Date.parse(日時の字(文書)) : 0;
          if (時 > ごみ箱の最新) ごみ箱の最新 = 時;
          消えた.push({ id: 文書のid(文書), 時 });
        }
      }
    } else {
      文書たち = await 問う(
        {
          from: [{ collectionId: 'sessions' }],
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          limit: 件,
          ...(続き ? { startAt: { values: [{ referenceValue: 続き.名 }], before: false } } : {}),
        },
        true
      );
      if (文書たち.length === 件) 次 = { 名: 文書たち[文書たち.length - 1].name };
      // 全部のときは、ゴミ箱の境目もここで決める（いちばん新しい 1 件の時刻だけ読む）
      if (!続き) {
        const 最新 = await 問う({
          from: [{ collectionId: 'trash' }],
          select: { fields: [{ fieldPath: 'lastModified' }] },
          orderBy: [{ field: { fieldPath: 'lastModified' }, direction: 'DESCENDING' }],
          limit: 1,
        });
        if (最新[0] && 日時の字(最新[0])) ごみ箱の最新 = Date.parse(日時の字(最新[0]));
      }
    }

    // その人の行だけにする
    const 記録 = [];
    const 外す = [...無かったid];
    let 記録の最新 = 0;
    for (const 文書 of 文書たち) {
      const id = 文書のid(文書);
      const 時の字 = 日時の字(文書);
      if (時の字 && Date.parse(時の字) > 記録の最新) 記録の最新 = Date.parse(時の字);
      let 絞った = null;
      try {
        絞った = 自分の行だけにする(Object.assign(中身に(文書.fields), { id }), memberId, 自分名);
      } catch {
        絞った = null; // 形の壊れた記録は渡さない（絞らずに渡す側には倒さない）
      }
      if (絞った) 記録.push(絞った);
      else 外す.push(id);
    }
    return {
      状態: 200,
      中身: {
        記録,
        外す,
        消えた,
        続き: 次,
        境目: { 記録: 記録の最新, ごみ箱: ごみ箱の最新 },
        // 次に頼むとよい数。このページの 1 件あたりの大きさで、目安の大きさに収まる数（1〜25）
        次の件: Math.min(ページ, Math.max(1, Math.floor((件 * 目安の大きさ) / Math.max(1, 答えの大きさ)))),
      },
    };
  } catch {
    return { 状態: 503, 中身: { error: 'いまは記録を取れません。少し待ってからお試しください' } };
  }
}
