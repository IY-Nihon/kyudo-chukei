/**
 * 模型の切り替えの検査。
 *
 *   node --test test/*.mjs
 *
 * 2026-09-29：使う模型（gemini-3.6-flash）が 4 時間以上 503（混んでいる）のまま返り、
 * 写真の読み取りが全部止まった。無料枠の上限（429）も模型ごとなので、別の模型なら通る。
 * 新しい順（3.8 → 3.7 → 3.6 → 3.5 → 2.5）に、次の模型で同じ体をもう一度送る。
 */
import test from 'node:test';
import assert from 'node:assert';
import { 候補の模型たち, 上流へ送る } from '../src/index.mjs';

const 連鎖 = 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash';
const 生成の道 = (m) => `/v1beta/models/${m}:generateContent`;

test('候補：要求した模型が先頭、連鎖の残りが新しい順に続く', () => {
  const 候補 = 候補の模型たち(生成の道('gemini-3.6-flash'), 連鎖);
  assert.deepStrictEqual(
    候補.map((c) => c.模型),
    ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']
  );
  assert.strictEqual(候補[1].道, 生成の道('gemini-3.8-flash'));
  const 先頭が最新 = 候補の模型たち(生成の道('gemini-3.8-flash'), 連鎖).map((c) => c.模型);
  assert.deepStrictEqual(先頭が最新, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']);
});

test('候補：流し読みの道も同じ形で入れ替える。連鎖に無い模型・一覧・連鎖の指定なしは 1 つだけ', () => {
  const 流し = '/v1beta/models/gemini-3.6-flash:streamGenerateContent';
  assert.strictEqual(候補の模型たち(流し, 連鎖)[1].道, '/v1beta/models/gemini-3.8-flash:streamGenerateContent');
  assert.strictEqual(候補の模型たち(生成の道('gemini-1.5-flash'), 連鎖).length, 1);
  assert.strictEqual(候補の模型たち('/v1beta/models', 連鎖).length, 1);
  assert.strictEqual(候補の模型たち(生成の道('gemini-3.6-flash'), undefined).length, 1);
});

const 返事 = (status, 文 = '') => ({ status, clone: () => ({ text: async () => 文 }), body: null });
const 注文 = (呼び出し, 応答, 鍵の数 = 3) => ({
  候補: 候補の模型たち(生成の道('gemini-3.6-flash'), 連鎖),
  鍵たち: Array.from({ length: 鍵の数 }, (_, i) => 'K' + i),
  始めの鍵: 0,
  search: '',
  method: 'POST',
  体: new TextEncoder().encode('{}'),
  種: 'application/json',
  fetch: async (url, init) => {
    const 模型 = url.match(/models\/([^:]+):/)[1];
    呼び出し.push({ 模型, 鍵: init.headers.get('x-goog-api-key') });
    return 応答(模型, 呼び出し.length);
  },
  待つ: async () => {},
});

test('最初の模型が通れば、そのまま返す（切り替えない）', async () => {
  const 呼 = [];
  const 結果 = await 上流へ送る(注文(呼, () => 返事(200)));
  assert.strictEqual(結果.返事.status, 200);
  assert.strictEqual(結果.使った模型, 'gemini-3.6-flash');
  assert.strictEqual(呼.length, 1);
});

test('使う模型が 503 なら、待たずに次の模型（3.8）へ移り、通った返事を返す', async () => {
  const 呼 = [];
  const 待ち = [];
  const 結果 = await 上流へ送る({ ...注文(呼, (模型) => (模型 === 'gemini-3.6-flash' ? 返事(503) : 返事(200))), 待つ: async (ms) => 待ち.push(ms) });
  assert.strictEqual(結果.返事.status, 200);
  assert.strictEqual(結果.使った模型, 'gemini-3.8-flash');
  assert.deepStrictEqual(呼.map((c) => c.模型), ['gemini-3.6-flash', 'gemini-3.8-flash']);
  assert.deepStrictEqual(待ち, [], '次の模型があるうちは待たない');
});

test('3.8 も 3.7 も混んでいれば、3.6 が空くまで順に試して、最後まで通らなければ最後の模型を待って送り直す', async () => {
  const 呼 = [];
  const 待ち = [];
  const 結果 = await 上流へ送る({ ...注文(呼, () => 返事(503)), 待つ: async (ms) => 待ち.push(ms) });
  assert.strictEqual(結果.返事.status, 503);
  assert.deepStrictEqual(
    呼.map((c) => c.模型),
    ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash']
  );
  assert.strictEqual(待ち.length, 3, '最後の模型だけ、混みの待ち（3 回）');
});

test('429（上限）は、まず鍵を替え、どの鍵も上限ならその模型はあきらめて次の模型へ', async () => {
  const 呼 = [];
  const 結果 = await 上流へ送る(注文(呼, (模型) => (模型 === 'gemini-3.6-flash' ? 返事(429) : 返事(200)), 3));
  assert.strictEqual(結果.返事.status, 200);
  assert.deepStrictEqual(呼.map((c) => c.模型 + ':' + c.鍵), ['gemini-3.6-flash:K0', 'gemini-3.6-flash:K1', 'gemini-3.6-flash:K2', 'gemini-3.8-flash:K0']);
});

test('404（模型が無い）は次の模型へ。体がおかしい 400 は送り直さない', async () => {
  const 呼 = [];
  const 結果 = await 上流へ送る(注文(呼, (模型) => (模型 === 'gemini-3.6-flash' ? 返事(404) : 返事(200))));
  assert.strictEqual(結果.使った模型, 'gemini-3.8-flash');
  const 呼2 = [];
  const 結果2 = await 上流へ送る(注文(呼2, () => 返事(400, '{"error":{"message":"Invalid JSON payload"}}')));
  assert.strictEqual(結果2.返事.status, 400);
  assert.strictEqual(呼2.length, 1);
});

test('つながらないときは、つながらないと返す', async () => {
  const 結果 = await 上流へ送る({ ...注文([], () => 返事(200)), fetch: async () => { throw new Error('network'); } });
  assert.strictEqual(結果.つながらない, true);
});
