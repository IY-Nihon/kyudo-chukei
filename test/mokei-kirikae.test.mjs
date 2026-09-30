/**
 * 模型の切り替えの検査。
 *
 *   node --test test/*.mjs
 *
 * 2026-09-29：使う模型（gemini-3.6-flash）が 4 時間以上 503（混んでいる）のまま返り、
 * 写真の読み取りが全部止まった。無料枠の上限（429）も模型ごとなので、別の模型なら通る。
 * 新しい順（3.8 → 3.7 → 3.6 → 3.5 → 2.5）に、次の模型で同じ体をもう一度送る。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import { 候補の模型たち, 上流へ送る, 枠切れを忘れる } from '../src/index.mjs';

beforeEach(() => 枠切れを忘れる());

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

import { 考えない体 } from '../src/index.mjs';

test('切り替え先の写真の読み取りは考える量を 0 に。流し読み・自分で指定した依頼・JSON でない体はそのまま', () => {
  const 道 = '/v1beta/models/gemini-3.5-flash:generateContent';
  const 体 = (o) => new TextEncoder().encode(JSON.stringify(o));
  const 読む = (b) => JSON.parse(new TextDecoder().decode(b));
  const 直した = 読む(考えない体(体({ contents: [], generationConfig: { responseMimeType: 'application/json' } }), 道));
  assert.deepStrictEqual(直した.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.strictEqual(直した.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(読む(考えない体(体({ contents: [] }), 道)).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  const 自分で = 体({ generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } });
  assert.strictEqual(考えない体(自分で, 道), 自分で);
  // 流し読み：AI チャット（道具・system 指示つき、JSON 出力でない）はそのまま。写真の読み取り（JSON 出力・道具なし）は考えない
  const 流し道 = '/v1beta/models/gemini-3.8-flash:streamGenerateContent';
  const チャット = 体({ contents: [], tools: [{ functionDeclarations: [] }], systemInstruction: { parts: [] } });
  assert.strictEqual(考えない体(チャット, 流し道), チャット);
  const 文だけ = 体({ contents: [] });
  assert.strictEqual(考えない体(文だけ, 流し道), 文だけ, 'JSON 出力でない流し読みはそのまま');
  const 読み取り = 体({ contents: [], generationConfig: { responseMimeType: 'application/json' } });
  assert.deepStrictEqual(読む(考えない体(読み取り, 流し道)).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  const 変な = new TextEncoder().encode('not json');
  assert.strictEqual(考えない体(変な, 道), 変な);
  assert.strictEqual(考えない体(undefined, 道), undefined);
});

test('先頭以外の模型に送るときだけ、体を考えない形に直して送る', async () => {
  const 体たち = [];
  const 結果 = await 上流へ送る({
    候補: 候補の模型たち('/v1beta/models/gemini-3.6-flash:generateContent', 'gemini-3.6-flash,gemini-3.5-flash'),
    鍵たち: ['K0'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    体: new TextEncoder().encode('{"contents":[]}'),
    種: 'application/json',
    fetch: async (url, init) => {
      体たち.push(new TextDecoder().decode(init.body));
      return url.includes('gemini-3.6-flash') ? { status: 503, clone: () => ({ text: async () => '' }), body: null } : { status: 200, clone: () => ({ text: async () => '' }), body: null };
    },
    待つ: async () => {},
  });
  assert.strictEqual(結果.使った模型, 'gemini-3.5-flash');
  assert.ok(!体たち[0].includes('thinkingBudget'), '先頭の模型には元の体');
  assert.ok(体たち[1].includes('"thinkingBudget":0'), '切り替え先には考えない体');
});

import { 流れの先頭を見る, 送り直す訳 } from '../src/index.mjs';

const 流しの道 = '/v1beta/models/gemini-3.6-flash:streamGenerateContent';
const 流れ = (...塊) => new ReadableStream({ start(c) { for (const x of 塊) c.enqueue(new TextEncoder().encode(x)); c.close(); } });

test('流し読み：200 でも体がエラー JSON なら、そのエラーの code を状態にして返す（503 は混みとして切り替えられる）', async () => {
  const 返事 = await 流れの先頭を見る(new Response(流れ('{\n  "error": {\n    "code": 503,\n    "message": "high demand"\n  }\n}\n'), { status: 200 }), 流しの道);
  assert.strictEqual(返事.status, 503);
  assert.strictEqual(await 送り直す訳({ status: 返事.status, clone: () => 返事.clone() }), '混み');
  const 上限 = await 流れの先頭を見る(new Response(流れ('{"error":{"code":429,"message":"quota"}}'), { status: 200 }), 流しの道);
  assert.strictEqual(上限.status, 429);
});

test('流し読み：普通の流れ（data: で始まる）は、読んだ塊を頭に戻してそのまま返す', async () => {
  const 返事 = await 流れの先頭を見る(new Response(流れ('data: {"a":1}\r\n\r\n', 'data: {"a":2}\r\n\r\n'), { status: 200 }), 流しの道);
  assert.strictEqual(返事.status, 200);
  assert.strictEqual(await 返事.text(), 'data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n');
});

test('流し読みでない道・体の無い返事・200 でない返事は触らない', async () => {
  const 生成 = new Response('{"error":{"code":503}}', { status: 200 });
  assert.strictEqual(await 流れの先頭を見る(生成, '/v1beta/models/gemini-3.6-flash:generateContent'), 生成);
  const 五百 = new Response('x', { status: 503 });
  assert.strictEqual(await 流れの先頭を見る(五百, 流しの道), 五百);
  assert.strictEqual(await 流れの先頭を見る(null, 流しの道), null);
});

test('流し読みで 200 の中身が 503 なら、次の模型へ切り替える', async () => {
  const 呼 = [];
  const 結果 = await 上流へ送る({
    候補: 候補の模型たち('/v1beta/models/gemini-3.6-flash:streamGenerateContent', 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash'),
    鍵たち: ['K0'],
    始めの鍵: 0,
    search: '?alt=sse',
    method: 'POST',
    体: new TextEncoder().encode('{"contents":[]}'),
    fetch: async (url) => {
      const 模型 = url.match(/models\/([^:]+):/)[1];
      呼.push(模型);
      return 模型 === 'gemini-3.7-flash'
        ? new Response(流れ('data: {"ok":1}\r\n\r\n'), { status: 200 })
        : new Response(流れ('{"error":{"code":503,"message":"high demand"}}'), { status: 200 });
    },
    待つ: async () => {},
  });
  assert.strictEqual(結果.使った模型, 'gemini-3.7-flash');
  assert.deepStrictEqual(呼, ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash']);
  assert.strictEqual(結果.返事.status, 200);
});

import { 見出しを整える } from '../src/index.mjs';

test('読み直した流れの見出しから、圧縮・長さ・転送の指定を外す（付けたままだとブラウザが受け取れない）', async () => {
  const 頭 = 見出しを整える(new Headers({ 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Content-Length': '123', 'Transfer-Encoding': 'chunked' }));
  assert.strictEqual(頭.get('content-type'), 'text/event-stream');
  assert.strictEqual(頭.get('content-encoding'), null);
  assert.strictEqual(頭.get('content-length'), null);
  assert.strictEqual(頭.get('transfer-encoding'), null);
  const 返事 = await 流れの先頭を見る(new Response(流れ('data: {"a":1}\r\n\r\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '999' } }), 流しの道);
  assert.strictEqual(返事.headers.get('content-length'), null);
  assert.strictEqual(返事.headers.get('content-type'), 'text/event-stream');
});

test('写真つきの大きな体（1MB 超）でも、考えない体は軽い（JSON を読み直さない。CPU の上限に掛からない）', () => {
  const 大 = new TextEncoder().encode(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'x"tools":y' }, { inlineData: { mimeType: 'image/jpeg', data: 'A'.repeat(1_400_000) } }] }], generationConfig: { responseMimeType: 'application/json' } }));
  const t0 = performance.now();
  let 結果;
  for (let i = 0; i < 20; i++) 結果 = 考えない体(大, '/v1beta/models/gemini-3.5-flash:streamGenerateContent');
  const 平均 = (performance.now() - t0) / 20;
  assert.ok(平均 < 8, `1 回 ${平均.toFixed(1)}ms は重い`);
  const 直した = JSON.parse(new TextDecoder().decode(結果));
  assert.deepStrictEqual(直した.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.strictEqual(直した.generationConfig.responseMimeType, 'application/json');
  // generationConfig が空・無い体も、壊れない JSON のまま
  for (const 元 of ['{"contents":[],"generationConfig":{}}', '{"contents":[]}']) {
    const j = JSON.parse(new TextDecoder().decode(考えない体(new TextEncoder().encode(元), '/v1beta/models/gemini-3.5-flash:generateContent')));
    assert.deepStrictEqual(j.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  }
});

test('全部の鍵が 429 の模型は、控えの間は飛ばして次の模型へ移る（毎回、鍵を全部なめない）', async () => {
  const 呼 = [];
  const 送る = async (url) => {
    const 模型 = url.match(/models\/([^:]+):/)[1];
    呼.push(模型);
    return 模型 === 'gemini-3.6-flash' || 模型 === 'gemini-3.8-flash' ? { status: 429, clone: () => ({ text: async () => '' }), body: null } : { status: 200, clone: () => ({ text: async () => '' }), body: null };
  };
  const 注文 = () => ({
    候補: 候補の模型たち('/v1beta/models/gemini-3.6-flash:generateContent', 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash'),
    鍵たち: ['K0', 'K1', 'K2'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    体: new TextEncoder().encode('{"contents":[]}'),
    fetch: 送る,
    待つ: async () => {},
  });
  const 一回目 = await 上流へ送る(注文());
  assert.strictEqual(一回目.使った模型, 'gemini-3.7-flash');
  assert.strictEqual(呼.filter((m) => m === 'gemini-3.6-flash').length, 3, '1 回目は鍵を全部試す');
  呼.length = 0;
  const 二回目 = await 上流へ送る(注文());
  assert.strictEqual(二回目.使った模型, 'gemini-3.7-flash');
  assert.deepStrictEqual(呼, ['gemini-3.7-flash'], '2 回目は枠切れの 3.6・3.8 を飛ばして 3.7 へ');
});
