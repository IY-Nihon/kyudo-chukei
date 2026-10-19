/**
 * 最初の答えが来ないとき、待ちの上限で打ち切って次の模型へ移る検査。
 *
 *   node --test test/*.mjs
 *
 * 2026-10-13：3.6 が混んで 3.8 に回り、その 3.8 が答えないまま 130〜150 秒たって Cloudflare に切られた（524）
 */
import test from 'node:test';
import assert from 'node:assert';
import { 上流へ送る } from '../src/index.mjs';

const 生成 = (m) => `/v1beta/models/${m}:generateContent`;
// signal で止められるまで答えない上流
const 黙る = (url, 頼み) =>
  new Promise((_, ng) => 頼み.signal && 頼み.signal.addEventListener('abort', () => ng(new Error('aborted'))));

test('答えない模型は上限で打ち切り、次の模型の答えを返す', async () => {
  const 送った = [];
  const 結果 = await 上流へ送る({
    候補: ['gemini-3.6-flash', 'gemini-3.8-flash'].map((模型) => ({ 模型, 道: 生成(模型) })),
    鍵たち: ['a'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    待ちの上限: 30,
    fetch: (url, 頼み) => {
      送った.push(url);
      return url.includes('3.6') ? 黙る(url, 頼み) : Promise.resolve(new Response('{}', { status: 200 }));
    },
    待つ: async () => {},
  });
  assert.strictEqual(結果.使った模型, 'gemini-3.8-flash');
  assert.strictEqual(結果.返事.status, 200);
  assert.strictEqual(結果.遅かった, 1);
  assert.strictEqual(送った.length, 2);
});

test('最後の模型は打ち切らない（締め切りまで待つ）', async () => {
  const 結果 = await 上流へ送る({
    候補: [{ 模型: 'gemini-3.5-flash', 道: 生成('gemini-3.5-flash') }],
    鍵たち: ['a'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    待ちの上限: 10,
    fetch: (url, 頼み) => {
      assert.ok(!頼み.signal, '最後の模型に打ち切りを付けない');
      return new Promise((ok) => setTimeout(() => ok(new Response('{}', { status: 200 })), 40));
    },
    待つ: async () => {},
  });
  assert.strictEqual(結果.返事.status, 200);
  assert.strictEqual(結果.遅かった, 0);
});

test('締め切りが近いと、次の模型があっても待ちを縮め、残りが無ければ最後の模型へ飛ぶ', async () => {
  let 時刻 = 0;
  const 送った = [];
  const 結果 = await 上流へ送る({
    候補: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash'].map((模型) => ({ 模型, 道: 生成(模型) })),
    鍵たち: ['a'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    全体の締め切り: 4000,
    今: () => 時刻,
    fetch: (url) => {
      送った.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    待つ: async () => {},
  });
  // 残り 4000 - 5000 < 0 なので 3.6・3.8 は飛ばし、最後の 3.5 だけ送る
  assert.deepStrictEqual(送った.map((u) => u.match(/gemini-[\d.]+-flash/)[0]), ['gemini-3.5-flash']);
  assert.strictEqual(結果.使った模型, 'gemini-3.5-flash');
});

test('打ち切った模型は、しばらく後ろへ回す（次の頼みでは最初から次の模型へ）', async () => {
  const { 枠切れを忘れる } = await import('../src/index.mjs');
  枠切れを忘れる();
  const 送った = [];
  const 注文 = () => ({
    候補: ['gemini-3.8-flash', 'gemini-3.6-flash'].map((模型) => ({ 模型, 道: 生成(模型) })),
    鍵たち: ['a'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    待ちの上限: 30,
    fetch: (url, 頼み) => {
      送った.push(url);
      return url.includes('3.8') ? 黙る(url, 頼み) : Promise.resolve(new Response('{}', { status: 200 }));
    },
    待つ: async () => {},
  });
  const 一回目 = await 上流へ送る(注文());
  assert.strictEqual(一回目.遅かった, 1);
  送った.length = 0;
  const 二回目 = await 上流へ送る(注文());
  assert.strictEqual(二回目.使った模型, 'gemini-3.6-flash');
  assert.strictEqual(二回目.遅かった, 0);
  assert.deepStrictEqual(送った.map((u) => u.includes('3.6')), [true], '3.8 を待たずに 3.6 へ');
  枠切れを忘れる();
});
