/**
 * 道具（function calling）の返事の role の直し方の検査。
 *
 *   node --test test/
 *
 * 以前は体の文字列を正規表現で置き換えていた。文字列の中に同じ字があっても
 * 書き換えてしまうので、JSON として読んで contents[].role だけを直す形にした。
 */
import test from 'node:test';
import assert from 'node:assert';
import { 道具の返事のroleを直す } from '../src/index.mjs';

test('contents[].role の "function" だけを "user" にする', () => {
  const 体 = {
    contents: [
      { role: 'user', parts: [{ text: '"role": "function" と書いてある文' }] },
      { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'x', response: { role: 'function' } } }] },
    ],
  };
  const 出 = JSON.parse(道具の返事のroleを直す(JSON.stringify(体)));
  assert.deepStrictEqual(
    出.contents.map((c) => c.role),
    ['user', 'model', 'user']
  );
  assert.strictEqual(出.contents[0].parts[0].text, '"role": "function" と書いてある文', '文字列の中を触った');
  assert.deepStrictEqual(出.contents[2].parts[0].functionResponse.response, { role: 'function' }, '返事の中身を触った');
});

test('直すところが無い・読めない・形が違うときは null（体はそのまま送る）', () => {
  assert.strictEqual(道具の返事のroleを直す(JSON.stringify({ contents: [{ role: 'user', parts: [] }] })), null);
  assert.strictEqual(道具の返事のroleを直す('{"role":"function"'), null);
  assert.strictEqual(道具の返事のroleを直す('{"contents":[]}'), null);
  assert.strictEqual(道具の返事のroleを直す('{"role":"function"}'), null, 'contents が無い');
});
