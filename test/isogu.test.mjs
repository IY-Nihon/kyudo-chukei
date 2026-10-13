/**
 * 3.8-flash へ切り替えた AI チャットに「10秒以内に回答してください。」を足す検査と、呼んだ記録の検査。
 *
 *   node --test test/*.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { 急ぐ一言を足す, 急ぐ一言, 呼んだ記録を残す, 上流へ送る } from '../src/index.mjs';

const 文に = (体) => new TextDecoder().decode(体);
const 体に = (o) => new TextEncoder().encode(JSON.stringify(o));
const チャット = { contents: [{ role: 'user', parts: [{ text: 'こんにちは' }] }], systemInstruction: { role: 'system', parts: [{ text: '指示' }] }, tools: [] };
const 流し = (m) => `/v1beta/models/${m}:streamGenerateContent`;

test('3.8 の流し読みのチャットは、指示の先頭に急ぐ一言が入り、JSON のまま読める', () => {
  const 直した = JSON.parse(文に(急ぐ一言を足す(体に(チャット), 'gemini-3.8-flash', 流し('gemini-3.8-flash'))));
  assert.deepStrictEqual(直した.systemInstruction.parts.map((p) => p.text), [急ぐ一言, '指示']);
  assert.deepStrictEqual(直した.contents, チャット.contents);
});

test('ほかの模型・写真の読み取り（指示なし）・生成の道には足さない', () => {
  const 体 = 体に(チャット);
  assert.strictEqual(急ぐ一言を足す(体, 'gemini-3.7-flash', 流し('gemini-3.7-flash')), 体);
  assert.strictEqual(急ぐ一言を足す(体, 'gemini-3.8-flash', '/v1beta/models/gemini-3.8-flash:generateContent'), 体);
  const 写真 = 体に({ contents: [{ parts: [{ text: '読んで' }] }] });
  assert.strictEqual(急ぐ一言を足す(写真, 'gemini-3.8-flash', 流し('gemini-3.8-flash')), 写真);
});

test('上流へ送る：3.6 が上限で 3.8 へ移ると、3.8 へ送る体に急ぐ一言が入り、送った回数を返す', async () => {
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
  assert.ok(!文に(送った[0].体).includes(急ぐ一言));
  assert.ok(文に(送った[2].体).includes(急ぐ一言));
});

test('呼んだ記録：頼んだ模型・答えた模型・時間を 1 行で置く（人の情報は置かない）', async () => {
  let 置いた;
  const env = { KAIZEN_DB: { prepare: (sql) => ({ bind: (...v) => ({ run: async () => { 置いた = { sql, v }; } }) }) } };
  await 呼んだ記録を残す(env, { 企画: 'kyudoscoremanager', 道: 流し('gemini-3.6-flash'), 使った模型: 'gemini-3.8-flash', 状態: 200, 先頭まで: 1234, 送った回数: 8, 混んだ: 0 }, 5);
  assert.match(置いた.sql, /INSERT INTO chukei_calls/);
  assert.deepStrictEqual(置いた.v, [5, 'kyudoscoremanager', '流し読み', 'gemini-3.6-flash', 'gemini-3.8-flash', 200, 1234, 8, 0]);
});
