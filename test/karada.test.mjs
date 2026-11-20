/**
 * 中継しない体の見分け方の検査（2026-11-21・別の AI の点検の S3）。
 *
 *   node --test test/
 *
 * アプリが送る 3 つの形（写真の読み取り・出欠の読み取り・AI チャット）は通し、
 * アプリが使わない道具（Google 検索・コードの実行など）と cachedContent は断る。
 */
import test from 'node:test';
import assert from 'node:assert';
import { 中継しない体か } from '../src/index.mjs';

const 字 = (体) => JSON.stringify(体);

test('アプリが送る形は通す', () => {
  // 写真の読み取り（OCRRecordModal：generationConfig の responseMimeType と写真）
  const 写真 = {
    contents: [{ role: 'user', parts: [{ text: '読んでください' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }] }],
    generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  assert.strictEqual(中継しない体か(字(写真)), null);
  // 出欠の読み取り（AttendanceScreen：temperature）
  assert.strictEqual(中継しない体か(字({ contents: [{ parts: [{ text: 'x' }] }], generationConfig: { temperature: 0.1 } })), null);
  // AI チャット（AIChatBot：systemInstruction と functionDeclarations の道具。道具の返事も積む）
  const チャット = {
    contents: [
      { role: 'user', parts: [{ text: '"tools": と書いた質問' }] },
      { role: 'model', parts: [{ functionCall: { name: '的中率', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: '的中率', response: { tools: 'x' } } }] },
    ],
    systemInstruction: { parts: [{ text: '弓道部の記録の AI です' }] },
    tools: [{ functionDeclarations: [{ name: '的中率', description: '', parameters: { type: 'OBJECT', properties: {} } }] }],
  };
  assert.strictEqual(中継しない体か(字(チャット)), null);
});

test('アプリが使わない道具は断る（camelCase・snake_case のどちらも・混ぜても）', () => {
  for (const 道具 of [
    { googleSearch: {} },
    { google_search: {} },
    { googleSearchRetrieval: {} },
    { codeExecution: {} },
    { urlContext: {} },
    { function_declarations: [] },
    { functionDeclarations: [], googleSearch: {} },
  ]) {
    assert.ok(中継しない体か(字({ contents: [], tools: [道具] })), `${Object.keys(道具).join('+')} が通った`);
  }
  assert.ok(
    中継しない体か(字({ contents: [], tools: [{ functionDeclarations: [] }, { googleSearch: {} }] })),
    '2 つ目の道具を見ていない'
  );
  assert.ok(中継しない体か(字({ contents: [], tools: { googleSearch: {} } })), '並びでない道具が通った');
});

test('cachedContent は断る', () => {
  assert.ok(中継しない体か(字({ cachedContent: 'cachedContents/abc', contents: [] })));
  assert.ok(中継しない体か(字({ cached_content: 'cachedContents/abc', contents: [] })));
});

test('字にしていない体・読めない体は見ない（Gemini が断る）', () => {
  assert.strictEqual(中継しない体か(null), null);
  assert.strictEqual(中継しない体か('{"tools":[{"googleSearch"'), null);
  assert.strictEqual(中継しない体か('{"contents":[]}'), null);
});
