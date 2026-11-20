-- 通す・通さないの控え（toosu）に、どの団体の人として通したか（grp）を置く（2026-11-20 の別の AI の点検の S4）。
-- 見出し（X-Kyudo-Group）の無い呼び出しも、見つけた団体で 1 日の上限を数えるため。入れる前の中継は grp を読まない
ALTER TABLE toosu ADD COLUMN grp TEXT;
