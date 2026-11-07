/**
 * 部員のログインの確かめ（POST /kojin。src/kojin.mjs）。2026-11-04。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  部員を確かめる,
  入れてよいか,
  サービスアカウントを選ぶ,
  証の控えを忘れる,
  猶予の終わり,
  四桁の終わり,
} from '../src/kojin.mjs';

/** テスト用のサービスアカウント（本物の RSA の鍵。署名だけ使う） */
async function 偽のサービスアカウント(企画 = 'kyudoscoremanager') {
  const 組 = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', 組.privateKey)).toString('base64');
  return {
    type: 'service_account',
    project_id: 企画,
    client_email: `kojin@${企画}.iam.gserviceaccount.com`,
    private_key_id: 'k1',
    private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}

const 欄 = {
  字: (v) => ({ stringValue: v }),
  真: { booleanValue: true },
  時: (ms) => ({ timestampValue: new Date(ms).toISOString() }),
};

/** 偽の雲（Firestore の REST とトークンの窓口） */
function 偽の雲(文書 = {}) {
  const 送った = [];
  const 書いた = [];
  let トークンを取った = 0;
  const 送る = async (url, 頼み = {}) => {
    送った.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      トークンを取った++;
      return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 });
    }
    assert.strictEqual(頼み.headers.Authorization, 'Bearer sa-token', 'サービスアカウントの証で読み書きしていない');
    const 道 = decodeURIComponent(url.replace(/^.*\/documents/, ''));
    if (頼み.method === 'PATCH') {
      書いた.push({ 道, 中身: JSON.parse(頼み.body) });
      return new Response('{}', { status: 200 });
    }
    if (文書[道] === '壊れた') return new Response('{}', { status: 503 });
    if (!文書[道]) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ fields: 文書[道] }), { status: 200 });
  };
  return { 送る, 送った, 書いた, トークンを取った: () => トークンを取った };
}

const 団体の文書 = (追加 = {}) => ({
  '/group_accounts/100001': { id: 欄.字('100001'), email: 欄.字('a@example.jp'), verified: 欄.真 },
  '/groups/100001/members/m1': { name: 欄.字('山田 太郎') },
  ...追加,
});

const 依頼 = (体, 見出し = {}) =>
  new Request('https://chukei.example/kojin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', ...見出し },
    body: JSON.stringify(体),
  });
const 匿名 = { sub: 'anon-1', aud: 'kyudoscoremanager', firebase: { sign_in_provider: 'anonymous' } };
const いつも収まる = async () => true;

test('入れる：6 字の個人ID を逆引きして、所属の証を書き、memberId と名前を返す', async () => {
  証の控えを忘れる();
  const 雲 = 偽の雲(団体の文書({ '/groups/100001/member_lookup/K7MP3X': { memberId: 欄.字('m1') } }));
  const env = { FIREBASE_SA_KEYS: JSON.stringify({ kyudoscoremanager: await 偽のサービスアカウント() }) };
  const 結果 = await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), env, 匿名, {
    送る: 雲.送る,
    回数に収まるか: いつも収まる,
    今: Date.parse('2026-11-20T00:00:00Z'),
  });
  assert.deepStrictEqual(結果, { 状態: 200, 中身: { 結果: '入れた', memberId: 'm1', 名前: '山田 太郎' } });
  assert.strictEqual(雲.書いた.length, 1);
  assert.strictEqual(雲.書いた[0].道, '/member_claims/anon-1');
  const 証 = 雲.書いた[0].中身.fields;
  assert.deepStrictEqual(Object.keys(証).sort(), ['claimedAt', 'groupId', 'memberId', 'personalId']);
  assert.strictEqual(証.groupId.stringValue, '100001');
  assert.strictEqual(証.memberId.stringValue, 'm1');
  // 2 回目はアクセストークンを取り直さない（署名は 1 時間に 1 回）
  await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), env, { ...匿名, sub: 'anon-2' }, {
    送る: 雲.送る,
    回数に収まるか: いつも収まる,
  });
  assert.strictEqual(雲.トークンを取った(), 1);
});

test('入れない：見つからない・名簿にいない・期限切れの招待・確認の済んでいない団体・12/3 を過ぎた 4 桁', async () => {
  証の控えを忘れる();
  const 今 = Date.parse('2026-12-05T00:00:00Z');
  const 雲 = 偽の雲(
    団体の文書({
      '/groups/100001/member_lookup/GONEXX': { memberId: 欄.字('m9') },
      '/groups/100001/member_lookup/1234': { memberId: 欄.字('m1') },
      ['/groups/100001/member_lookup/' + 'a'.repeat(32)]: { memberId: 欄.字('m1'), 招待: 欄.真, expiresAt: 欄.時(今 - 1) },
      '/group_accounts/200002': { id: 欄.字('200002'), email: 欄.字('b@example.jp') },
      '/groups/200002/member_lookup/K7MP3X': { memberId: 欄.字('m1') },
    })
  );
  const env = { FIREBASE_SA_KEYS: JSON.stringify(await 偽のサービスアカウント()) };
  const 試す = (団体, 鍵) =>
    部員を確かめる(依頼({ 団体, 鍵 }), env, 匿名, { 送る: 雲.送る, 回数に収まるか: いつも収まる, 今 }).then((r) => r.中身.結果);
  assert.strictEqual(await 試す('100001', 'ZZZZZZ'), '見つからない');
  assert.strictEqual(await 試す('100001', 'GONEXX'), '見つからない', '名簿にいない人の逆引きで入れた');
  assert.strictEqual(await 試す('100001', 'a'.repeat(32)), '期限切れ');
  assert.strictEqual(await 試す('200002', 'K7MP3X'), '団体がまだ');
  assert.strictEqual(await 試す('100001', '1234'), '4桁は終わり');
  assert.strictEqual(await 試す('999999', 'K7MP3X'), '見つからない');
  assert.strictEqual(雲.書いた.length, 0, '入れないのに証を書いた');
});

test('入れてよいか：猶予のあいだは確認前の団体も通す。12/2 までは 4 桁も通す。期限内の招待は通す', () => {
  const 帳面 = { fields: {} };
  const 逆 = (鍵の欄 = {}) => ({ fields: { memberId: 欄.字('m1'), ...鍵の欄 } });
  assert.strictEqual(入れてよいか({ 鍵: 'K7MP3X', 帳面, 逆引き: 逆(), 今: 猶予の終わり - 1 }), '通す');
  assert.strictEqual(入れてよいか({ 鍵: 'K7MP3X', 帳面, 逆引き: 逆(), 今: 猶予の終わり }), '団体がまだ');
  const 済み = { fields: { verified: 欄.真 } };
  assert.strictEqual(入れてよいか({ 鍵: '1234', 帳面: 済み, 逆引き: 逆(), 今: 四桁の終わり - 1 }), '通す');
  assert.strictEqual(入れてよいか({ 鍵: '1234', 帳面: 済み, 逆引き: 逆(), 今: 四桁の終わり }), '4桁は終わり');
  assert.strictEqual(入れてよいか({ 鍵: 'b'.repeat(32), 帳面: 済み, 逆引き: 逆({ 招待: 欄.真, expiresAt: 欄.時(1e13) }), 今: 1 }), '通す');
  assert.strictEqual(入れてよいか({ 鍵: 'b'.repeat(32), 帳面: 済み, 逆引き: 逆({ 招待: 欄.真 }), 今: 1 }), '期限切れ', '期限の無い招待');
  assert.strictEqual(入れてよいか({ 鍵: 'b'.repeat(32), 帳面: 済み, 逆引き: 逆(), 今: 1 }), '見つからない', '招待でない長い鍵');
  // アプリが行を消す代わりに置く「消した」印の行は使えない
  assert.strictEqual(入れてよいか({ 鍵: 'K7MP3X', 帳面: 済み, 逆引き: 逆({ 消した: 欄.真 }), 今: 1 }), '見つからない', '消した印の行');
});

test('守り：鍵が無ければ 404（古い中継と同じ）・匿名でなければ 403・回数を越えたら 429・形が違えば 400', async () => {
  const env = { FIREBASE_SA_KEYS: JSON.stringify({ kyudoscoremanager: await 偽のサービスアカウント() }) };
  const 雲 = 偽の雲(団体の文書());
  const 道具 = { 送る: 雲.送る, 回数に収まるか: いつも収まる };
  assert.strictEqual((await 部員を確かめる(依頼({ 団体: '1', 鍵: 'K7MP3X' }), {}, 匿名, 道具)).状態, 404);
  assert.strictEqual(
    (await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), env, { ...匿名, firebase: { sign_in_provider: 'password' } }, 道具)).状態,
    403
  );
  assert.strictEqual((await 部員を確かめる(依頼({ 団体: '../x', 鍵: 'K7MP3X' }), env, 匿名, 道具)).状態, 400);
  // 通信元ごとの上限と団体ごとの上限
  const 数えた = [];
  const 通信元だけ越える = async (本人) => (数えた.push(本人.sub), !本人.sub.startsWith('通信元:'));
  const 越えた = await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), env, 匿名, { ...道具, 回数に収まるか: 通信元だけ越える });
  assert.strictEqual(越えた.状態, 429);
  assert.deepStrictEqual(数えた.sort(), ['団体:kyudoscoremanager:100001', '通信元:203.0.113.5']);
  assert.strictEqual(雲.送った.length, 0, '回数を越えたのに雲を読んだ');
  // App Check を強いているときは、印の無い端末を断る
  const 強いる = { ...env, APPCHECK_MODE: 'enforce' };
  assert.strictEqual((await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), 強いる, 匿名, { ...道具, 印の様子: 'none' })).状態, 401);
});

test('Firestore に届かないときは 503（入れたことにしない）。試した結果は数だけ残す', async () => {
  証の控えを忘れる();
  const 雲 = 偽の雲(団体の文書({ '/groups/100001/member_lookup/K7MP3X': '壊れた' }));
  const 残した = [];
  const env = {
    FIREBASE_SA_KEYS: JSON.stringify(await 偽のサービスアカウント()),
    KAIZEN_DB: { prepare: (sql) => ({ bind: (...v) => ({ run: async () => 残した.push({ sql, v }) }) }) },
  };
  const 結果 = await 部員を確かめる(依頼({ 団体: '100001', 鍵: 'K7MP3X' }), env, 匿名, { 送る: 雲.送る, 回数に収まるか: いつも収まる, 今: 7 });
  assert.strictEqual(結果.状態, 503);
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(残した.length, 1);
  assert.match(残した[0].sql, /INSERT INTO kojin_tries/);
  assert.deepStrictEqual(残した[0].v, [7, 'kyudoscoremanager', '届かない'], '人・通信元・団体を残している');
});

test('サービスアカウントを選ぶ：企画ごとの表・並び・1 つ。合わない企画は選ばない', async () => {
  const 本番 = await 偽のサービスアカウント('kyudoscoremanager');
  const 検証 = await 偽のサービスアカウント('kyudoscoremanager-stg');
  assert.strictEqual(サービスアカウントを選ぶ(JSON.stringify({ 'kyudoscoremanager-stg': 検証 }), 'kyudoscoremanager-stg').client_email, 検証.client_email);
  assert.strictEqual(サービスアカウントを選ぶ(JSON.stringify([本番, 検証]), 'kyudoscoremanager').client_email, 本番.client_email);
  assert.strictEqual(サービスアカウントを選ぶ(JSON.stringify(本番), 'kyudoscoremanager-stg'), null);
  assert.strictEqual(サービスアカウントを選ぶ('壊れた', 'kyudoscoremanager'), null);
  assert.strictEqual(サービスアカウントを選ぶ(undefined, 'kyudoscoremanager'), null);
});
