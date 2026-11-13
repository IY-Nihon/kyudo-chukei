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
} from '../src/kanri.mjs';
import { 証の控えを忘れる } from '../src/kojin.mjs';

async function 偽のサービスアカウント(企画 = 'kyudoscoremanager-stg') {
  const 組 = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
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

/** 偽の雲。持ち主の証（owner-token）だけが private を読める。印の書き消しを控える */
function 偽の雲() {
  const 印 = new Map();
  const 送る = async (url, 頼み = {}) => {
    if (url === 'https://oauth2.googleapis.com/token')
      return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 });
    const 道 = decodeURIComponent(url.replace(/^.*\/documents/, ''));
    if (道.includes('/private/')) {
      return new Response('{}', { status: 頼み.headers.Authorization === 'Bearer owner-token' ? 404 : 403 });
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
  return { 送る, 印 };
}

function 偽の置き場() {
  const 表 = new Map();
  return { 表, 読む: async (鍵) => (表.has(鍵) ? structuredClone(表.get(鍵)) : null), 書く: async (鍵, 値) => void 表.set(鍵, 値) };
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
  const 古い = await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' }, { 本人: { auth_time: Math.floor(今 / 1000) - 3600 } });
  assert.equal(古い.中身.結果, '入り直しが要る');
  const 作った = await 呼ぶ({ 操作: '作る', 新しい: 'abcdef12' });
  assert.equal(作った.中身.結果, '作った');
  assert.equal(作った.中身.期限, 今 + 印の長さ);
  const 書いた = 雲.印.get('/admin_sessions/G1_u1');
  assert.equal(書いた.groupId.stringValue, 'G1');
  assert.equal(Date.parse(書いた.expiresAt.timestampValue), 今 + 印の長さ);
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
  assert.equal((await 呼ぶ({ 操作: '変える', 今の: 'zzzzzz', 新しい: 'newpass1' }, 古い入り)).中身.結果, '違う');
  assert.equal((await 呼ぶ({ 操作: '変える', 今の: 'abcdef12', 新しい: 'newpass1' }, 古い入り)).中身.結果, '変えた');
  // 忘れたとき：入り直した直後なら今の合言葉なしで変えられる
  assert.equal((await 呼ぶ({ 操作: '変える', 新しい: 'newpass2' })).中身.結果, '変えた');
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'newpass1' })).中身.結果, '違う');
  assert.equal((await 呼ぶ({ 操作: '入る', 合言葉: 'newpass2' })).中身.結果, '入れた');
  await 呼ぶ({ 操作: '出る' });
  assert.equal(雲.印.size, 0);
});
