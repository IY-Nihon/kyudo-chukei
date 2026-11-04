-- 2026-11-04（src/index.mjs の 通してよい人か・呼んだ記録を残す、src/kojin.mjs の 部員を確かめる）
-- 通してよいかの控え。実体をまたいで使う（前は実体ごとで、別の実体に当たるたびに米国の Firestore を読み直していた）。
-- key は企画・人・団体をまとめたハッシュ（人を特定しない）。定時の処理が古いものを消す
CREATE TABLE IF NOT EXISTS toosu (
  key TEXT PRIMARY KEY,
  pass INTEGER NOT NULL,      -- 1 通す・0 通さない
  until INTEGER NOT NULL,     -- 控えの期限（ミリ秒）
  checked INTEGER NOT NULL    -- Firestore で確かめた時刻（届かないとき、ここから 1 時間まで通す）
);
-- App Check の印の様子（ok・none・bad）と、受けてから上流へ送り始めるまで（前ぶれ）のミリ秒
ALTER TABLE chukei_calls ADD COLUMN appcheck TEXT NOT NULL DEFAULT '';
ALTER TABLE chukei_calls ADD COLUMN pre_ms INTEGER NOT NULL DEFAULT 0;
-- 部員のログインを試した結果の数（入れた・見つからない・期限切れ・団体がまだ・4桁は終わり・試しすぎ・印なし・届かない）。
-- 人・通信元・団体は置かない。90 日で消す
CREATE TABLE IF NOT EXISTS kojin_tries (
  at INTEGER NOT NULL,
  project TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kojin_tries_at ON kojin_tries (at);
