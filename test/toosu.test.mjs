/**
 * 中継を通してよい人か（src/index.mjs の 通してよい人か）。2026-11-03。
 * 確認の済んだ団体の持ち主か、所属の証のある部員だけ。決まりの判断は Firestore に任せ、読めるかで決める。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import { 通してよい人か } from '../src/index.mjs';

const 返事 = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let 番 = 0;
const 人 = (o) => Object.assign({ sub: `u${++番}`, aud: 'kyudoscoremanager-stg' }, o);

test('匿名：所属の証があり、その団体を読めれば通す', async () => {
  const 読んだ = [];
  const 読む = async (道) => {
    読んだ.push(道);
    if (道.startsWith('/member_claims/')) return 返事(200, { fields: { groupId: { stringValue: '100001' } } });
    if (道 === '/groups/100001') return 返事(200, {});
    return 返事(404, {});
  };
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む }), true);
  assert.deepStrictEqual(読んだ.slice(-1), ['/groups/100001']);
});

test('匿名：所属の証が無い（共有リンクの来客・作っただけの口座）なら通さない', async () => {
  const 読む = async () => 返事(404, {});
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む }), false);
});

test('匿名：証はあっても団体を読めない（確認の済んでいない団体・猶予のあと）なら通さない', async () => {
  const 読む = async (道) =>
    道.startsWith('/member_claims/') ? 返事(200, { fields: { groupId: { stringValue: '100002' } } }) : 返事(403, {});
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む }), false);
});

test('メール：自分のメールの団体を読めれば通す。団体が無い・読めないなら通さない', async () => {
  const 団体あり = async (道) =>
    道 === ':runQuery'
      ? 返事(200, [{ document: { name: 'x/group_accounts/123456', fields: { id: { stringValue: '123456' } } } }])
      : 返事(道 === '/groups/123456' ? 200 : 403, {});
  assert.equal(await 通してよい人か(人({ email: 'a@example.com', firebase: { sign_in_provider: 'password' } }), 't', { 読む: 団体あり }), true);
  const 団体なし = async (道) => (道 === ':runQuery' ? 返事(200, [{ readTime: 'x' }]) : 返事(403, {}));
  assert.equal(await 通してよい人か(人({ email: 'b@example.com', firebase: { sign_in_provider: 'password' } }), 't', { 読む: 団体なし }), false);
  const 確認前 = async (道) =>
    道 === ':runQuery'
      ? 返事(200, [{ document: { name: 'x/group_accounts/654321', fields: {} } }])
      : 返事(403, {});
  assert.equal(await 通してよい人か(人({ email: 'c@example.com', firebase: { sign_in_provider: 'password' } }), 't', { 読む: 確認前 }), false);
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'password' } }), 't', { 読む: 団体あり }), false, 'メールの無い証');
});

test('Firestore に届かないとき（混み・障害）は通す。答えは人ごとに控える', async () => {
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む: async () => 返事(503, {}) }), true);
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む: async () => { throw new Error('net'); } }), true);
  let 回 = 0;
  const 本人 = 人({ firebase: { sign_in_provider: 'anonymous' } });
  const 読む = async () => (回++, 返事(404, {}));
  await 通してよい人か(本人, 't', { 読む, 今: 1000 });
  await 通してよい人か(本人, 't', { 読む, 今: 1000 + 30 * 1000 });
  assert.equal(回, 1, '1 分のうちは控えを使う');
  await 通してよい人か(本人, 't', { 読む, 今: 1000 + 61 * 1000 });
  assert.equal(回, 2, '通さないの控えは 1 分');
});
