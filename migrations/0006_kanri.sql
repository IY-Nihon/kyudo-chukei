-- 2026-11-14（src/kanri.mjs）管理者の合言葉。鍵 → 値（JSON）。
--   合言葉|{企画}|{団体} … {塩, ハッシュ, 回}（PBKDF2-SHA256。合言葉そのものは置かない）
--   まちがい|{企画}|{団体} … {数, 止める}
CREATE TABLE IF NOT EXISTS kanri (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at INTEGER NOT NULL
);
