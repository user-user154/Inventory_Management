/**
 * 6. smaregi.gs: スマレジ・プラットフォームAPI連携
 *
 * 目的: その日実際に売れた商品別出数(実績)を毎日取得し「実績出数ログ」へ書込み、
 * 「予算・実績」の「実績」列（合計金額）も自動更新する。
 * 商品名のクレンジング・集計は sheetActions.gs の aggregateCleanedSalesRows_ をそのまま流用する。
 *
 * 事前準備（このファイルのコードだけでは完結しない）:
 * 1. Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティに
 *    POS_CLIENT_ID_TEST / POS_CLIENT_SECRET_TEST を設定（値はコードに書かない）
 * 2. メニュー「発注管理」→「スマレジ日次自動取得トリガーを設定」を一度だけ実行
 *
 * 既知の未対応事項: 返品取引(returnSales=1)は現状 fetchSmaregiTransactionDetails_ の
 * 集計対象から特に区別していない（通常取引の details をそのまま合算）。返品が多い店舗では
 * 実データで実績と突き合わせて要検証。
 */

const ACTUAL_SALES_LOG_HEADERS_ = ["日付", "統一商品名", "販売点数", POS_SALES_HEADER_EX_TAX];

/** スクリプトプロパティからクライアント資格情報を読む（未設定ならエラー） */
const getSmaregiCredentials_ = () => {
  let props = PropertiesService.getScriptProperties();
  let clientId = props.getProperty("POS_CLIENT_ID_TEST");
  let clientSecret = props.getProperty("POS_CLIENT_SECRET_TEST");
  if (!clientId || !clientSecret) {
    throw new Error(
      "スクリプトプロパティに POS_CLIENT_ID_TEST / POS_CLIENT_SECRET_TEST が設定されていません。"
      + "プロジェクトの設定 → スクリプトプロパティ から登録してください。"
    );
  }
  return { clientId: clientId, clientSecret: clientSecret };
};

/** OAuth2 client_credentials でアクセストークンを取得（有効期限-60秒でキャッシュ） */
const getSmaregiAccessToken_ = (scope) => {
  let cache = CacheService.getScriptCache();
  let cacheKey = "smaregi_token_" + scope;
  let cached = cache.get(cacheKey);
  if (cached) return cached;

  let cred = getSmaregiCredentials_();
  let tokenUrl = `${SMAREGI_CONFIG.idBase}/app/${SMAREGI_CONFIG.contractId}/token`;
  let basic = Utilities.base64Encode(`${cred.clientId}:${cred.clientSecret}`);

  let res = UrlFetchApp.fetch(tokenUrl, {
    method: "post",
    headers: { Authorization: `Basic ${basic}` },
    contentType: "application/x-www-form-urlencoded",
    payload: { grant_type: "client_credentials", scope: scope },
    muteHttpExceptions: true
  });

  let code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`スマレジ アクセストークン取得失敗 status=${code} body=${res.getContentText().slice(0, 500)}`);
  }

  let json = JSON.parse(res.getContentText());
  let accessToken = json.access_token;
  let expiresIn = Number(json.expires_in) || 3600;
  cache.put(cacheKey, accessToken, Math.max(60, expiresIn - 60));
  return accessToken;
};

/** レスポンスJSONから配列部分を取り出す（配列直返し/ラップ両対応） */
const extractSmaregiListFromResponse_ = (json) => {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.list)) return json.list;
  if (json && Array.isArray(json.results)) return json.results;
  return [];
};

/**
 * 指定日(JST 00:00〜23:59:59)の取引明細を取得
 * 通常取引(transactionHeadDivision=1)かつ取消でない(cancelDivision=0)ものだけを対象にする
 */
const fetchSmaregiTransactionDetails_ = (dateStr) => {
  let token = getSmaregiAccessToken_("pos.transactions:read");
  let fromIso = `${dateStr}T00:00:00+09:00`;
  let toIso = `${dateStr}T23:59:59+09:00`;
  let baseUrl = `${SMAREGI_CONFIG.apiBase}/${SMAREGI_CONFIG.contractId}/pos/transactions`;

  let allDetails = [];
  let limit = 100;
  let maxPages = 50; // 安全弁（1日あたり最大5000取引を想定。想定外の応答形式での無限ループを防ぐ）

  for (let page = 1; page <= maxPages; page++) {
    let url = baseUrl
      + `?transaction_date_time-from=${encodeURIComponent(fromIso)}`
      + `&transaction_date_time-to=${encodeURIComponent(toIso)}`
      + `&with_details=all&limit=${limit}&page=${page}`;

    let res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });

    let code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(`スマレジ取引取得API失敗 [${dateStr} page=${page}] status=${code} body=${res.getContentText().slice(0, 500)}`);
    }

    let transactions = extractSmaregiListFromResponse_(JSON.parse(res.getContentText() || "[]"));
    if (transactions.length === 0) break;

    transactions.forEach((t) => {
      if (String(t.transactionHeadDivision) !== "1") return; // 通常取引以外(入金・ポイント等)は除外
      if (String(t.cancelDivision) === "1") return; // 取消済みは除外
      (t.details || []).forEach((d) => { allDetails.push(d); });
    });

    if (transactions.length < limit) break;
  }

  return allDetails;
};

/** 実績出数ログの見出しを用意（無ければ新規シート作成） */
const ensureActualSalesLogSheet_ = (ss) => {
  let sheet = ss.getSheetByName(SHEET_NAMES.ACTUAL_SALES_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.ACTUAL_SALES_LOG);
    Logger.log(`[スマレジ] シート「${SHEET_NAMES.ACTUAL_SALES_LOG}」を新規作成`);
  }
  let firstCell = String(sheet.getRange(1, 1).getValue() || "").trim();
  if (firstCell !== ACTUAL_SALES_LOG_HEADERS_[0]) {
    sheet.getRange(1, 1, 1, ACTUAL_SALES_LOG_HEADERS_.length).setValues([ACTUAL_SALES_LOG_HEADERS_]);
  }
  return sheet;
};

/** 指定日付の既存行を削除し、集計済み行に置き換える（同日の再取得は上書き） */
const writeActualSalesLogForDate_ = (sheet, dateStr, aggregatedRows) => {
  let lastRow = sheet.getLastRow();
  let keptRows = [];
  if (lastRow >= 2) {
    let existing = sheet.getRange(2, 1, lastRow - 1, ACTUAL_SALES_LOG_HEADERS_.length).getValues();
    keptRows = existing.filter((row) => { return formatSheetDateToKey(row[0]) !== dateStr; });
  }

  let newRows = (aggregatedRows || []).map((r) => {
    return [dateStr, r.menuName, r.salesQty, r.salesAmount];
  });
  let allRows = keptRows.concat(newRows);

  let clearRows = Math.max(lastRow - 1, allRows.length);
  if (clearRows > 0) {
    sheet.getRange(2, 1, clearRows, ACTUAL_SALES_LOG_HEADERS_.length).clearContent();
  }
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, ACTUAL_SALES_LOG_HEADERS_.length).setValues(allRows);
  }
};

/**
 * 指定日のスマレジ実績を取得し「実績出数ログ」へ書込み、「予算・実績」の実績列も更新する
 */
const importSmaregiDailyActuals_ = (dateStr) => {
  let details = fetchSmaregiTransactionDetails_(dateStr);
  let rows = details.map((d) => {
    return { rawName: d.productName, qty: d.quantity, salesIncTax: d.unitDiscountedSum };
  });
  let aggregated = aggregateCleanedSalesRows_(rows);

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ensureActualSalesLogSheet_(ss);
  writeActualSalesLogForDate_(logSheet, dateStr, aggregated);

  let totalAmount = aggregated.reduce((sum, r) => { return sum + (Number(r.salesAmount) || 0); }, 0);
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let budgetWritten = budgetSheet ? writeBudgetRatioAtDate_(budgetSheet, dateStr, "実績", totalAmount) : false;

  notifyUser(
    `スマレジ実績取込完了 [${dateStr}]: ${aggregated.length}商品 / 合計${Math.round(totalAmount).toLocaleString()}円`
    + (budgetWritten ? "（予算・実績「実績」列を更新）" : "（予算・実績: 対象日の行が見つからず書込みスキップ）")
  );

  return { dateStr: dateStr, productCount: aggregated.length, totalAmount: totalAmount };
};

/** 当日分を取得（毎晩22:45ごろの時間トリガーから呼ぶ想定。営業終了間際までの実績を取り込む） */
const runSmaregiDailyAutoImport = () => {
  importSmaregiDailyActuals_(formatJstDate_(new Date()));
};

/** 日付を指定して手動再取得（空欄なら本日） */
const promptAndImportSmaregiActuals_ = () => {
  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());
  let res = ui.prompt(
    "スマレジ実績取得",
    `対象日を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let input = String(res.getResponseText() || "").trim();
  let dateStr = input || today;
  if (isNaN(new Date(`${dateStr}T12:00:00`).getTime())) {
    ui.alert(`日付の形式が正しくありません: ${input}`);
    return;
  }
  importSmaregiDailyActuals_(dateStr);
};

const SMAREGI_DAILY_TRIGGER_HANDLER_ = "runSmaregiDailyAutoImport";

/** 日次自動取得トリガーを設定（初回のみ手動実行。二重登録は防止） */
const setupSmaregiDailyTrigger = () => {
  let alreadyExists = ScriptApp.getProjectTriggers().some((t) => {
    return t.getHandlerFunction() === SMAREGI_DAILY_TRIGGER_HANDLER_;
  });
  if (alreadyExists) {
    notifyUser("スマレジ日次自動取得トリガーは既に設定済みです。");
    return;
  }
  ScriptApp.newTrigger(SMAREGI_DAILY_TRIGGER_HANDLER_).timeBased().everyDays(1).atHour(22).nearMinute(45).create();
  notifyUser("スマレジ日次自動取得トリガーを設定しました（毎日22:45ごろ、当日分を自動取得）。");
};
