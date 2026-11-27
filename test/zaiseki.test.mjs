/**
 * メンバーが在籍しているか（src/zaiseki.mjs。2026-11-26 本人：卒業・退部にしたメンバーはログインできなくする）。
 * アプリの firestore.rules の enrolled と同じ答えになること。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import { 在籍の状態, 在籍しているか } from '../src/zaiseki.mjs';

const 字 = (v) => ({ stringValue: v });
const 数 = (v) => ({ integerValue: String(v) });
const 真偽 = (v) => ({ booleanValue: v });

test('在籍の項目があればそれが正', () => {
  assert.strictEqual(在籍の状態({ enrollment: 字('在籍') }), '在籍');
  assert.strictEqual(在籍の状態({ enrollment: 字('卒業') }), '卒業');
  assert.strictEqual(在籍の状態({ enrollment: 字('退部') }), '退部');
  // 在籍に戻した人は、前の形の卒業の印が残っていても在籍
  assert.strictEqual(
    在籍の状態({ enrollment: 字('在籍'), isAlumni: 真偽(true), graduationYear: 数(2025) }),
    '在籍'
  );
});

test('項目が無い・知らない値なら、前の形の卒業生の印で決める', () => {
  assert.strictEqual(在籍の状態({}), '在籍');
  assert.strictEqual(在籍の状態(undefined), '在籍');
  assert.strictEqual(在籍の状態({ grade: 数(5) }), '在籍', '学年 5 は見ない（決まりと同じ）');
  assert.strictEqual(在籍の状態({ isAlumni: 真偽(true) }), '卒業');
  assert.strictEqual(在籍の状態({ isAlumni: 真偽(false) }), '在籍');
  assert.strictEqual(在籍の状態({ graduationYear: 数(2025) }), '卒業');
  assert.strictEqual(在籍の状態({ graduationYear: 数(0) }), '在籍');
  assert.strictEqual(在籍の状態({ graduationYear: 字('') }), '在籍');
  assert.strictEqual(在籍の状態({ graduationYear: { nullValue: null } }), '在籍');
  assert.strictEqual(在籍の状態({ enrollment: 字('休部'), isAlumni: 真偽(true) }), '卒業');
  // 日時など知らない形は「空でない」（決まりの truthy と同じ）
  assert.strictEqual(在籍の状態({ graduationYear: { timestampValue: '2025-03-31T00:00:00Z' } }), '卒業');
  assert.strictEqual(在籍しているか({ enrollment: 字('退部') }), false);
  assert.strictEqual(在籍しているか({}), true);
});
