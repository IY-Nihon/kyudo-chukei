/**
 * メンバーが在籍しているか（2026-11-26 本人：卒業・退部にしたメンバーはログインできなくし、団体の記録もライブも見せない）。
 *
 * 名簿の文書（Firestore の REST の欄）から在籍の様子を読む。アプリの firestore.rules の enrolled と、
 * アプリの src/gakunen.js の 在籍の状態 と同じ見方にする：
 *   ・在籍の項目（enrollment）が「在籍」「卒業」「退部」ならそれが正
 *   ・無い・知らない値なら、前の形の卒業生の印（isAlumni・graduationYear が空でない）があれば卒業、無ければ在籍
 *   ・大学で学年 5 を卒業とした前の形は見ない（決まりでも見ない。11/26 に本番で 0 人）
 * 使うところ：ログイン（src/kojin.mjs）・自分の記録（src/jibun.mjs）。管理者モードの入り口（src/kanri.mjs）と
 * 中継の本体（通してよい人か）は、その人の証で読むので決まりが止める。
 */

/**
 * REST の欄の値（字・数・真偽・空）。欄が無い・空（nullValue）は null。
 * ほかの形（日時・入れ物など）は、決まりの truthy と同じく「空でない」として '他' を返す
 */
function 欄の値(欄) {
  if (!欄 || typeof 欄 !== 'object' || 'nullValue' in 欄) return null;
  if (typeof 欄.stringValue === 'string') return 欄.stringValue;
  if (欄.integerValue !== undefined) return Number(欄.integerValue);
  if (typeof 欄.doubleValue === 'number') return 欄.doubleValue;
  if (typeof 欄.booleanValue === 'boolean') return 欄.booleanValue;
  return '他';
}

/** 決まりの truthy と同じ（null・false・0・空の字でない） */
const 真 = (値) => 値 !== null && 値 !== false && 値 !== 0 && 値 !== '';

/**
 * 在籍の様子。名簿の文書の fields（無ければ {}）を渡す
 * @returns {'在籍'|'卒業'|'退部'}
 */
export function 在籍の状態(欄たち) {
  const 欄 = 欄たち || {};
  const 項目 = 欄の値(欄.enrollment);
  if (項目 === '在籍' || 項目 === '卒業' || 項目 === '退部') return 項目;
  return 真(欄の値(欄.isAlumni)) || 真(欄の値(欄.graduationYear)) ? '卒業' : '在籍';
}

/** 在籍しているか */
export const 在籍しているか = (欄たち) => 在籍の状態(欄たち) === '在籍';
