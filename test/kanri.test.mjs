/**
 * 管理者の合言葉（POST /kanri。src/kanri.mjs）。2026-11-14。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  管理者を確かめる,
  合言葉をハッシュに,
  合言葉が合うか,
  合言葉の形か,
  まちがいの上限,
  止める長さ,
  印の長さ,
  回数,
} from '../src/kanri.mjs';
import { 証の控えを忘れる } from '../src/kojin.mjs';

async function 偽のサービスアカウント(企画 = 'kyudoscoremanager-stg') {
  const 組 = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', 組.privateKey)).toString('base64');
  return {
    type: 'service_account',
    project_id: 企画,
    client_email: `kanri@${企画}.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}

/** 偽の雲。持ち主の証（owner-token）だけが private を読める。印の書き消しを控える。
 * 部員の証（member-token）では、自分の所属の証・名簿（名簿にいる人だけ）・役の文書を読める */
function 偽の雲() {
  const 印 = new Map();
  const 部員 = { 証: { groupId: 'G1', memberId: 'm1' }, 名簿: new Set(['m1']), 役: null };
  const 返す = (中身, status = 200) => new Response(JSON.stringify(中身), { status });
  const 送る = async (url, 頼み = {}) => {
    if (url === 'https://oauth2.googleapis.com/token')
      return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 });
    const 道 = decodeURIComponent(url.replace(/^.*\/documents/, ''));
    // 本番は Firestore で App Check を強いている。その人の証の読みに端末の印が無ければ断る（サービスアカウントは通す）
    if (
      頼み.headers.Authorization !== 'Bearer sa-token' &&
      頼み.headers['X-Firebase-AppCheck'] !== 'appcheck-token'
    )
      return new Response('{}', { status: 403 });
    if (道.includes('/private/')) {
      return new Response('{}', { status: 頼み.headers.Authorization === 'Bearer owner-token' ? 404 : 403 });
    }
    if (頼み.headers.Authorization === 'Bearer member-token' && !頼み.method) {
      if (道 === '/member_claims/u1')
        return 部員.証
          ? 返す({
              fields: {
                groupId: { stringValue: 部員.証.groupId },
                memberId: { stringValue: 部員.証.memberId },
              },
            })
          : 返す({}, 404);
      const 名簿 = 道.match(/^\/groups\/G1\/members\/(.+)$/);
      if (名簿) return 返す({}, 部員.名簿.has(名簿[1]) ? 200 : 403);
      if (道 === '/groups/G1/config/roles') return 部員.役 ? 返す({ fields: 部員.役 }) : 返す({}, 404);
      return 返す({}, 403);
    }
    assert.strictEqual(頼み.headers.Authorization, 'Bearer sa-token', '印はサービスアカウントで書く');
    if (頼み.method === 'PATCH') {
      印.set(道, JSON.parse(頼み.body).fields);
      return new Response('{}', { status: 200 });
    }
    if (頼み.method === 'DELETE') {
      印.delete(道);
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { 送る, 印, 部員 };
}

function 偽の置き場() {
  const 表 = new Map();
  return {
    表,
    読む: async (鍵) => (表.has(鍵) ? structuredClone(表.get(鍵)) : null),
    書く: async (鍵, 値) => void 表.set(鍵, 値),
    // D1 の 1 回の書き込みと同じく、足すのは割り込まれない
    一つ足す: async (鍵) => {
      const 前 = 表.get(鍵) || { 数: 0, 止める: 0 };
      const 後 = { ...前, 数: (前.数 || 0) + 1 };
      表.set(鍵, 後);
      await Promise.resolve();
      return structuredClone(後);
    },
  };
}

const 頼み = (体) =>
  new Request('https://x/kanri', { method: 'POST', body: JSON.stringify({ 団体: 'G1', ...体 }) });

async function 用意(今 = Date.parse('2026-11-14T03:00:00Z')) {
  証の控えを忘れる();
  const env = { FIREBASE_SA_KEYS: JSON.stringify(await 偽のサービスアカウント()) };
  const 雲 = 偽の雲();
  const 置き場 = 偽の置き場();
  const 本人 = { sub: 'u1', aud: 'kyudoscoremanager-stg', auth_time: Math.floor(今 / 1000) - 60 };
  const 呼ぶ = (体, 中 = {}) =>
    管理者を確かめる(頼み(体), env, { ...本人, ...(中.本人 || {}) }, 中.証 || 'owner-token', {
      送る: 雲.送る,
      置き場,
      今: 中.今 || 今,
      印: '印' in 中 ? 中.印 : 'appcheck-token',
    });
  return { 呼ぶ, 雲, 置き場, 今 };
}

test('合言葉のハッシュ：同じ合言葉なら合い、違えば合わない。合言葉そのものは置かない', async () => {
  const 控え = await 合言葉をハッシュに('ゆみや2026', undefined, 1000);
  assert.ok(!JSON.stringify(控え).includes('ゆみや'));
  assert.equal(await 合言葉が合うか('ゆみや2026', 控え), true);
  assert.equal(await 合言葉が合うか('ゆみや2027', 控え), false);
  assert.equal(合言葉の形か('12345'), false);
  assert.equal(合言葉の形か('      '), false);
  assert.equal(合言葉の形か('123456'), true);
});

test('持ち主でない証は断る（private を読めない）', async () => {
  const { 呼ぶ } = await 用意();
  const 答え = await 呼ぶ({ 操作: '様子' }, { 証: 'member-token' });
  assert.equal(答え.状態, 403);
});

test('作る：入り直した直後だけ作れる。作ったら印（12 時間）を書く。2 度目は作れない', async () => {
  const { 呼ぶ, 雲, 今 } = await 用意();
  assert.equal((await 呼ぶ({ 操作: '様子' })).中身.合言葉あり, false);
  const 古い = await 呼ぶ(
    { 操作: '作る', 新しい: 'abcdef12' },
    { 本人: { auth_time: Math.floor(今 / 1000) - 3600 } }
  );
  assert.equal(古い.中身.結果, '入り直しが要る');
  const 作った = await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  assert.equal(作った.中身.結果, '作った');
  assert.equal(作った.中身.期限, 今 + 印の長さ);
  const 書いた = 雲.印.get('/admin_sessions/G1_u1');
  assert.equal(書いた.groupId.stringValue, 'G1');
  assert.equal(Date.parse(書いた.expiresAt.timestampValue), 今 + 印の長さ);
  // 端末ごと（11/19 本人）：この証のログインの時刻を書く（決まりが今の証の auth_time と照らし合わせる）
  assert.equal(書いた.authTime.integerValue, String(Math.floor(今 / 1000) - 60));
  assert.equal((await 呼ぶ({ 操作: '作る', 新しい: 'zzzzzz99' })).中身.結果, 'もうある');
  assert.equal((await 呼ぶ({ 操作: '様子' })).中身.合言葉あり, true);
});

test('入る：合えば印。5 回まちがえると 15 分止まり、止まっている間は正しくても入れない', async () => {
  const { 呼ぶ, 雲, 今 } = await 用意();
  await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  雲.印.clear();
  for (let i = 1; i < まちがいの上限; i++) {
    const 違う = await 呼ぶ({ 操作: '入る', 合言葉: 'xxxxxx' });
    assert.equal(違う.中身.結果, '違う');
    assert.equal(違う.中身.残り, まちがいの上限 - i);
  }
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'xxxxxx' })).状態, 429);
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'abcdef12' })).状態, 429);
  assert.equal(雲.印.size, 0);
  const あと = await 呼ぶ({ 操作: '入る', 合言葉: 'abcdef12' }, { 今: 今 + 止める長さ + 1000 });
  assert.equal(あと.中身.結果, '入れた');
  assert.ok(雲.印.has('/admin_sessions/G1_u1'));
});

test('変える：今の合言葉が合うか、入り直した直後なら変えられる。出ると印が消える', async () => {
  const { 呼ぶ, 雲, 今 } = await 用意();
  await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  const 古い入り = { 本人: { auth_time: Math.floor(今 / 1000) - 3600 } };
  assert.equal(
    (await 呼ぶ({ 操作: '変える', 今の: 'zzzzzz', 新しい: 'newpass1' }, 古い入り)).中身.結果,
    '違う'
  );
  assert.equal(
    (await 呼ぶ({ 操作: '変える', 今の: 'abcdef12', 新しい: 'newpass1' }, 古い入り)).中身.結果,
    '変えた'
  );
  // 忘れたとき：入り直した直後なら今の合言葉なしで変えられる
  assert.equal((await 呼ぶ({ 操作: '変える', 新しい: 'newpass2' })).中身.結果, '変えた');
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'newpass1' })).中身.結果, '違う');
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'newpass2' })).中身.結果, '入れた');
  await 呼ぶ({ 操作: '出る' });
  assert.equal(雲.印.size, 0);
});

/** REST の役の文書の欄 */
const 役の欄 = (役, 割り当て) => ({
  役: {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(役).map(([id, 部品]) => [
          id,
          {
            mapValue: {
              fields: {
                名: { stringValue: id },
                部品: { arrayValue: { values: 部品.map((字) => ({ stringValue: 字 })) } },
              },
            },
          },
        ])
      ),
    },
  },
  割り当て: {
    mapValue: {
      fields: Object.fromEntries(Object.entries(割り当て).map(([m, r]) => [m, { stringValue: r }])),
    },
  },
});

test('運営の役の人（11/19）：様子・入る・出るは使える。作る・変えるは団体の持ち主だけ', async () => {
  const { 呼ぶ, 雲 } = await 用意();
  await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  雲.印.clear();
  雲.部員.役 = 役の欄({}, { m1: 'unei' });
  const 部員で = { 証: 'member-token' };
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).中身.合言葉あり, true);
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'xxxxxx' }, 部員で)).中身.結果, '違う');
  const 入った = await 呼ぶ({ 操作: '入る', 合言葉: 'abcdef12' }, 部員で);
  assert.equal(入った.中身.結果, '入れた');
  assert.ok(雲.印.has('/admin_sessions/G1_u1'), '印を書いていない');
  assert.equal((await 呼ぶ({ 操作: '作る', 新しい: 'zzzzzz99' }, 部員で)).状態, 403);
  assert.equal((await 呼ぶ({ 操作: '変える', 今の: 'abcdef12', 新しい: 'zzzzzz99' }, 部員で)).状態, 403);
  await 呼ぶ({ 操作: '出る' }, 部員で);
  assert.equal(雲.印.size, 0);
});

test('役の無い部員・合言葉の要る部品の無い役・名簿にいない人・ほかの団体の証は断る。作った役でも部品があれば通す', async () => {
  const { 呼ぶ, 雲 } = await 用意();
  await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  const 部員で = { 証: 'member-token' };
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 403, '役の文書が無い（部員（自分））のに通した');
  雲.部員.役 = 役の欄({ r_kakari: ['付ける', '出欠'] }, { m1: 'r_kakari' });
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 403, '出欠の係を通した');
  雲.部員.役 = 役の欄({ r_meibo: ['メンバー'] }, { m1: 'r_meibo' });
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 200, 'メンバーの部品のある役を通さない');
  雲.部員.役 = 役の欄({}, { m1: 'r_kesita' });
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 403, '消した役（部員（自分））を通した');
  雲.部員.役 = 役の欄({}, { m1: 'unei' });
  雲.部員.名簿.clear();
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 403, '名簿にいない人を通した');
  雲.部員.名簿.add('m1');
  雲.部員.証 = { groupId: 'G2', memberId: 'm1' };
  assert.equal((await 呼ぶ({ 操作: '様子' }, 部員で)).状態, 403, 'ほかの団体の証を通した');
});

test('App Check（11/19 の見直し）：端末の印を、その人の証の読みに添える。添えないと持ち主も断られる', async () => {
  const { 呼ぶ } = await 用意();
  assert.equal((await 呼ぶ({ 操作: '様子' })).状態, 200, '印を添えた持ち主が通らない');
  assert.equal((await 呼ぶ({ 操作: '様子' }, { 印: '' })).状態, 403, '偽の雲が印なしの読みを断っていない');
});

test('PBKDF2 の回数（11/19 の見直し）：Workers の無料枠（1 回の CPU 10ms）に収まる回数で作り、控えに残した回数で照合する', async () => {
  // 10 万回は手元の PC で 1 回 10.5ms。変えるは 2 回まわすので、2 万回を超えないこと
  assert.ok(回数 <= 20000, `回数が多すぎる（${回数}）`);
  const 今の = await 合言葉をハッシュに('ゆみや2026');
  assert.equal(今の.回, 回数, '控えに回数が残っていない');
  // 前の回数で作った控えも、その回数で照合する（回数を変えても、作ってある合言葉は使える）
  const 前の = await 合言葉をハッシュに('ゆみや2026', undefined, 3000);
  assert.equal(await 合言葉が合うか('ゆみや2026', 前の), true);
  assert.equal(await 合言葉が合うか('ゆみや2027', 前の), false);
});

test('入る：同時に何本もまちがえても、確かめるのは上限まで。数え漏れずに止まる（11/28 の点検）', async () => {
  const { 呼ぶ, 雲 } = await 用意();
  await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  雲.印.clear();
  const 答え = await Promise.all(Array.from({ length: 10 }, () => 呼ぶ({ 操作: '入る', 合言葉: 'xxxxxx' })));
  const 違う = 答え.filter((a) => a.中身.結果 === '違う').length;
  assert.ok(違う <= まちがいの上限 - 1, `同時の試しで ${違う} 回も確かめた`);
  assert.ok(答え.filter((a) => a.状態 === 429).length >= 10 - (まちがいの上限 - 1));
  // 止まっているので、正しい合言葉でも入れない
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'abcdef12' })).状態, 429);
  assert.equal(雲.印.size, 0);
});
