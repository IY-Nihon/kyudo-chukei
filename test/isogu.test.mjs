/**
 * 3.8・3.7-flash へ切り替えた AI チャットの考える量を絞る検査と、呼んだ記録の検査。
 *
 *   node --test test/*.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { 候補の模型たち, チャットの考えを絞る, チャットの考える量, 呼んだ記録を残す, 上流へ送る } from '../src/index.mjs';

const 文に = (体) => new TextDecoder().decode(体);
const 体に = (o) => new TextEncoder().encode(JSON.stringify(o));
const チャット = { contents: [{ role: 'user', parts: [{ text: 'こんにちは' }] }], systemInstruction: { role: 'system', parts: [{ text: '指示' }] }, tools: [] };
const 流し = (m) => `/v1beta/models/${m}:streamGenerateContent`;

test('3.8 の流し読みのチャットは、考える量が入り、ほかはそのまま読める', () => {
  const 直した = JSON.parse(文に(チャットの考えを絞る(体に(チャット), 'gemini-3.8-flash', 流し('gemini-3.8-flash'))));
  assert.deepStrictEqual(直した.generationConfig, { thinkingConfig: { thinkingBudget: チャットの考える量 } });
  assert.deepStrictEqual(直した.contents, チャット.contents);
  assert.deepStrictEqual(直した.systemInstruction, チャット.systemInstruction);
  const 設定つき = JSON.parse(文に(チャットの考えを絞る(体に({ ...チャット, generationConfig: { temperature: 1 } }), 'gemini-3.8-flash', 流し('gemini-3.8-flash'))));
  assert.deepStrictEqual(設定つき.generationConfig, { thinkingConfig: { thinkingBudget: チャットの考える量 }, temperature: 1 });
});

test('3.7・3.6・写真の読み取り（指示なし）・生成の道・自分で考える量を持つ依頼はそのまま', () => {
  const 体 = 体に(チャット);
  assert.strictEqual(チャットの考えを絞る(体, 'gemini-3.6-flash', 流し('gemini-3.6-flash')), 体);
  assert.strictEqual(チャットの考えを絞る(体, 'gemini-3.7-flash', 流し('gemini-3.7-flash')), 体);
  assert.strictEqual(チャットの考えを絞る(体, 'gemini-3.8-flash', '/v1beta/models/gemini-3.8-flash:generateContent'), 体);
  const 写真 = 体に({ contents: [{ parts: [{ text: '読んで' }] }] });
  assert.strictEqual(チャットの考えを絞る(写真, 'gemini-3.8-flash', 流し('gemini-3.8-flash')), 写真);
  const 自分で = 体に({ ...チャット, generationConfig: { thinkingConfig: { thinkingBudget: 8 } } });
  assert.strictEqual(チャットの考えを絞る(自分で, 'gemini-3.8-flash', 流し('gemini-3.8-flash')), 自分で);
});

test('上流へ送る：3.6 が上限で 3.8 へ移ると、3.8 へ送る体だけ考える量が絞られ、送った回数を返す', async () => {
  const 送った = [];
  const fetch = async (url, 頼み) => {
    送った.push({ url, 体: 頼み.body });
    if (url.includes('3.6')) return new Response('{"error":{"code":429}}', { status: 429 });
    return new Response('data: {"candidates":[]}\n\n', { status: 200 });
  };
  const 結果 = await 上流へ送る({
    候補: ['gemini-3.6-flash', 'gemini-3.8-flash'].map((模型) => ({ 模型, 道: 流し(模型) })),
    鍵たち: ['a', 'b'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    体: 体に(チャット),
    fetch,
    待つ: async () => {},
  });
  assert.strictEqual(結果.使った模型, 'gemini-3.8-flash');
  assert.strictEqual(結果.送った回数, 3);
  assert.ok(!文に(送った[0].体).includes('thinkingBudget'));
  assert.ok(文に(送った[2].体).includes('"thinkingBudget":' + チャットの考える量));
});

test('呼んだ記録：頼んだ模型・答えた模型・時間を 1 行で置く（人の情報は置かない）', async () => {
  let 置いた;
  const env = { KAIZEN_DB: { prepare: (sql) => ({ bind: (...v) => ({ run: async () => { 置いた = { sql, v }; } }) }) } };
  await 呼んだ記録を残す(env, { 企画: 'kyudoscoremanager', 道: 流し('gemini-3.6-flash'), 使った模型: 'gemini-3.8-flash', 状態: 200, 先頭まで: 1234, 送った回数: 8, 混んだ: 0 }, 5);
  assert.match(置いた.sql, /INSERT INTO chukei_calls/);
  assert.deepStrictEqual(置いた.v, [5, 'kyudoscoremanager', '流し読み', 'gemini-3.6-flash', 'gemini-3.8-flash', 200, 1234, 8, 0, 0]);
});

test('チャットは頼んだ模型に関わらず 3.8 から順に、写真の読み取りは頼んだ 3.6 から', () => {
  const 連鎖 = 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash';
  assert.deepStrictEqual(候補の模型たち(流し('gemini-3.6-flash'), 連鎖, true).map((c) => c.模型), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']);
  assert.deepStrictEqual(候補の模型たち(流し('gemini-3.6-flash'), 連鎖, false).map((c) => c.模型)[0], 'gemini-3.6-flash');
});

test('上流へ送る：先頭の 3.8 にも考える量が入る', async () => {
  const 送った = [];
  await 上流へ送る({
    候補: ['gemini-3.8-flash', 'gemini-3.7-flash'].map((模型) => ({ 模型, 道: 流し(模型) })),
    鍵たち: ['a'], 始めの鍵: 0, search: '', method: 'POST', 体: 体に(チャット),
    fetch: async (url, 頼み) => { 送った.push(文に(頼み.body)); return new Response('data: {}\n\n', { status: 200 }); },
    待つ: async () => {},
  });
  assert.ok(送った[0].includes('"thinkingBudget":' + チャットの考える量));
});
