/**
 * アプリの改善のための保存（src/hozon.mjs）の検査。
 *
 *   node --test test/*.mjs
 *
 * D1 と KV は偽物で代える（使う文だけをまねる）。
 */
import test from 'node:test';
import assert from 'node:assert';
import { 保存を受ける, 古い保存を消す, 保存の日数, 写真の上限 } from '../src/hozon.mjs';

function 偽の置き場() {
  const 行たち = new Map();
  const 写真 = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async run() {
              if (sql.startsWith('INSERT')) {
                if (行たち.has(a[0])) throw new Error('UNIQUE constraint failed: kaizen_logs.id');
                行たち.set(a[0], { id: a[0], created_at: a[1], kind: a[2], project: a[3], uid: a[4], group_id: a[5], content: a[6], photos: 0 });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE')) {
                const 行 = 行たち.get(a[0]);
                if (行) 行.photos++;
                return { meta: { changes: 行 ? 1 : 0 } };
              }
              if (sql.startsWith('DELETE')) {
                let 数 = 0;
                for (const [id, 行] of 行たち) if (行.created_at < a[0]) (行たち.delete(id), 数++);
                return { meta: { changes: 数 } };
              }
              throw new Error('知らない文: ' + sql);
            },
            async first() {
              if (sql.startsWith('SELECT')) return 行たち.get(a[0]) || null;
              throw new Error('知らない文: ' + sql);
            },
          };
        },
      };
    },
  };
  const kv = {
    async put(鍵, 体, 選び) {
      写真.set(鍵, { 体, 選び });
    },
  };
  return { env: { KAIZEN_DB: db, KAIZEN_PHOTOS: kv, HOZON_PROJECTS: 'kyudoscoremanager,kyudoscoremanager-stg' }, 行たち, 写真 };
}

const 本人 = { sub: 'uid-1', aud: 'kyudoscoremanager-stg' };
const id = '0b9f3c2a-1d4e-4f5a-8b6c-7d8e9f0a1b2c';
const 送る = (置き場, 道, init, 誰 = 本人, 今) =>
  保存を受ける(new Request('https://x' + 道, init), new URL('https://x' + 道), 置き場.env, 誰, 今);
const 文を送る = (置き場, 中身, 誰, 今) =>
  送る(置き場, '/hozon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(中身) }, 誰, 今);
const 写真を送る = (置き場, 道, 体, 型 = 'image/jpeg', 誰) =>
  送る(置き場, 道, { method: 'PUT', headers: { 'Content-Type': 型, 'Content-Length': String(体.length) }, body: 体 }, 誰);

test('文字の記録を置く。企画・人・団体も控える。同じ id は 409', async () => {
  const 置き場 = 偽の置き場();
  const 返り = await 文を送る(置き場, { id, 種類: 'チャット', 中身: { 質問: '的中率は？', 答え: '75%', 団体: '100001' } }, 本人, 1000);
  assert.strictEqual(返り.状態, 200);
  const 行 = 置き場.行たち.get(id);
  assert.strictEqual(行.kind, 'チャット');
  assert.strictEqual(行.project, 'kyudoscoremanager-stg');
  assert.strictEqual(行.uid, 'uid-1');
  assert.strictEqual(行.group_id, '100001');
  assert.deepStrictEqual(JSON.parse(行.content), { 質問: '的中率は？', 答え: '75%', 団体: '100001' });
  assert.strictEqual((await 文を送る(置き場, { id, 種類: 'チャット', 中身: {} })).状態, 409);
});

test('形の違う依頼は断る（id・種類・JSON・大きさ）', async () => {
  const 置き場 = 偽の置き場();
  assert.strictEqual((await 文を送る(置き場, { id: 'abc', 種類: 'チャット', 中身: {} })).状態, 400);
  assert.strictEqual((await 文を送る(置き場, { id, 種類: '何か', 中身: {} })).状態, 400);
  assert.strictEqual((await 送る(置き場, '/hozon', { method: 'POST', body: '{壊れた' })).状態, 400);
  assert.strictEqual((await 文を送る(置き場, { id, 種類: 'チャット', 中身: 'x'.repeat(300 * 1024) })).状態, 413);
});

test('置き場が無ければ 503（アプリは黙って捨てる）', async () => {
  const 返り = await 保存を受ける(new Request('https://x/hozon', { method: 'POST', body: '{}' }), new URL('https://x/hozon'), { HOZON_PROJECTS: 本人.aud }, 本人);
  assert.strictEqual(返り.状態, 503);
});

test('写真は同じ人が書いた記録にだけ付く。1 年の期限を付けて KV に置く。型と大きさを見る', async () => {
  const 置き場 = 偽の置き場();
  await 文を送る(置き場, { id, 種類: '写真読み取り', 中身: {} });
  const 体 = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  assert.strictEqual((await 写真を送る(置き場, `/hozon/photo/${id}/0`, 体)).状態, 200);
  const 置いた = 置き場.写真.get(`photo/${id}/0`);
  assert.ok(置いた, 'KV に置いていない');
  assert.strictEqual(置いた.選び.expirationTtl, 保存の日数 * 86400);
  assert.strictEqual(置き場.行たち.get(id).photos, 1);
  // ほかの人の記録には付けられない
  assert.strictEqual((await 写真を送る(置き場, `/hozon/photo/${id}/1`, 体, 'image/jpeg', { sub: 'uid-2', aud: 'kyudoscoremanager-stg' })).状態, 404);
  // 無い記録にも付けられない
  assert.strictEqual((await 写真を送る(置き場, '/hozon/photo/11111111-2222-4333-8444-555555555555/0', 体)).状態, 404);
  // 写真と PDF のほかは断る
  assert.strictEqual((await 写真を送る(置き場, `/hozon/photo/${id}/1`, 体, 'text/html')).状態, 415);
  // 大きすぎる
  const 返り = await 送る(置き場, `/hozon/photo/${id}/1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(写真の上限 + 1) },
    body: 体,
  });
  assert.strictEqual(返り.状態, 413);
});

test('1 年を過ぎた文字の記録を消す', async () => {
  const 置き場 = 偽の置き場();
  const 今 = Date.UTC(2027, 8, 26);
  await 文を送る(置き場, { id, 種類: 'チャット', 中身: {} }, 本人, 今 - 保存の日数 * 86400000 - 1);
  await 文を送る(置き場, { id: '0b9f3c2a-1d4e-4f5a-8b6c-7d8e9f0a1b2d', 種類: 'チャット', 中身: {} }, 本人, 今 - 1000);
  assert.strictEqual(await 古い保存を消す(置き場.env, 今), 1);
  assert.deepStrictEqual([...置き場.行たち.keys()], ['0b9f3c2a-1d4e-4f5a-8b6c-7d8e9f0a1b2d']);
});

test('置く企画（既定は本番）でない証で来たものは、受けたと答えて置かない', async () => {
  const 置き場 = 偽の置き場();
  delete 置き場.env.HOZON_PROJECTS; // 既定は kyudoscoremanager だけ
  const 返り = await 文を送る(置き場, { id, 種類: 'チャット', 中身: {} }, { sub: 'u', aud: 'kyudoscoremanager-stg' });
  assert.strictEqual(返り.状態, 202);
  assert.strictEqual(置き場.行たち.size, 0);
  assert.strictEqual((await 文を送る(置き場, { id, 種類: 'チャット', 中身: {} }, { sub: 'u', aud: 'kyudoscoremanager' })).状態, 200);
});
