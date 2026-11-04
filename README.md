# kyudo-chukei — 弓道部的中ノートの Gemini 中継

Cloudflare Workers で動く小さな中継。アプリ（Expo Web）に Gemini の鍵を持たせず、
ここの secret にだけ置く。アプリは Firebase のログインの証（ID トークン）を
`Authorization: Bearer …` に付けて呼び、中継が証を確かめてから鍵を付けて Gemini へ流す。

- 配り先: https://kyudo-gemini-chukei.kyudo-chukei.workers.dev
- アプリ側の出入口: `kyudoscoremanager_app/src/geminiChukei.js`
- 受ける道: `GET /v1beta/models`、`POST /v1beta/models/{model}:generateContent`（`streamGenerateContent?alt=sse` も）
- 守り: 出どころ（CORS）・証の署名と企画（本番／検証）・通してよい人か（団体の持ち主か所属の証のある部員）・模型の許可一覧・
  人ごとに 40 回/分・全員で 300 回/分・App Check の印（`APPCHECK_MODE`）
- 鍵は何個でも持てる: `GEMINI_API_KEY`（1つ）＋ `GEMINI_API_KEYS`（`,` 区切り）。呼ぶたびに次の鍵から
  始め（回し持ち）、429／403／無効な鍵なら次の鍵で同じ体を送り直す。どの鍵で答えたかは
  `npx wrangler tail` の「鍵 3/7 200」で見る（返事や `/health` には載せない。載せると鍵の数と
  回し方が外から読め、上限まで使い切るのに何回要るかの見当を与える。2026-09-19 に外した）
- 模型は順に切り替える（`wrangler.toml` の `MODEL_CHAIN`＝写真の読み取りなど、`MODEL_CHAIN_STREAM`＝AI チャット）。
  - 503（模型が混んでいる）は鍵のせいではないので、次の模型があれば待たずに移る。最後の模型だけ 2・4・8 秒待って
    3 回まで送り直す。それでもだめなら 503 をそのまま返し、アプリが「混み合っています」と出す
  - どの鍵も 429、または 404 なら次の模型へ。429 で使い切った模型は 5 分飛ばす（最後の模型は飛ばさない）
  - 答えの頭が来ない模型は打ち切って次へ（流し読み 15 秒・生成 45 秒。流し読みは 2026-10-19 に 25 秒から縮めた）。
    全体は 95 秒に収め（Cloudflare は 100 秒で切る）、最後の模型は残りを全部待つ（2026-10-15）。
    打ち切った模型は 3 分のあいだ後ろへ回す（最後の模型は回さない。ただしこの控えは Worker の実体ごとにしか効かない）
  - 直近 30 分に答えた模型があれば、それを連鎖の先頭に回す（`chukei_calls` から読む。実体をまたいで効く。
    2026-10-25：3.8・3.7 が答えなくなり、チャットが毎回 15 秒ずつ 2 回打ち切ってから 3.6 に回っていた）
  - 切り替え先の模型（頼まれた模型でないもの）には考える量 0 を差す（`考えない体`）。AI チャットは 3.8 だけ考える量 1024（`チャットの考えを絞る`）
  - tail には「鍵 3/7 gemini-3.8-flash 200 混み1 1234ms 送った2 打ち切り1」
- 呼ぶたびに D1 の `chukei_calls` に 1 行残す（企画・種類・頼んだ模型・使った模型・状態・答えの頭までの ms・
  送った回数・混んだ回数・打ち切った回数）。遅さはここで見る（下の「読むとき」）

## 2026-11-04 の直し（速く・固く・部員のログイン）

- **前ぶれを同時に進める**: 証を確かめたら、通してよいかの確かめ・体の受け取り・直近に答えた模型・回数の上限を同時に始める
  （前は 1 つずつ待っていた）。かかった時間は `chukei_calls.pre_ms` に残る
- **通してよいかは Firestore を 1 回読むだけ**: アプリが入っている団体を `X-Kyudo-Group` に付け、中継はその人の証で
  `groups/{団体}` を読む（前は米国の Firestore を 2 回続けて読んでいた）。答えは実体の中と D1 の `toosu`（印はハッシュ）に控える
  （通す 10 分・通さない 1 分）。付いていない古い版のアプリは前の 2 回の道
- **Firestore に届かないときは通さない**（前は誰でも通していた）。前に通した人だけ、最後に確かめてから 1 時間まで通す
- **App Check の印**: アプリが `X-Firebase-AppCheck` を付ける。中継は Google の鍵で確かめ、`chukei_calls.appcheck` に
  `ok`・`none`・`bad` を残す。`wrangler.toml` の `APPCHECK_MODE` が `log`（既定。数えるだけ）か `enforce`（無い・正しくないものを断る）
- 偽の証を何度送られても、公開鍵を取り直すのは 1 分に 1 回まで（`src/kagi.mjs`）。直近に答えた模型は実体の中で 60 秒控える。
  体を字にするのは 1 回だけ。`/hozon` の大きすぎる体は読む前に 413
- 流し読みで中身の無い 200 が来たら、最後の模型でなければ次の模型へ（前はそのまま返し、アプリが送り直していた）
- **部員のログインの確かめ `POST /kojin`**（`src/kojin.mjs`）: 個人ID の総当たりを止める。下の「部員のログイン」

## 部員のログイン（POST /kojin）

前は部員の端末が匿名で入り、自分で逆引き表を引いて所属の証を書いていた。匿名の口座はいくらでも作れ、逆引き表は 1 件ずつなら
誰でも引けたので、個人ID を回数の上限なしに試せた。いまはアプリが `{団体, 鍵}` をここへ送り、中継が
通信元ごとに 1 分 10 回・団体ごとに 1 分 60 回（`RATE_KOJIN`・`RATE_KOJIN_GROUP`）まで受けて、サービスアカウントで
逆引き表・団体の帳面・名簿を読み、前の決まりと同じこと（6 字か 12/2 までの 4 桁か・招待の期限・団体の確認済みか猶予中か）を
確かめてから `member_claims/{uid}` を書く。試した結果は D1 の `kojin_tries` に数だけ残す（人・通信元・団体は置かない）。

鍵が置かれていない（`FIREBASE_SA_KEYS` が無い）ときは 404 を返す（古い中継と同じ）。アプリはそのとき前の道で入る。

### 配る順（一度だけ。逆にすると部員が入れない）

1. Google Cloud のコンソールで、本番（kyudoscoremanager）と検証（kyudoscoremanager-stg）のそれぞれに
   サービスアカウントを作り、役割「Cloud Datastore ユーザー」を付けて、鍵（JSON）を作る。鍵は Firestore を読み書きできるので、
   ほかに置かない（倉庫にも入れない）
2. 2 つの鍵を 1 つの JSON にまとめて置く:
   ```bash
   # {"kyudoscoremanager": {本番の鍵の中身}, "kyudoscoremanager-stg": {検証の鍵の中身}}
   npx wrangler secret put FIREBASE_SA_KEYS < 鍵たち.json
   ```
3. D1 に表を足す（`toosu`・`kojin_tries`・`chukei_calls` の `appcheck`・`pre_ms`）:
   `npx wrangler d1 migrations apply kyudo-kaizen --remote`
4. `npx wrangler deploy`
5. アプリを配る（`npm run deploy:web`）。そのあと決まりを配る（`npm run deploy:rules`）。決まりは端末が証を書くことを断るので、
   中継より先に配ると部員が新しく入れない

試した数は次で見る:
```bash
npx wrangler d1 execute kyudo-kaizen --remote --command "SELECT result, count(*) FROM kojin_tries WHERE project NOT LIKE '%-stg' GROUP BY result"
```

## App Check（あとで強制する）

印の無い・正しくない呼び出しの数は次で見る。`none` と `bad` が十分に減ってから `APPCHECK_MODE = "enforce"` にして配る:
```bash
npx wrangler d1 execute kyudo-kaizen --remote --command "SELECT appcheck, count(*) FROM chukei_calls WHERE project NOT LIKE '%-stg' AND at > (strftime('%s','now') - 7*86400) * 1000 GROUP BY appcheck"
```

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
# 中継の遅さ（本番だけ。project が -stg の行は検証環境の試し）
npx wrangler d1 execute kyudo-kaizen --remote --command "SELECT kind, used, count(*), round(avg(first_ms)), max(first_ms), round(avg(sends),1) FROM chukei_calls WHERE project NOT LIKE '%-stg' GROUP BY kind, used"
```

`chukei_calls` は migrations の 0002（表）と 0003（`slow` の列）・0004（`appcheck`・`pre_ms` の列）で作る。列を足す変更は、アプリの中継より先に
`npx wrangler d1 migrations apply kyudo-kaizen --remote` を当ててから `npx wrangler deploy` する。

名前の入った中身なので、倉庫や他の AI には入れない。消してほしいと言われたら `uid` か `group_id` で探して消す。
手元で試すときは、番号を仮に入れた設定で `npx wrangler d1 migrations apply kyudo-kaizen --local` と
`npx wrangler dev --local` を使う（2026-09-26 に文字の記録・写真・無い記録への写真 404・証なし 401 を確かめた）。
