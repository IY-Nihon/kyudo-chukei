// 1 日の回数の上限（src/ichinichi.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { 一日の枠に収まるか, 枠の日, 古い一日の数を消す, 既定の一日の上限 } from '../src/ichinichi.mjs';

/** D1 の代わり。鍵ごとに数を持つ */
function 偽のDB() {
  const 表 = new Map();
  const 消した = [];
  return {
    表,
    消した,
    prepare(文) {
      return {
        bind(...値) {
          return { 文, 値, run: async () => (消した.push(値[0]), { meta: { changes: 0 } }) };
        },
      };
    },
    async batch(たち) {
      return たち.map(({ 値 }) => {
        const [鍵, 日] = 値;
        const 行 = 表.get(鍵) || { day: 日, n: 0 };
        行.n += 1;
        表.set(鍵, 行);
        return { results: [{ n: 行.n }] };
      });
    },
  };
}

const 昼 = Date.UTC(2026, 10, 13, 3, 0, 0); // 日本 11/13 12:00・太平洋 11/12 19:00

test('枠の日は米国太平洋時間（Gemini の枠と同じ境目。日本の 17 時に変わる）', () => {
  assert.equal(枠の日(昼), '2026-11-12');
  assert.equal(枠の日(Date.UTC(2026, 10, 13, 7, 59)), '2026-11-12'); // 日本 16:59
  assert.equal(枠の日(Date.UTC(2026, 10, 13, 8, 0)), '2026-11-13'); // 日本 17:00
});

test('既定は 1 人 300 回・1 団体 1,000 回', () => {
  assert.deepEqual(既定の一日の上限, { 人: 300, 団体: 1000 });
});

test('人ごとの上限を越えたら断る。別の人は通る', async () => {
  const env = { KAIZEN_DB: 偽のDB(), DAILY_PERSON: '3', DAILY_GROUP: '100' };
  const 甲 = { 企画: 'p', 人: 'a', 団体: 'g' };
  for (let i = 0; i < 3; i++) assert.equal((await 一日の枠に収まるか(env, 甲, 昼)).収まる, true);
  assert.deepEqual(await 一日の枠に収まるか(env, 甲, 昼), { 収まる: false, 越えた: '人' });
  assert.equal((await 一日の枠に収まるか(env, { 企画: 'p', 人: 'b', 団体: 'g' }, 昼)).収まる, true);
});

test('団体ごとの上限は、人を替えても越える。別の団体は通る', async () => {
  const env = { KAIZEN_DB: 偽のDB(), DAILY_PERSON: '100', DAILY_GROUP: '4' };
  for (let i = 0; i < 4; i++)
    assert.equal((await 一日の枠に収まるか(env, { 企画: 'p', 人: 'u' + i, 団体: 'g' }, 昼)).収まる, true);
  assert.deepEqual(await 一日の枠に収まるか(env, { 企画: 'p', 人: 'u9', 団体: 'g' }, 昼), {
    収まる: false,
    越えた: '団体',
  });
  assert.equal((await 一日の枠に収まるか(env, { 企画: 'p', 人: 'u9', 団体: 'h' }, 昼)).収まる, true);
});

test('日が変わると数え直す。企画が違えば別に数える', async () => {
  const env = { KAIZEN_DB: 偽のDB(), DAILY_PERSON: '1', DAILY_GROUP: '0' };
  const 甲 = { 企画: 'p', 人: 'a' };
  assert.equal((await 一日の枠に収まるか(env, 甲, 昼)).収まる, true);
  assert.equal((await 一日の枠に収まるか(env, 甲, 昼)).収まる, false);
  assert.equal((await 一日の枠に収まるか(env, 甲, 昼 + 86400000)).収まる, true);
  assert.equal((await 一日の枠に収まるか(env, { 企画: 'q', 人: 'a' }, 昼)).収まる, true);
});

test('鍵はハッシュで、人も団体も読めない', async () => {
  const DB = 偽のDB();
  await 一日の枠に収まるか({ KAIZEN_DB: DB }, { 企画: 'kikaku', 人: 'hitoXYZ', 団体: 'dantai123' }, 昼);
  assert.equal(DB.表.size, 2);
  for (const 鍵 of DB.表.keys()) {
    assert.match(鍵, /^[0-9a-f]{64}$/);
    assert.ok(!鍵.includes('hitoXYZ') && !鍵.includes('dantai123'));
  }
});

test('D1 が無い・転んだときは通す（中継を止めない）', async () => {
  assert.equal((await 一日の枠に収まるか({}, { 企画: 'p', 人: 'a' }, 昼)).収まる, true);
  const 転ぶ = { KAIZEN_DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => Promise.reject(new Error('x')) } };
  const 元 = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await 一日の枠に収まるか(転ぶ, { 企画: 'p', 人: 'a' }, 昼)).収まる, true);
  } finally {
    console.warn = 元;
  }
});

test('上限 0 は数えない。団体が付いていなければ人だけ数える', async () => {
  const DB = 偽のDB();
  await 一日の枠に収まるか({ KAIZEN_DB: DB, DAILY_PERSON: '0', DAILY_GROUP: '0' }, { 企画: 'p', 人: 'a', 団体: 'g' }, 昼);
  assert.equal(DB.表.size, 0);
  await 一日の枠に収まるか({ KAIZEN_DB: DB }, { 企画: 'p', 人: 'a', 団体: '' }, 昼);
  assert.equal(DB.表.size, 1);
});

test('古い日は 3 日より前を消す', async () => {
  const DB = 偽のDB();
  await 古い一日の数を消す({ KAIZEN_DB: DB }, 昼);
  assert.deepEqual(DB.消した, ['2026-11-09']);
});
