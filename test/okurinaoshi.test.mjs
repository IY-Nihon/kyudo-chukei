/**
 * 送り直す訳（鍵を替えるか・待って送り直すか）の検査。
 *
 *   node --test test/*.mjs
 *
 * 503（模型が混んでいる）は鍵のせいではないが山が短いので、待って送り直す。
 * 写真の読み取りで 2 回続けて 503 になり、使う人が「解析に失敗」しか見られなかった（2026-09-20）
 */
import test from 'node:test';
import assert from 'node:assert';
import { 送り直す訳, 混みの待ち } from '../src/index.mjs';

const 返事 = (status, 文 = '') => ({ status, clone: () => ({ text: async () => 文 }) });

test('429・403・401 と無効な鍵の 400 は次の鍵で送り直す', async () => {
  assert.strictEqual(await 送り直す訳(返事(429)), '鍵');
  assert.strictEqual(await 送り直す訳(返事(403)), '鍵');
  assert.strictEqual(await 送り直す訳(返事(401)), '鍵');
  assert.strictEqual(await 送り直す訳(返事(400, '{"error":{"message":"API key not valid","status":"INVALID_ARGUMENT"}}')), '鍵');
  assert.strictEqual(await 送り直す訳(返事(400, '{"error":{"message":"API_KEY_INVALID"}}')), '鍵');
});

test('503（混んでいる）は待って送り直す。待ちは 3 回ぶん、合わせて 15 秒以内', async () => {
  assert.strictEqual(await 送り直す訳(返事(503, 'This model is currently experiencing high demand.')), '混み');
  assert.strictEqual(混みの待ち.length, 3);
  assert.ok(混みの待ち.every((ms, i) => ms >= 1000 && (i === 0 || ms > 混みの待ち[i - 1])), '待ちは 1 秒以上で、だんだん長く');
  assert.ok(混みの待ち.reduce((a, b) => a + b, 0) <= 15000, '合わせて 15 秒以内（写真の読み取りの待ちに足す）');
});

test('通った返事・体がおかしい 400・404 は送り直さない', async () => {
  assert.strictEqual(await 送り直す訳(返事(200)), null);
  assert.strictEqual(await 送り直す訳(返事(400, '{"error":{"message":"Invalid JSON payload"}}')), null);
  assert.strictEqual(await 送り直す訳(返事(404)), null);
  assert.strictEqual(await 送り直す訳(返事(500)), null);
});
