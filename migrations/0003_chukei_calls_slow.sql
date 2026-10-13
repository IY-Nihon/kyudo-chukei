-- 最初の答えが待ちの上限までに来ず、打ち切って次の模型へ移った回数（src/index.mjs の 待ちの上限）
ALTER TABLE chukei_calls ADD COLUMN slow INTEGER;
