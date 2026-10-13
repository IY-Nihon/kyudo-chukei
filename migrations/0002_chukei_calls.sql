-- Gemini を呼んだ 1 回ごとの記録（src/index.mjs の 呼んだ記録を残す）。遅いときにどこで詰まったかを見る。90 日で消す
CREATE TABLE IF NOT EXISTS chukei_calls (
  at INTEGER NOT NULL,        -- 受けた時刻（ミリ秒）
  project TEXT NOT NULL,      -- ログインの証の企画（本番 kyudoscoremanager / 検証 kyudoscoremanager-stg）
  kind TEXT NOT NULL,         -- '流し読み'（AI チャット）| '生成'（写真の読み取りなど）
  requested TEXT,             -- アプリが頼んだ模型
  used TEXT,                  -- 実際に答えた模型（切り替えたあと）
  status INTEGER,             -- 返した状態
  first_ms INTEGER,           -- 最初の答えの塊が来るまでのミリ秒
  sends INTEGER,              -- 上流へ送った回数（鍵・模型の切り替えで増える）
  busy INTEGER                -- 混み（503）で待った回数
);
CREATE INDEX IF NOT EXISTS chukei_calls_at ON chukei_calls (at);
