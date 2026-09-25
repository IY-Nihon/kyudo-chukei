# kyudo-chukei — 弓道部的中ノートの Gemini 中継

Cloudflare Workers で動く小さな中継。アプリ（Expo Web）に Gemini の鍵を持たせず、
ここの secret にだけ置く。アプリは Firebase のログインの証（ID トークン）を
`Authorization: Bearer …` に付けて呼び、中継が証を確かめてから鍵を付けて Gemini へ流す。

- 配り先: https://kyudo-gemini-chukei.kyudo-chukei.workers.dev
- アプリ側の出入口: `kyudoscoremanager_app/src/geminiChukei.js`
- 受ける道: `GET /v1beta/models`、`POST /v1beta/models/{model}:generateContent`（`streamGenerateContent?alt=sse` も）
- 守り: 出どころ（CORS）・証の署名と企画（本番／検証）・模型の許可一覧・人ごとに 40 回/分
- 鍵は何個でも持てる: `GEMINI_API_KEY`（1つ）＋ `GEMINI_API_KEYS`（`,` 区切り）。呼ぶたびに次の鍵から
  始め（回し持ち）、429／403／無効な鍵なら次の鍵で同じ体を送り直す。どの鍵で答えたかは
  `npx wrangler tail` の「鍵 3/7 200」で見る（返事や `/health` には載せない。載せると鍵の数と
  回し方が外から読め、上限まで使い切るのに何回要るかの見当を与える。2026-09-19 に外した）
- 503（模型が混んでいる）は鍵のせいではないので、2・4・8 秒待って 3 回まで送り直す（鍵も次に替える）。
  それでもだめなら 503 をそのまま返し、アプリが 8 秒待ってもう一度呼び、だめなら「混み合っています」と出す。
  tail には「鍵 3/7 200 混み1」

## 手順

```bash
npx wrangler login                       # 一度だけ
npx wrangler deploy                      # 配る
npx wrangler secret put GEMINI_API_KEY   # 鍵を置く／替える（一度だけ。束には入れない）
npx wrangler secret put GEMINI_API_KEYS  # 追加の鍵（, 区切り）。ファイルから流すなら  … | npx wrangler secret put GEMINI_API_KEYS
npx wrangler tail                        # 動いている様子を見る
node --test test/*.mjs                   # 手元の検査（role の直し方・送り直す訳・改善のための保存）
```

鍵を替えるときは Google AI Studio で新しい鍵を作り、`secret put` で置き換えてから古い鍵を消す。
設定（許す出どころ・模型・企画）は `wrangler.toml` の `[vars]`。

## 通し検査（検証環境の団体の証で）

アプリ側の `scripts/fb-rest.mjs` で検証環境の証を取り、証なし＝401、偽の証＝401、
出どころ違い＝403、模型違い＝404、一覧と生成＝200、41 回目＝429 になることを見る
（2026-09-13 に確認）。

## アプリの改善のための保存（/hozon、2026-09-26）

使う人が AI に送ったものと答え・読み取りの結果を 1 年だけ取っておく（`src/hozon.mjs`）。
運用者が決めた（AI チャットの質問と答え・写真読み取りの結果と直しと写真・出欠の予定表）。
プライバシーポリシー第12条に書いてある。

- `POST /hozon` … `{id, 種類, 中身}`（JSON、256KB まで）を D1 の `kaizen_logs` に 1 行
- `PUT /hozon/photo/{id}/{番}` … 写真・PDF をそのまま（5MB まで）KV に `photo/{id}/{番}`、1 年の期限付き。
  JSON に埋めないのは、無料枠の CPU 10ms を base64 の読み解きで超えるため
- 写真は、同じ人（証の sub）が先に書いた記録にしか付けられない
- 1 年を過ぎた行は毎日の定時の処理（`scheduled`）で消す。写真は KV の期限で消える
- 置き場がつながっていなければ 503（アプリは黙って捨てる。AI 機能は止まらない）
- 置くのは本番の企画（kyudoscoremanager）の証で来たものだけ。検証環境の e2e や試しは 202 を返して置かない
  （無料枠を守るため）。検証環境でも置きたいときは [vars] に HOZON_PROJECTS = "kyudoscoremanager,kyudoscoremanager-stg"

### 初めて配るとき（一度だけ）

```bash
npx wrangler d1 create kyudo-kaizen            # 出た database_id を wrangler.toml へ
npx wrangler kv namespace create KAIZEN_PHOTOS # 出た id を wrangler.toml へ
# wrangler.toml に次を足す（番号は上で出たもの）
#   [[d1_databases]] binding = "KAIZEN_DB", database_name = "kyudo-kaizen", database_id = "…", migrations_dir = "migrations"
#   [[kv_namespaces]] binding = "KAIZEN_PHOTOS", id = "…"
#   [triggers] crons = ["17 18 * * *"]   （毎日 3:17 JST）
npx wrangler d1 migrations apply kyudo-kaizen --remote
npx wrangler deploy
```

### 読むとき

```bash
npx wrangler d1 execute kyudo-kaizen --remote --command "SELECT kind, count(*) FROM kaizen_logs GROUP BY kind"
npx wrangler d1 execute kyudo-kaizen --remote --command "SELECT id, created_at, group_id, content FROM kaizen_logs WHERE kind='写真読み取り' ORDER BY created_at DESC LIMIT 20"
npx wrangler kv key get --binding KAIZEN_PHOTOS --remote "photo/{id}/0" > 写真.jpg
```

名前の入った中身なので、倉庫や他の AI には入れない。消してほしいと言われたら `uid` か `group_id` で探して消す。
手元で試すときは、番号を仮に入れた設定で `npx wrangler d1 migrations apply kyudo-kaizen --local` と
`npx wrangler dev --local` を使う（2026-09-26 に文字の記録・写真・無い記録への写真 404・証なし 401 を確かめた）。
