/**
 * 模型の並びを自動で直す（並べる・直近の答え・最近打ち切った模型たち・打ち切った模型を書く）と、1 時間ごとの見回り（見回る）の検査。
 * 2026-11-20 本人「並びを自動で直す」「見回り（1 時間ごと）」
 *
 *   node --test test/*.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import worker, {
  並べる,
  直近の答え,
  最近打ち切った模型たち,
  打ち切った模型を書く,
  答えた模型を忘れる,
  答えた模型を見る長さ,
  遅いを覚える長さ,
  見回る,
  見回りの時刻,
  見回りの間,
  上流へ送る,
  候補の模型たち,
} from '../src/index.mjs';

const 流 = (m) => `/v1beta/models/${m}:streamGenerateContent`;
const 連鎖 = 'gemini-3.6-flash,gemini-3.5-flash,gemini-3.8-flash,gemini-3.7-flash,gemini-4-hydrogen';
const 候補 = () => 候補の模型たち(流('gemini-3.6-flash'), 連鎖, true);
const 名 = (並び) => 並び.map((x) => x.模型.replace('gemini-', '').replace('-flash', ''));

/** chukei_calls と mokei_osoi を配列で持つ偽の D1。走った文を 文たち に残す */
function 偽のD1({ 呼んだ = [], 遅い = [], 落ちる = false } = {}) {
  const 文たち = [];
  const db = {
    prepare: (sql) => ({
      bind: (...値) => ({
        first: async () => {
          文たち.push(sql);
          if (落ちる) throw new Error('no such table');
          const [種, 以後] = 値;
          const 当たり = 呼んだ
            .filter((r) => r.kind === 種 && r.status === 200 && r.used && r.at > 以後)
            .sort((a, b) => b.at - a.at);
          return 当たり[0] || null;
        },
        all: async () => {
          文たち.push(sql);
          if (落ちる) throw new Error('no such table');
          const [種, 以後] = 値;
          return { results: 遅い.filter((r) => r.kind === 種 && r.at > 以後) };
        },
        run: async () => {
          文たち.push(sql);
          if (/INSERT OR REPLACE INTO mokei_osoi/.test(sql)) {
            const [kind, model, at] = 値;
            const i = 遅い.findIndex((r) => r.kind === kind && r.model === model);
            if (i >= 0) 遅い.splice(i, 1);
            遅い.push({ kind, model, at });
          } else if (/INSERT INTO chukei_calls/.test(sql)) {
            const [at, project, kind, requested, used, status, first_ms] = 値;
            呼んだ.push({ at, project, kind, requested, used, status, first_ms });
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return { env: { KAIZEN_DB: db, GEMINI_API_KEYS: 'K0,K1', MODEL_CHAIN_STREAM: 連鎖 }, 呼んだ, 遅い, 文たち };
}

test('並べる：答えた模型を先頭へ・この 6 時間に打ち切った模型は後ろへ（打ち切ったあとに答えていれば戻す）', () => {
  const 今 = 10_000_000_000;
  assert.deepStrictEqual(名(並べる(候補(), { 模型: '', 時: 0 }, new Map(), 今)), ['3.6', '3.5', '3.8', '3.7', '4-hydrogen']);
  // 3.5 が答えた → 先頭
  assert.deepStrictEqual(名(並べる(候補(), { 模型: 'gemini-3.5-flash', 時: 今 - 1000 }, new Map(), 今))[0], '3.5');
  // 3.6 を 1 時間前に打ち切った → 後ろへ。7 時間前なら忘れる
  assert.deepStrictEqual(
    名(並べる(候補(), { 模型: '', 時: 0 }, new Map([['gemini-3.6-flash', 今 - 3_600_000]]), 今)),
    ['3.5', '3.8', '3.7', '4-hydrogen', '3.6']
  );
  assert.deepStrictEqual(
    名(並べる(候補(), { 模型: '', 時: 0 }, new Map([['gemini-3.6-flash', 今 - 遅いを覚える長さ - 1]]), 今))[0],
    '3.6'
  );
  // 答えた模型でも、そのあとに打ち切っていれば後ろ。打ち切ったあとに答えていれば先頭
  assert.deepStrictEqual(
    名(並べる(候補(), { 模型: 'gemini-3.5-flash', 時: 今 - 5000 }, new Map([['gemini-3.5-flash', 今 - 1000]]), 今)),
    ['3.6', '3.8', '3.7', '4-hydrogen', '3.5']
  );
  assert.deepStrictEqual(
    名(並べる(候補(), { 模型: 'gemini-3.5-flash', 時: 今 - 1000 }, new Map([['gemini-3.5-flash', 今 - 5000]]), 今))[0],
    '3.5'
  );
  // みな遅ければ並びのまま。候補が 1 つ（切り替えない）ならそのまま
  const みな = new Map(候補().map((x) => [x.模型, 今 - 1000]));
  assert.deepStrictEqual(名(並べる(候補(), { 模型: '', 時: 0 }, みな, 今)), ['3.6', '3.5', '3.8', '3.7', '4-hydrogen']);
  const 一つ = [{ 模型: 'gemini-3.6-flash', 道: 流('gemini-3.6-flash') }];
  assert.strictEqual(並べる(一つ, { 模型: '', 時: 0 }, みな, 今), 一つ);
});

test('直近の答え：7 日の中で最後に答えた模型と時刻。8 日前は見ない。読めなければ空', async () => {
  答えた模型を忘れる();
  const 今 = 10_000_000_000;
  const { env } = 偽のD1({
    呼んだ: [
      { at: 今 - 3 * 86_400_000, kind: '流し読み', status: 200, used: 'gemini-3.6-flash' },
      { at: 今 - 答えた模型を見る長さ - 1, kind: '流し読み', status: 200, used: 'gemini-3.5-flash' },
    ],
  });
  assert.deepStrictEqual(await 直近の答え(env, '流し読み', 今), { 模型: 'gemini-3.6-flash', 時: 今 - 3 * 86_400_000 });
  答えた模型を忘れる();
  assert.deepStrictEqual(await 直近の答え(偽のD1({ 落ちる: true }).env, '流し読み', 今), { 模型: '', 時: 0 });
  答えた模型を忘れる();
});

test('最近打ち切った模型たち・打ち切った模型を書く：D1 に置いて読む（実体の中は 60 秒控える）。表が無くても止めない', async () => {
  答えた模型を忘れる();
  const 今 = 10_000_000_000;
  const 偽 = 偽のD1({ 遅い: [{ kind: '流し読み', model: 'gemini-3.8-flash', at: 今 - 1000 }, { kind: '生成', model: 'gemini-3.7-flash', at: 今 - 1000 }] });
  const 表 = await 最近打ち切った模型たち(偽.env, '流し読み', 今);
  assert.deepStrictEqual([...表.keys()], ['gemini-3.8-flash']);
  await 打ち切った模型を書く(偽.env, '流し読み', 'gemini-3.7-flash', 今 + 10);
  assert.ok(偽.遅い.some((r) => r.kind === '流し読み' && r.model === 'gemini-3.7-flash'), 'D1 に書いていない');
  // 控えにもすぐ入る（D1 を読み直さない）
  const 読んだ数 = 偽.文たち.filter((s) => /FROM mokei_osoi/.test(s)).length;
  const 次 = await 最近打ち切った模型たち(偽.env, '流し読み', 今 + 20);
  assert.ok(次.has('gemini-3.7-flash'));
  assert.strictEqual(偽.文たち.filter((s) => /FROM mokei_osoi/.test(s)).length, 読んだ数, '60 秒の中で D1 を読み直した');
  答えた模型を忘れる();
  assert.strictEqual((await 最近打ち切った模型たち(偽のD1({ 落ちる: true }).env, '流し読み', 今)).size, 0);
  答えた模型を忘れる();
});

test('上流へ送る：待ちの上限で打ち切った模型を 打ちきりを書く に渡す（どの実体からも 6 時間後ろへ回すため）', async () => {
  const 書いた = [];
  const 黙る = (url, 頼み) =>
    new Promise((_, ng) => 頼み.signal && 頼み.signal.addEventListener('abort', () => ng(new Error('aborted'))));
  const 結果 = await 上流へ送る({
    候補: ['gemini-3.8-flash', 'gemini-3.6-flash'].map((模型) => ({ 模型, 道: 流(模型) })),
    鍵たち: ['a'],
    始めの鍵: 0,
    search: '',
    method: 'POST',
    待ちの上限: 30,
    fetch: (url, 頼み) => (url.includes('3.8') ? 黙る(url, 頼み) : Promise.resolve(new Response('data: {}\n\n', { status: 200 }))),
    待つ: async () => {},
    打ち切りを書く: (模型) => 書いた.push(模型),
  });
  assert.strictEqual(結果.使った模型, 'gemini-3.6-flash');
  assert.deepStrictEqual(書いた, ['gemini-3.8-flash']);
  答えた模型を忘れる();
});

test('見回る：直近 1 時間に答えていれば何もしない。使われていなければ先頭の模型に 1 回だけ送り、答えを記録に残す', async () => {
  答えた模型を忘れる();
  const 今 = 10_000_000_000;
  const 使った = 偽のD1({ 呼んだ: [{ at: 今 - 10 * 60_000, kind: '流し読み', status: 200, used: 'gemini-3.6-flash' }] });
  let 呼び = 0;
  assert.deepStrictEqual(
    await 見回る(使った.env, { 今: () => 今, fetch: async () => (呼び++, new Response('', { status: 200 })) }),
    { 見回った: false, 訳: '使われている' }
  );
  assert.strictEqual(呼び, 0);
  答えた模型を忘れる();
  // 2 時間使われていない・3.6 を 1 時間前に打ち切った → 3.5 に送る
  const 偽 = 偽のD1({
    呼んだ: [{ at: 今 - 2 * 見回りの間, kind: '流し読み', status: 200, used: 'gemini-3.6-flash' }],
    遅い: [{ kind: '流し読み', model: 'gemini-3.6-flash', at: 今 - 3_600_000 }],
  });
  const 送った = [];
  const 結果 = await 見回る(偽.env, {
    今: () => 今,
    鍵の番: 1,
    fetch: async (url, 頼み) => {
      送った.push({ url, 鍵: 頼み.headers.get('x-goog-api-key'), 体: JSON.parse(頼み.body) });
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"はい"}]}}]}\n\n', { status: 200 });
    },
  });
  assert.strictEqual(結果.見回った, true);
  assert.strictEqual(結果.答えた, true);
  assert.strictEqual(結果.模型, 'gemini-3.5-flash');
  assert.strictEqual(送った.length, 1, '1 回の見回りで 2 つ以上の模型に送った');
  assert.match(送った[0].url, /gemini-3\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.strictEqual(送った[0].鍵, 'K1');
  assert.deepStrictEqual(送った[0].体.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  const 記録 = 偽.呼んだ.find((r) => r.project === '見回り');
  assert.ok(記録 && 記録.status === 200 && 記録.used === 'gemini-3.5-flash' && 記録.kind === '流し読み', '見回りの答えを記録に残していない');
  答えた模型を忘れる();
});

test('見回る：答えなければ（待ちの上限で打ち切る）打ち切った模型として書き、記録は 504', async () => {
  答えた模型を忘れる();
  const 今 = 10_000_000_000;
  const 偽 = 偽のD1({});
  const 結果 = await 見回る(偽.env, {
    今: () => 今,
    上限: 40,
    fetch: (url, 頼み) =>
      new Promise((_, ng) => 頼み.signal && 頼み.signal.addEventListener('abort', () => ng(new Error('aborted')))),
  });
  assert.strictEqual(結果.答えた, false);
  assert.strictEqual(結果.模型, 'gemini-3.6-flash');
  assert.ok(偽.遅い.some((r) => r.model === 'gemini-3.6-flash' && r.kind === '流し読み'), '打ち切った模型を書いていない');
  assert.strictEqual(偽.呼んだ.find((r) => r.project === '見回り').status, 504);
  // 鍵が無ければ見回らない
  assert.deepStrictEqual((await 見回る({ KAIZEN_DB: 偽.env.KAIZEN_DB }, { 今: () => 今 })).見回った, false);
  答えた模型を忘れる();
});

test('定時：1 時間ごとの cron では見回りだけ（毎日の片付けの DELETE を流さない）', async () => {
  答えた模型を忘れる();
  const 偽 = 偽のD1({});
  const 待ち = [];
  await worker.scheduled({ cron: 見回りの時刻 }, { ...偽.env, GEMINI_API_KEYS: '' }, { waitUntil: (p) => 待ち.push(p) });
  await Promise.all(待ち);
  assert.ok(!偽.文たち.some((s) => /DELETE/.test(s)), '見回りの定時に片付けを流した');
  答えた模型を忘れる();
});
