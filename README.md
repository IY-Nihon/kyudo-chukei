# kyudo-chukei — 弓道部的中ノートの Gemini 中継

Cloudflare Workers で動く小さな中継。アプリ（Expo Web）に Gemini の鍵を持たせず、
ここの secret にだけ置く。アプリは Firebase のログインの証（ID トークン）を
`Authorization: Bearer …` に付けて呼び、中継が証を確かめてから鍵を付けて Gemini へ流す。

- 配り先: https://kyudo-gemini-chukei.kyudo-chukei.workers.dev
- アプリ側の出入口: `kyudoscoremanager_app/src/geminiChukei.js`
- 受ける道: `GET /v1beta/models`、`POST /v1beta/models/{model}:generateContent`（`streamGenerateContent?alt=sse` も）
- 守り: 出どころ（CORS）・証の署名と企画（本番／検証）・模型の許可一覧・人ごとに 40 回/分
- 鍵は何個でも持てる: `GEMINI_API_KEY`（1つ）＋ `GEMINI_API_KEYS`（`,` 区切り）。呼ぶたびに次の鍵から
  始め（回し持ち）、429／403／無効な鍵なら次の鍵で同じ体を送り直す。返事の `x-chukei-kagi: 3/7` が
  答えた鍵の番号。`/health` の `鍵の数` で、置いた数を確かめられる（値は出ない）

## 手順

```bash
npx wrangler login                       # 一度だけ
npx wrangler deploy                      # 配る
npx wrangler secret put GEMINI_API_KEY   # 鍵を置く／替える（一度だけ。束には入れない）
npx wrangler secret put GEMINI_API_KEYS  # 追加の鍵（, 区切り）。ファイルから流すなら  … | npx wrangler secret put GEMINI_API_KEYS
npx wrangler tail                        # 動いている様子を見る
```

鍵を替えるときは Google AI Studio で新しい鍵を作り、`secret put` で置き換えてから古い鍵を消す。
設定（許す出どころ・模型・企画）は `wrangler.toml` の `[vars]`。

## 通し検査（検証環境の団体の証で）

アプリ側の `scripts/fb-rest.mjs` で検証環境の証を取り、証なし＝401、偽の証＝401、
出どころ違い＝403、模型違い＝404、一覧と生成＝200、41 回目＝429 になることを見る
（2026-09-13 に確認）。
