#!/usr/bin/env node
"use strict";
/**
 * Infomart API連携の検証用CLI（GASのSpreadsheet UIを介さずターミナルで叩ける版）。
 * test.js の runDiagnoseInfomart* 群と1:1で対応させてあるので、ここで原因を掴んだら
 * infomart.gs / test.js 側に同じ変更を反映すればよい。
 *
 * 使い方はこのファイル単体で完結（`node cli.js` で一覧表示）。
 * 事前準備は README.md 参照。
 */

const fs = require("fs");
const {
  Logger,
  PropertiesService
} = require("./gas-shim");
const core = require("./infomart-core");
const { INFOMART_CONFIG } = require("./config");

const args = process.argv.slice(2);
const cmd = args[0];

const usage = () => {
  console.log(`
Infomart API 検証CLI

セットアップ:
  node cli.js set-client <clientId> <clientSecret>
  node cli.js set-credential <store> <userId> <userPassword> [memberCode]
      … memberCodeは自社会員システムコード（任意）。親アカウントPFIDで店舗を絞り込む場合に指定する
  node cli.js show-state

診断（test.js の runDiagnoseInfomart* に対応）:
  node cli.js token <store>
      … diagnoseInfomartToken_ 相当。まずはこれでトークン取得だけ確認する。
  node cli.js invoices <store> <dateStr> [dateTo]
      … diagnoseInfomartInvoices_ 相当。請求書検索の生JSONを確認する。
  node cli.js invoices-scope <store> [lookbackDays=30]
      … diagnoseInfomartStoreScope_ 相当。店舗判別用フィールドの内訳を確認する。
  node cli.js order <store> <dateFrom> <dateTo> [targetDateSet=0]
      … diagnoseInfomartOrderDelivery_ 相当。request→check→get を1回通しで実行する。
  node cli.js order-scope <store> [lookbackDays=13] [targetDateSet=2] [memberCodesCsv]
      … diagnoseInfomartOrderStoreScope_ 相当。取引先名の内訳を確認する。
  node cli.js scan-date-sets <store> [lookbackDays=13 | dateFrom dateTo] [memberCodesCsv]
      … diagnoseInfomartOrderRecordCountsByDateType_ 相当。target_date_set 0〜7を総当たり。
        memberCodesCsvは「自社会員システムコード」(半角8桁、店舗ごとに割当。Infomart側の
        アカウント切替UIで確認できる)。本部PFIDで店舗を絞り込みたいときに指定する。
        例: node cli.js scan-date-sets <store> 2026-08-01 2026-08-02 12345678
  node cli.js scan-status-sets <store> [lookbackDays=13 | dateFrom dateTo] [memberCodesCsv]
      … diagnoseInfomartOrderRecordCountsByStatusSet_ 相当。status_set 0〜5を総当たり。
        例: node cli.js scan-status-sets <store> 2026-08-01 2026-08-02 12345678
  node cli.js scan-day-before-yesterday <store> [memberCodesCsv]
      … 一昨日1日だけに絞って target_date_set 0〜7 を総当たり。

生API叩き（未知のエンドポイント・パラメータを試すときのエスケープハッチ）:
  node cli.js raw <store> <path> [jsonBody | @jsonファイルパス]
      bash例: node cli.js raw 西口店 /ordApi/order/trade/download/request '{"target_date_set":2,"target_date_from":"2026-07-01","target_date_to":"2026-07-13"}'
      PowerShell例（引用符が壊れやすいのでファイル経由を推奨）:
        node cli.js raw 西口店 /ordApi/order/trade/download/request @body.json
  node cli.js check <store> <batchId>
      … rawで受発注requestを叩いた後のbatch_idをそのまま渡せる（JSON不要）
  node cli.js get <store> <batchId> [seqFrom=1] [seqTo=1000]
      … checkでrecord_count>0になったあとの取得（JSON不要）

環境変数:
  INFOMART_USE_TEST_ENV=1   … テスト環境ホストを使う（既定は本番。constants.gsのuseTestEnvと同じ意味）
  INFOMART_DEBUG_HTTP=1     … 送受信の生データをログ出力する（パスワードはマスクする）
  INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET … set-client の代わりに環境変数でも指定可能
`);
};

const requireArg = (val, name) => {
  if (val == null || val === "") throw new Error(`引数 ${name} が必要です。`);
  return val;
};

const printJson = (label, obj, max) => {
  Logger.log(`${label}: ${JSON.stringify(obj).slice(0, max || 2000)}`);
};

const lookbackRange_ = (lookbackDays) => {
  let dateTo = core.formatJstDate_(new Date());
  let fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  let dateFrom = core.formatJstDate_(fromDate);
  return { dateFrom, dateTo };
};

const DATE_STR_RE_ = /^\d{4}-\d{2}-\d{2}$/;

/**
 * scan-date-sets / scan-status-sets の可変長引数（store以降）を柔軟に解釈する。
 * "2026-08-01"のような日付形式の引数があれば明示的な日付範囲（1つ目=dateFrom、2つ目=dateTo。
 * dateToが無ければdateFromと同日）として扱い、無ければ数値をlookbackDaysとして
 * 「今日からlookbackDays日前まで」を使う（省略時は13日）。日付・数値どちらでもない残りの
 * 引数はmemberCodesCsvとして扱う。
 */
const parseScanArgs_ = (rest) => {
  let dateArgs = rest.filter((a) => DATE_STR_RE_.test(a));
  let other = rest.filter((a) => !DATE_STR_RE_.test(a));
  let range;
  if (dateArgs.length > 0) {
    range = { dateFrom: dateArgs[0], dateTo: dateArgs[1] || dateArgs[0] };
  } else {
    // 日付指定が無い場合だけ、先頭の数値をlookbackDaysとして消費する
    // （8桁の店舗コードも数字だけになり得るが、日付指定モードでは無条件にmemberCodesとして扱う）
    let lookbackDays = (other.length > 0 && /^\d+$/.test(other[0])) ? Number(other.shift()) : 13;
    range = lookbackRange_(lookbackDays);
  }
  let memberCodesCsv = other[0];
  let memberCodes = memberCodesCsv ? memberCodesCsv.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return Object.assign({ memberCodes }, range);
};

// ---------------------------------------------------------------------------
// セットアップ系
// ---------------------------------------------------------------------------
const cmdSetClient = () => {
  let clientId = requireArg(args[1], "clientId");
  let clientSecret = requireArg(args[2], "clientSecret");
  let props = PropertiesService.getScriptProperties();
  props.setProperty("INFOMART_CLIENT_ID", clientId);
  props.setProperty("INFOMART_CLIENT_SECRET", clientSecret);
  Logger.log("クライアントID/シークレットを保存しました（infomart-debug/.state/properties.local.json）。");
};

const cmdSetCredential = () => {
  let store = requireArg(args[1], "store");
  let userId = requireArg(args[2], "userId");
  let userPassword = requireArg(args[3], "userPassword");
  let memberCode = args[4] || "";
  core.setInfomartCredentialForStore_(store, userId, userPassword, memberCode);
  Logger.log(`店舗「${store}」のPFIDを保存しました。${memberCode ? `（会員コード: ${memberCode}）` : ""}`);
};

const cmdShowState = () => {
  Logger.log(`useTestEnv=${INFOMART_CONFIG.useTestEnv} authBase=${core.infomartAuthBase_()} apiBase=${INFOMART_CONFIG.apiBase}`);
  let clientOk = true;
  try {
    core.getInfomartClientCredentials_();
  } catch (err) {
    clientOk = false;
  }
  Logger.log(`クライアントID/シークレット設定=${clientOk ? "済" : "未設定"}`);
  let credMap = core.getInfomartCredentialMap_();
  let refreshMap = core.getInfomartRefreshTokenMap_();
  Object.keys(credMap).forEach((store) => {
    Logger.log(`店舗「${store}」: PFID登録済み(userId=${credMap[store].userId}) / リフレッシュトークン=${refreshMap[store] ? "あり" : "なし"}`);
  });
  if (Object.keys(credMap).length === 0) Logger.log("PFID登録済みの店舗はまだありません。");
};

// ---------------------------------------------------------------------------
// 診断系
// ---------------------------------------------------------------------------
const cmdToken = async () => {
  let store = requireArg(args[1], "store");
  try {
    let token = await core.getInfomartAccessToken_(store);
    Logger.log(`[診断Infomart] 店舗=${store} トークン取得成功: ${String(token).slice(0, 8)}...（先頭8文字のみ表示）`);
  } catch (err) {
    Logger.log(`[診断Infomart] 店舗=${store} トークン取得失敗: ${err.message}`);
    throw err;
  }
};

const cmdInvoices = async () => {
  let store = requireArg(args[1], "store");
  let dateFrom = requireArg(args[2], "dateStr");
  let dateTo = args[3] || dateFrom;
  let invoices = await core.fetchInfomartInvoicesForDateRange_(dateFrom, dateTo, store);
  Logger.log(`[診断Infomart] 店舗=${store} 請求書件数=${invoices.length}`);
  if (invoices.length > 0) printJson("[診断Infomart] 先頭レコードの生JSON", invoices[0]);
};

const cmdInvoicesScope = async () => {
  let store = requireArg(args[1], "store");
  let lookbackDays = Number(args[2] || 30);
  let { dateFrom, dateTo } = lookbackRange_(lookbackDays);

  let invoices = await core.fetchInfomartInvoicesForDateRange_(dateFrom, dateTo, store);
  Logger.log(`[診断Infomart店舗スコープ:請求書] ログイン店舗=${store} 期間=${dateFrom}〜${dateTo} 合計件数=${invoices.length}`);
  if (invoices.length === 0) {
    Logger.log("[診断Infomart店舗スコープ:請求書] 判定不能: 対象期間に請求書が0件。lookbackDaysを増やすか日付範囲を見直してください。");
    return;
  }

  Logger.log(`[診断Infomart店舗スコープ:請求書] 先頭レコードのキー一覧: ${JSON.stringify(Object.keys(invoices[0]))}`);
  invoices.slice(0, 2).forEach((inv, i) => printJson(`[診断Infomart店舗スコープ:請求書] 生JSON[${i}]`, inv));

  ["company_name_s", "burden_sec_code", "burden_sec_name", "acc_depart_name", "private_cust_cd_s"].forEach((field) => {
    let counts = {};
    let present = false;
    invoices.forEach((inv) => {
      if (!(field in inv)) return;
      present = true;
      let value = inv[field] == null || inv[field] === "" ? "(空)" : String(inv[field]);
      counts[value] = (counts[value] || 0) + 1;
    });
    if (!present) {
      Logger.log(`[診断Infomart店舗スコープ:請求書] フィールド「${field}」はレスポンスに存在しない`);
      return;
    }
    Logger.log(`[診断Infomart店舗スコープ:請求書] フィールド「${field}」の内訳（${Object.keys(counts).length}種類）: ${JSON.stringify(counts).slice(0, 1000)}`);
  });
};

const cmdOrder = async () => {
  let store = requireArg(args[1], "store");
  let dateFrom = requireArg(args[2], "dateFrom");
  let dateTo = requireArg(args[3], "dateTo");
  let targetDateSet = Number(args[4] != null ? args[4] : 0);

  let { requestId, batchId } = await core.requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, null, store);
  Logger.log(`[診断Infomart] 店舗=${store} request完了 request_id=${requestId} batch_id=${batchId}`);

  let status = await core.pollInfomartOrderDeliveryUntilReady_(batchId, store);
  printJson("[診断Infomart] check最終状態", status, 500);

  let recordCount = Number(status.record_count) || 0;
  if (recordCount === 0) {
    Logger.log("[診断Infomart] record_count=0のため対象データなし（getは呼ばずに終了）");
    return;
  }
  let result = await core.getInfomartOrderDeliveryResult_(batchId, 1, Math.min(recordCount, 1000), store);
  printJson("[診断Infomart] get結果", result);
};

const cmdOrderScope = async () => {
  let store = requireArg(args[1], "store");
  let lookbackDays = Number(args[2] || 13);
  let targetDateSet = Number(args[3] != null ? args[3] : 2);
  let memberCodes = args[4] ? args[4].split(",").map((s) => s.trim()).filter(Boolean) : null;
  let { dateFrom, dateTo } = lookbackRange_(lookbackDays);

  let trades = await core.fetchInfomartOrderDeliveryTrades_(dateFrom, dateTo, targetDateSet, null, store, memberCodes);
  Logger.log(`[診断Infomart店舗スコープ:受発注] ログイン店舗=${store} 期間=${dateFrom}〜${dateTo} 合計件数=${trades.length}`);

  let companyNames = {};
  trades.forEach((t) => {
    let name = t.customer_company_name || "(空)";
    companyNames[name] = (companyNames[name] || 0) + 1;
  });
  Logger.log(`[診断Infomart店舗スコープ:受発注] 取引先(customer_company_name想定)の内訳: ${JSON.stringify(companyNames)}`);
  if (trades.length > 0) printJson("[診断Infomart店舗スコープ:受発注] 先頭レコードの生JSON", trades[0]);
};

const DATE_SET_LABELS_ = ["更新日", "伝票日", "発注日", "発送予定日", "発送日", "納品日", "受領日", "送信日"];
const STATUS_SET_LABELS_ = ["通常＋仕入伝票", "通常伝票のみ", "仕入伝票のみ", "申請発注", "発注予定", "振替伝票"];

const cmdScanDateSets = async () => {
  let store = requireArg(args[1], "store");
  let { dateFrom, dateTo, memberCodes } = parseScanArgs_(args.slice(2));

  for (let targetDateSet = 0; targetDateSet <= 7; targetDateSet++) {
    try {
      let { batchId } = await core.requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, null, store, memberCodes);
      let status = await core.pollInfomartOrderDeliveryUntilReady_(batchId, store);
      Logger.log(`[診断Infomart全date_set] target_date_set=${targetDateSet}(${DATE_SET_LABELS_[targetDateSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart全date_set] target_date_set=${targetDateSet}(${DATE_SET_LABELS_[targetDateSet]}) 失敗: ${err.message}`);
    }
  }
};

const cmdScanStatusSets = async () => {
  let store = requireArg(args[1], "store");
  let { dateFrom, dateTo, memberCodes } = parseScanArgs_(args.slice(2));

  for (let statusSet = 0; statusSet <= 5; statusSet++) {
    try {
      let { batchId } = await core.requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, 2, null, store, memberCodes, statusSet);
      let status = await core.pollInfomartOrderDeliveryUntilReady_(batchId, store);
      Logger.log(`[診断Infomart全status_set] status_set=${statusSet}(${STATUS_SET_LABELS_[statusSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart全status_set] status_set=${statusSet}(${STATUS_SET_LABELS_[statusSet]}) 失敗: ${err.message}`);
    }
  }
};

const cmdScanDayBeforeYesterday = async () => {
  let store = requireArg(args[1], "store");
  let memberCodes = args[2] ? args[2].split(",").map((s) => s.trim()).filter(Boolean) : null;
  let target = new Date();
  target.setDate(target.getDate() - 2);
  let dateStr = core.formatJstDate_(target);

  Logger.log(`[診断Infomart一昨日] 対象日=${dateStr}`);
  for (let targetDateSet = 0; targetDateSet <= 7; targetDateSet++) {
    try {
      let { batchId } = await core.requestInfomartOrderDeliveryExtract_(dateStr, dateStr, targetDateSet, null, store, memberCodes);
      let status = await core.pollInfomartOrderDeliveryUntilReady_(batchId, store);
      Logger.log(`[診断Infomart一昨日] target_date_set=${targetDateSet}(${DATE_SET_LABELS_[targetDateSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart一昨日] target_date_set=${targetDateSet}(${DATE_SET_LABELS_[targetDateSet]}) 失敗: ${err.message}`);
    }
  }
};

const cmdRaw = async () => {
  let store = requireArg(args[1], "store");
  let path = requireArg(args[2], "path（例: /ordApi/order/trade/download/request）");
  let bodyArg = args[3];
  let bodyJson = {};
  if (bodyArg) {
    // PowerShellだとJSON中の二重引用符が壊れやすいので、"@ファイルパス" でファイルから読めるようにする
    let raw = bodyArg.startsWith("@") ? fs.readFileSync(bodyArg.slice(1), "utf8") : bodyArg;
    try {
      bodyJson = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `JSONの解析に失敗しました: ${err.message}\n`
        + `PowerShellでは引数中の二重引用符が壊れやすいので、body.jsonのようなファイルに書いて `
        + `"node cli.js raw <store> <path> @body.json" の形で渡してください。`
      );
    }
  }
  let url = `${INFOMART_CONFIG.apiBase}${path}`;
  let json = await core.infomartApiPost_(url, bodyJson, store);
  printJson(`[raw] ${path}`, json, 5000);
};

// batch_idだけで済むcheck/getはJSON引数無しで叩けるようにする（PowerShellの引用符問題を避けるため）
const cmdCheck = async () => {
  let store = requireArg(args[1], "store");
  let batchId = requireArg(args[2], "batchId");
  let status = await core.checkInfomartOrderDeliveryBatch_(batchId, store);
  printJson(`[check] batch_id=${batchId}`, status, 2000);
};

const cmdGet = async () => {
  let store = requireArg(args[1], "store");
  let batchId = requireArg(args[2], "batchId");
  let seqFrom = Number(args[3] || 1);
  let seqTo = Number(args[4] || 1000);
  let result = await core.getInfomartOrderDeliveryResult_(batchId, seqFrom, seqTo, store);
  printJson(`[get] batch_id=${batchId}`, result, 5000);
};

// ---------------------------------------------------------------------------
const COMMANDS = {
  "set-client": cmdSetClient,
  "set-credential": cmdSetCredential,
  "show-state": cmdShowState,
  "token": cmdToken,
  "invoices": cmdInvoices,
  "invoices-scope": cmdInvoicesScope,
  "order": cmdOrder,
  "order-scope": cmdOrderScope,
  "scan-date-sets": cmdScanDateSets,
  "scan-status-sets": cmdScanStatusSets,
  "scan-day-before-yesterday": cmdScanDayBeforeYesterday,
  "raw": cmdRaw,
  "check": cmdCheck,
  "get": cmdGet
};

(async () => {
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }
  let handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`不明なコマンド: ${cmd}`);
    usage();
    process.exitCode = 1;
    return;
  }
  try {
    await handler();
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    if (process.env.INFOMART_DEBUG_HTTP) console.error(err.stack);
    process.exitCode = 1;
  }
})();
