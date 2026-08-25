# infomart-debug

[infomart.gs](../infomart.gs) のInfomart BtoBプラットフォームAPI連携を、GAS（Apps Scriptエディタ）を介さず
ターミナルで検証するためのNode.js CLI。GASはログがLogger.logのみ・実行のたびにエディタに戻る必要があり
デバッグ効率が悪いため、同じロジックをNode.jsに移植してある。

## ファイル構成

- `gas-shim.js` … GASビルトイン（UrlFetchApp / PropertiesService / CacheService / Utilities / Logger）の最小限シム
- `config.js` … `constants.gs` の `INFOMART_CONFIG` 相当
- `infomart-core.js` … `infomart.gs` のSheetに依存しない部分（認証・API呼び出し）をそのまま移植したもの
- `cli.js` … コマンドラインの入り口。`test.js` の `runDiagnoseInfomart*` 群と1:1対応
- `.state/` … PFID・トークン等の実データ（gitignore対象。**絶対にコミットしない**）

## セットアップ

```bash
cd infomart-debug
node cli.js set-client <clientId> <clientSecret>
node cli.js set-credential <店舗名> <PFIDログインID> <PFIDパスワード>
```

- 店舗名は GAS側（予算・実績シートD1のプルダウン）と同じ表記を使うこと（別々の資格情報として扱われるため）
- 本番のスクリプトプロパティに既に `INFOMART_CLIENT_ID` 等がある場合は、Apps Scriptエディタの
  「プロジェクトの設定→スクリプトプロパティ」から値をコピーしてくれば、上記コマンドで同じ値を登録できる
- 環境変数 `INFOMART_CLIENT_ID` / `INFOMART_CLIENT_SECRET` が設定されていればそちらが優先される
  （`.state/properties.local.json` より優先）

設定内容の確認:

```bash
node cli.js show-state
```

## 使い方（まずはこの順で切り分ける）

```bash
# 1. トークン取得だけ確認（PFID・クライアント資格情報・ホスト疎通の切り分け）
node cli.js token <店舗名>

# 2. 請求書検索の生JSONを確認
node cli.js invoices <店舗名> 2026-07-02

# 3. 受発注データ(request→check→get)を1回通しで確認
node cli.js order <店舗名> 2026-07-01 2026-07-02 0

# 4. record_countが0件続きのときの切り分け: target_date_set(0-7)を総当たり
node cli.js scan-date-sets <店舗名> 13

# 5. status_set(0-5, 承認待ち等)を総当たり
node cli.js scan-status-sets <店舗名> 13

# 6. 親アカウント運用時の店舗判別可否（請求書・受発注それぞれのフィールド内訳）
node cli.js invoices-scope <店舗名> 30
node cli.js order-scope <店舗名> 13 2

# 未知のエンドポイント・パラメータを試したいとき（トークン取得込みで生POSTする）
node cli.js raw <店舗名> /ordApi/order/trade/download/request '{"target_date_set":2,"target_date_from":"2026-07-01","target_date_to":"2026-07-13"}'
```

`node cli.js --help` で全コマンド一覧を表示。

## 便利な環境変数

- `INFOMART_DEBUG_HTTP=1` … 送受信の生データをそのままログ出力する（パスワードはマスクされる）。原因調査時はまずこれを付けて実行する
- `INFOMART_USE_TEST_ENV=1` … テスト環境ホスト（`authtest.infomart.co.jp`）を使う。既定は本番

```bash
INFOMART_DEBUG_HTTP=1 node cli.js token <店舗名>
```

## infomart.gs との対応・移植のしかた

`infomart-core.js` の各関数は `infomart.gs` と同じ名前・同じ引数順で書いてある。差分は次の2点だけ:

1. GASの `UrlFetchApp.fetch` / `Utilities.sleep` は同期呼び出しだが、Node側はグローバル `fetch` を使うため
   全関数に `async` / `await` を追加している
2. Sheet書き込み系（`ensure*LogSheet_` / `write*LogFor*_` / `import*_` / `prompt*`）はここには無い
   （`infomart.gs` 側にだけ存在。Sheetに依存しない検証用途では不要なため移植していない）

ここで挙動やマッピングの修正が取れたら、`async`/`await` を外した上で `infomart.gs`（と `test.js` の
`runDiagnoseInfomart*`）に同じ差分を反映する。

## 既知の未確認事項（infomart.gs冒頭コメントと同じ）

- 請求書APIの実ホスト（`INFOMART_CONFIG.invoiceApiBase` のTODO）
- 受発注 `/check`・`/get` の正確なレスポンス形状
- `target_date_set`（0〜7）の各値が指す日付項目の意味
- 非同期ジョブの実際の完了時間（ポーリング間隔・上限回数の妥当性）

このCLIで実データを見ながら1つずつ潰していく想定。
