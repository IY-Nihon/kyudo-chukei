/**
 * 公開鍵の置き場と署名の確かめ（src/kagi.mjs）・App Check の印・中身の無い流れ。2026-11-04。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import { 鍵の置き場を作る, 署名を確かめる, 印を確かめる } from '../src/kagi.mjs';
import { 上流へ送る, 枠切れを忘れる } from '../src/index.mjs';

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function 鍵の組(kid) {
  const 組 = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', 組.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const 署名する = async (中身) => {
    const 本文 = b64({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + b64(中身);
    const 署名 = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', 組.privateKey, new TextEncoder().encode(本文));
    return 本文 + '.' + Buffer.from(署名).toString('base64url');
  };
  return { jwk, 署名する };
}

test('鍵の置き場：控えに無い番号での取り直しは 1 分に 1 回まで。取れなければ確かめない', async () => {
  const 甲 = await 鍵の組('a');
  let 取った = 0;
  const 送る = async () => (取った++, new Response(JSON.stringify({ keys: [甲.jwk] }), { status: 200, headers: { 'Cache-Control': 'max-age=3600' } }));
  const 鍵を選ぶ = 鍵の置き場を作る('https://x/jwks', { 送る });
  await 鍵を選ぶ('a', 1000);
  assert.strictEqual(取った, 1);
  // 偽の番号を何度送られても、1 分のうちは取り直さない
  for (let 回 = 0; 回 < 5; 回++) await assert.rejects(鍵を選ぶ('偽', 2000 + 回), /見つからない/);
  assert.strictEqual(取った, 1, '偽の番号のたびに取り直した');
  await assert.rejects(鍵を選ぶ('偽', 1000 + 61_000), /見つからない/);
  assert.strictEqual(取った, 2);
  // 取れない（500）ときは投げる
  const 壊れた = 鍵の置き場を作る('https://x/jwks', { 送る: async () => new Response('x', { status: 500 }) });
  await assert.rejects(壊れた('a'), /取れない/);
});

test('署名を確かめる：正しい署名・期限切れ・別の鍵の署名', async () => {
  const 甲 = await 鍵の組('a');
  const 乙 = await 鍵の組('a');
  const 鍵を選ぶ = 鍵の置き場を作る('https://x', { 送る: async () => new Response(JSON.stringify({ keys: [甲.jwk] }), { status: 200 }) });
  const 今 = Date.now();
  const 秒 = Math.floor(今 / 1000);
  const 良い = await 甲.署名する({ sub: 'u', exp: 秒 + 60, iat: 秒 });
  assert.strictEqual((await 署名を確かめる(良い, 鍵を選ぶ, 今)).中身.sub, 'u');
  await assert.rejects(署名を確かめる(await 甲.署名する({ exp: 秒 - 1 }), 鍵を選ぶ, 今), /期限切れ/);
  await assert.rejects(署名を確かめる(await 乙.署名する({ exp: 秒 + 60 }), 鍵を選ぶ, 今), /署名が合わない/);
  await assert.rejects(署名を確かめる('a.b', 鍵を選ぶ, 今), /形が違う/);
});

test('App Check の印：発行元・宛先（その企画）・署名を見る。付いていなければ none', async () => {
  const 甲 = await 鍵の組('ac');
  const 鍵を選ぶ = 鍵の置き場を作る('https://x', { 送る: async () => new Response(JSON.stringify({ keys: [甲.jwk] }), { status: 200 }) });
  const 秒 = Math.floor(Date.now() / 1000);
  const 印 = (中身) => 甲.署名する({ exp: 秒 + 600, iat: 秒, sub: '1:2:web:3', ...中身 });
  const 本物 = await 印({ iss: 'https://firebaseappcheck.googleapis.com/123456', aud: ['projects/123456', 'projects/kyudoscoremanager'] });
  assert.strictEqual(await 印を確かめる(本物, 'kyudoscoremanager', { 鍵を選ぶ }), 'ok');
  assert.strictEqual(await 印を確かめる(本物, 'kyudoscoremanager-stg', { 鍵を選ぶ }), 'bad', 'ほかの企画の印を通した');
  const 発行元違い = await 印({ iss: 'https://evil.example/1', aud: ['projects/kyudoscoremanager'] });
  assert.strictEqual(await 印を確かめる(発行元違い, 'kyudoscoremanager', { 鍵を選ぶ }), 'bad');
  assert.strictEqual(await 印を確かめる(null, 'kyudoscoremanager', { 鍵を選ぶ }), 'none');
  assert.strictEqual(await 印を確かめる('壊れた', 'kyudoscoremanager', { 鍵を選ぶ }), 'bad');
});

test('流し読み：中身の無い 200 は、最後の模型でなければ次の模型へ（最後の模型ならそのまま返す）', async () => {
  枠切れを忘れる();
  const 道 = (模型) => `/v1beta/models/${模型}:streamGenerateContent`;
  const 頼んだ = [];
  const 送り = await 上流へ送る({
    候補: ['gemini-3.8-flash', 'gemini-3.6-flash'].map((模型) => ({ 模型, 道: 道(模型) })),
    鍵たち: ['k'],
    始めの鍵: 0,
    search: '?alt=sse',
    method: 'POST',
    体: new TextEncoder().encode('{}'),
    fetch: async (url) => {
      頼んだ.push(url);
      return url.includes('3.8') ? new Response(new Uint8Array(0), { status: 200 }) : new Response('data: {"a":1}\n\n', { status: 200 });
    },
    待つ: async () => {},
  });
  assert.strictEqual(送り.使った模型, 'gemini-3.6-flash');
  assert.strictEqual(頼んだ.length, 2);
  assert.strictEqual(await 送り.返事.text(), 'data: {"a":1}\n\n');
  // 最後の模型が空なら、そのまま返す（アプリが 1 回送り直す）
  const 最後 = await 上流へ送る({
    候補: [{ 模型: 'gemini-3.6-flash', 道: 道('gemini-3.6-flash') }],
    鍵たち: ['k'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    体: new TextEncoder().encode('{}'),
    fetch: async () => new Response(new Uint8Array(0), { status: 200 }),
    待つ: async () => {},
  });
  assert.strictEqual(最後.返事.status, 200);
  assert.strictEqual(最後.送った回数, 1);
});

test('鍵の置き場：知らない番号で取り直すときは Cloudflare の控えを通さない（鍵が替わった直後に古い一覧を読まない）', async () => {
  const 甲 = await 鍵の組('a');
  const 乙 = await 鍵の組('b');
  const 頼み = [];
  let 今の鍵 = [甲.jwk];
  const 送る = async (_, 注文) => (頼み.push(注文), new Response(JSON.stringify({ keys: 今の鍵 }), { status: 200 }));
  const 鍵を選ぶ = 鍵の置き場を作る('https://x/jwks', { 送る });
  await 鍵を選ぶ('a', 1000);
  今の鍵 = [甲.jwk, 乙.jwk];
  await 鍵を選ぶ('b', 1000 + 61_000);
  assert.strictEqual(頼み[0].cf.cacheTtl, 3600, 'ふだんの取得は控えを使う');
  assert.strictEqual(頼み[1].cf.cacheTtl, 0, '取り直しで控えを使った');
});

test('鍵の置き場：期限が切れて取り直せないときは前の鍵で確かめ続け、取り直しは 1 分に 1 回まで', async () => {
  const 甲 = await 鍵の組('a');
  let 取った = 0;
  let 壊れている = false;
  const 送る = async () => (
    取った++,
    壊れている
      ? new Response('x', { status: 500 })
      : new Response(JSON.stringify({ keys: [甲.jwk] }), { status: 200, headers: { 'Cache-Control': 'max-age=60' } })
  );
  const 鍵を選ぶ = 鍵の置き場を作る('https://x/jwks', { 送る });
  await 鍵を選ぶ('a', 0);
  壊れている = true;
  // 期限（60 秒）が過ぎた。取り直しに失敗しても、前の鍵で通す
  assert.ok(await 鍵を選ぶ('a', 70_000));
  assert.strictEqual(取った, 2);
  // 失敗のあと 1 分のうちは取りに行かない
  for (let 回 = 0; 回 < 5; 回++) assert.ok(await 鍵を選ぶ('a', 71_000 + 回));
  assert.strictEqual(取った, 2, '失敗のあと呼ぶたびに取りに行った');
  // 1 分たったらまた取りに行き、直っていれば新しい控えになる
  壊れている = false;
  assert.ok(await 鍵を選ぶ('a', 131_000));
  assert.strictEqual(取った, 3);
});

test('印を強いるか：enforce のときだけ・外す企画は強いない', async () => {
  const { 印を強いるか } = await import('../src/kagi.mjs');
  assert.strictEqual(印を強いるか({ APPCHECK_MODE: 'log' }, 'kyudoscoremanager'), false);
  assert.strictEqual(印を強いるか({}, 'kyudoscoremanager'), false);
  const env = { APPCHECK_MODE: 'enforce', APPCHECK_SKIP_PROJECTS: 'kyudoscoremanager-stg' };
  assert.strictEqual(印を強いるか(env, 'kyudoscoremanager'), true);
  assert.strictEqual(印を強いるか(env, 'kyudoscoremanager-stg'), false);
});
