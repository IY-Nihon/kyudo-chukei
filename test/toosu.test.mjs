/**
 * 中継を通してよい人か（src/index.mjs の 通してよい人か）。2026-11-03。
 * 確認の済んだ団体の持ち主か、所属の証のある部員だけ。決まりの判断は Firestore に任せ、読めるかで決める。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import { 通してよい人か, 通す控えを忘れる, 届かないときの延長 } from '../src/index.mjs';

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

test('Firestore に届かないとき（混み・障害）は通さない。前に通した人だけ、確かめてから 1 時間まで通す。答えは人ごとに控える', async () => {
  通す控えを忘れる();
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む: async () => 返事(503, {}) }), false);
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む: async () => { throw new Error('net'); } }), false);
  {
    const 前に通した = 人({ firebase: { sign_in_provider: 'anonymous' } });
    const 読める = async (道) =>
      道.startsWith('/member_claims/') ? 返事(200, { fields: { groupId: { stringValue: '100001' } } }) : 返事(200, {});
    assert.equal(await 通してよい人か(前に通した, 't', { 読む: 読める, 今: 5000 }), true);
    const 届かない = async () => 返事(503, {});
    // 控えの期限（10 分）が過ぎても、確かめてから 1 時間のうちは通す
    assert.equal(await 通してよい人か(前に通した, 't', { 読む: 届かない, 今: 5000 + 11 * 60 * 1000 }), true);
    assert.equal(await 通してよい人か(前に通した, 't', { 読む: 届かない, 今: 5000 + 届かないときの延長 + 1 }), false);
  }
  let 回 = 0;
  const 本人 = 人({ firebase: { sign_in_provider: 'anonymous' } });
  const 読む = async () => (回++, 返事(404, {}));
  await 通してよい人か(本人, 't', { 読む, 今: 1000 });
  await 通してよい人か(本人, 't', { 読む, 今: 1000 + 30 * 1000 });
  assert.equal(回, 1, '1 分のうちは控えを使う');
  await 通してよい人か(本人, 't', { 読む, 今: 1000 + 61 * 1000 });
  assert.equal(回, 2, '通さないの控えは 1 分');
});

test('団体が分かるとき（X-Kyudo-Group）は groups/{団体} を 1 回読むだけで決める', async () => {
  通す控えを忘れる();
  const 読んだ = [];
  const 読む = async (道) => (読んだ.push(道), 返事(道 === '/groups/100001' ? 200 : 403, {}));
  assert.equal(await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む, 団体: '100001' }), true);
  assert.deepStrictEqual(読んだ, ['/groups/100001'], '団体が分かるのに 2 回読んだ');
  assert.equal(await 通してよい人か(人({ email: 'a@example.com', firebase: { sign_in_provider: 'password' } }), 't', { 読む, 団体: '100002' }), false);
  // 形の合わない団体は使わず、前の道（2 回読む）で決める
  読んだ.length = 0;
  await 通してよい人か(人({ firebase: { sign_in_provider: 'anonymous' } }), 't', { 読む, 団体: '../x' });
  assert.ok(読んだ[0].startsWith('/member_claims/'));
});

test('通してよいかの控えは D1 にも置き、別の実体でも読み直さない（印はハッシュで、人が分からない）', async () => {
  通す控えを忘れる();
  const 表 = new Map();
  const env = {
    KAIZEN_DB: {
      prepare: (sql) => ({
        bind: (...v) => ({
          first: async () => 表.get(v[0]) || null,
          run: async () => {
            if (/^INSERT INTO toosu/.test(sql)) 表.set(v[0], { pass: v[1], until: v[2], checked: v[3] });
          },
        }),
      }),
    },
  };
  let 回 = 0;
  const 読む = async () => (回++, 返事(200, {}));
  const 本人 = 人({ firebase: { sign_in_provider: 'anonymous' } });
  const 書いた = [];
  assert.equal(await 通してよい人か(本人, 't', { 読む, 団体: '100001', env, 今: 1000, 待たずに: (p) => 書いた.push(p) }), true);
  await Promise.all(書いた);
  assert.equal(表.size, 1);
  const [印] = [...表.keys()];
  assert.match(印, /^[0-9a-f]{32}$/);
  assert.ok(!印.includes(本人.sub), '印に人の番号が出ている');
  // 別の実体（実体の中の控えが無い）
  通す控えを忘れる();
  assert.equal(await 通してよい人か(本人, 't', { 読む, 団体: '100001', env, 今: 2000 }), true);
  assert.equal(回, 1, 'D1 の控えがあるのに Firestore を読み直した');
});
