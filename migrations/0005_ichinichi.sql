-- 2026-11-13（src/ichinichi.mjs）1 日の回数の上限。人ごと・団体ごとに Gemini への呼び出しを数える。
-- key は 日・企画・種・人または団体 をまとめたハッシュ（人も団体も分からない）。day は米国太平洋時間の日付。
-- 定時の処理が 3 日より前を消す
CREATE TABLE IF NOT EXISTS ichinichi (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ichinichi_day ON ichinichi (day);
