-- アプリの改善のための保存（src/hozon.mjs）。1 年を過ぎた行は毎日の定時の処理で消す
CREATE TABLE IF NOT EXISTS kaizen_logs (
  id TEXT PRIMARY KEY,          -- アプリが作る UUID（写真を同じ記録に付けるため）
  created_at INTEGER NOT NULL,  -- 受けた時刻（ミリ秒）
  kind TEXT NOT NULL,           -- 'チャット' | '写真読み取り' | '予定表'
  project TEXT NOT NULL,        -- ログインの証の企画（kyudoscoremanager / kyudoscoremanager-stg）
  uid TEXT NOT NULL,            -- ログインの証の sub（消してほしいと言われたときに探すため）
  group_id TEXT,                -- 団体の番号（アプリが中身に入れたもの）
  content TEXT,                 -- 中身（JSON）
  photos INTEGER NOT NULL DEFAULT 0  -- 付けた写真・PDF の数（KV の photo/{id}/{番}）
);
CREATE INDEX IF NOT EXISTS kaizen_logs_created_at ON kaizen_logs (created_at);
CREATE INDEX IF NOT EXISTS kaizen_logs_kind ON kaizen_logs (kind, created_at);
