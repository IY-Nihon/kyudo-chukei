-- 打ち切った模型（流し読み・生成ごとに、最後に待ちの上限で打ち切った時刻）。src/index.mjs の 並べる が、この 6 時間に
-- 打ち切った模型を連鎖の後ろへ回す（2026-11-20 本人「並びを自動で直す」。前は実体ごとに 3 分だけ覚えていた）
CREATE TABLE IF NOT EXISTS mokei_osoi (
  kind TEXT NOT NULL,   -- '流し読み'（AI チャット）| '生成'（写真の読み取りなど）
  model TEXT NOT NULL,  -- 模型の名前（gemini-3.8-flash など）
  at INTEGER NOT NULL,  -- 最後に打ち切った時刻（ミリ秒）
  PRIMARY KEY (kind, model)
);
