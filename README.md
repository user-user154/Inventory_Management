# 発注管理

Google スプレッドシート + Google Apps Script（GAS）で動く、飲食店向け発注・仕込み管理システム。
POS実績（スマレジ）・仕入先請求/受発注データ（Infomart BtoBプラットフォーム）を取り込み、
理論在庫シミュレーションに基づいて翌日の仕込み・発注量を自動算出する。

## アーキテクチャ

- 本体はすべて Google Apps Script（`.gs`）。[clasp](https://github.com/google/clasp) でこのリポジトリとGASプロジェクトを同期する（`.clasp.json` の `scriptId` 参照）。
- スプレッドシートがDB兼UI。店舗ごとに「予算・実績 / 指示書 / POSデータ_生 / POSデータ_整形後 / バックログ / AI予測手動調整ログ / 予測出数ログ」のシート一式を複製して運用する（詳細は [storeSheets.gs](storeSheets.gs) 冒頭コメント）。
- 操作はスプレッドシートのカスタムメニュー「発注管理」（[main.gs](main.gs) の `onOpen`）、または指示書シートのA1プルダウン＋B1チェックボックスから実行する。

## ファイル構成

番号はファイル先頭コメントの読み込み順を表す（constants → coreFunction → load → utility → sheetActions → smaregi → infomart → storeSheets → weeklyCost）。

| ファイル | 役割 |
| --- | --- |
| [constants.gs](constants.gs) | 全ファイル共通定数（シート名等）。定数宣言はここのみ |
| [coreFunction.gs](coreFunction.gs) | コア計算ロジック（仕込み確定→原材料消費→発注判定、ロット管理・期限廃棄） |
| [load.gs](load.gs) | マスタ・各種データのロード、シミュレーションコンテキスト構築 |
| [utility.gs](utility.gs) | 単位換算・指示書逆算出力などの補助関数 |
| [sheetActions.gs](sheetActions.gs) | 指示書のチェックボックス連動（onEdit） |
| [smaregi.gs](smaregi.gs) | スマレジ・プラットフォームAPI連携（POS実績取得） |
| [infomart.gs](infomart.gs) | Infomart BtoBプラットフォームAPI連携（請求書・受発注データ取得、発注バックログのInfomart実データ化） |
| [storeSheets.gs](storeSheets.gs) | 店舗別シートの命名規則・解決・作成 |
| [weeklyCost.gs](weeklyCost.gs) | 棚卸しベースの週次原価率計算 |
| [infomart-debug/](infomart-debug/README.md) | Infomart連携をGASエディタを介さずNode.js CLIで検証するためのデバッグツール |

## セットアップ

```bash
npm install -g @google/clasp
clasp login
clasp pull   # または clasp push でこのリポジトリの内容をGASへ反映
```

スクリプトプロパティ（Apps Scriptエディタ → プロジェクトの設定）に以下を設定する（値はコードにもリポジトリにも含めない）：

- `POS_CLIENT_ID` / `POS_CLIENT_SECRET`（スマレジ）
- `INFOMART_CLIENT_ID` / `INFOMART_CLIENT_SECRET`（Infomart）、店舗ごとのPFIDは menu「InfomartのPFIDを登録」から登録

## 運用の起点

スプレッドシートを開き、メニュー「発注管理」から各操作を実行する（詳細は [main.gs](main.gs) の `onOpen`）。主な流れ：

1. 「店舗別シートを作成・整備」で店舗ごとのシート一式を用意
2. 「スマレジ実績を取得」で当日POS実績を取り込み
3. 「実績取得→翌日の仕込み・発注計算を今すぐ実行」で理論在庫シミュレーションを回す
4. 発注バックログは既定でInfomart実データを参照（切替用フラグ `INFOMART_ORDER_BACKLOG_SOURCE`。メニュー「発注バックログ取得元を切替」で手動確定コミット方式へロールバック可能）

## Infomart連携の状態

- フェーズ1（請求書・受発注データの読み取り）は実装済み
- 発注バックログのInfomart実データ化・理論在庫シミュレーションへの実納品日反映は実装済み（未クラスプpush・本番未検証の変更を含む場合あり。最新状況は `git log` を参照）
- 発注データの送信（Infomartへの発注確定・フェーズ2）は社内承認待ちのため未実装

## デバッグ

Infomart API連携の検証は [infomart-debug/](infomart-debug/README.md) のNode.js CLIを使う（GASエディタを介さずターミナルで生ログを確認できる）。
