/**
 * 6. smaregi.gs: スマレジ・プラットフォームAPI連携（本番）
 *
 * 目的: その日実際に売れた商品別出数(実績)を店舗ごとに毎日取得し「実績出数ログ」へ書込み、
 * 「予算・実績」の「実績」列（現在選択中の店舗の合計金額）も自動更新する。
 * 対象店舗は「予算・実績」シート C1(見出し)/D1(プルダウン)で選択する
 * （メニュー「スマレジ店舗一覧を更新」で店舗一覧をD1に反映してから選ぶ）。
 * 商品名のクレンジング・集計は sheetActions.gs の aggregateCleanedSalesRows_ をそのまま流用する。
 *
 * 事前準備（このファイルのコードだけでは完結しない）:
 * 1. Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティに
 *    POS_CLIENT_ID / POS_CLIENT_SECRET を設定（値はコードに書かない）
 * 2. スマレジ・デベロッパーズのアプリ設定で pos.transactions:read / pos.stores:read スコープを有効化
 * 3. メニュー「発注管理」→「スマレジ店舗一覧を更新」を実行し、予算・実績 D1 で対象店舗を選択
 * 4. メニュー「発注管理」→「スマレジ日次自動取得トリガーを設定」を一度だけ実行
 *
 * 既知の未対応事項: 返品取引(returnSales=1)は現状 fetchSmaregiTransactions_ の
 * 集計対象から特に区別していない（通常取引をそのまま合算）。返品が多い店舗では
 * 実データで実績と突き合わせて要検証。
 */

const ACTUAL_SALES_LOG_HEADERS_ = ["日付", "店舗", "統一商品名", "販売点数", POS_SALES_HEADER_EX_TAX];

/** 対象店舗を選択する予算・実績シートのセル */
const SMAREGI_STORE_LABEL_CELL_ = "C1";
const SMAREGI_STORE_DROPDOWN_CELL_ = "D1";

/** スクリプトプロパティからクライアント資格情報を読む（未設定ならエラー） */
const getSmaregiCredentials_ = () => {
  let props = PropertiesService.getScriptProperties();
  let clientId = props.getProperty("POS_CLIENT_ID");
  let clientSecret = props.getProperty("POS_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "スクリプトプロパティに POS_CLIENT_ID / POS_CLIENT_SECRET が設定されていません。"
      + "プロジェクトの設定 → スクリプトプロパティ から登録してください。"
    );
  }
  return { clientId: clientId, clientSecret: clientSecret };
};

/**
 * 外部API連携のトークンキャッシュ管理（スマレジ専用ではなく汎用ユーティリティ）
 * 今後別のAPI連携を追加する際も rememberApiTokenCacheKey_ でキーを記録しておけば、
 * clearApiTokenCaches() で認証情報・スコープ変更後の再認証がまとめて行える。
 */
const API_TOKEN_CACHE_KEYS_PROP_ = "API_TOKEN_CACHE_KEYS";

/** キャッシュにトークンを保存する際、後で一括クリアできるようキー名を記録しておく */
const rememberApiTokenCacheKey_ = (cacheKey) => {
  let props = PropertiesService.getScriptProperties();
  let raw = props.getProperty(API_TOKEN_CACHE_KEYS_PROP_);
  let keys = raw ? JSON.parse(raw) : [];
  if (keys.indexOf(cacheKey) === -1) {
    keys.push(cacheKey);
    props.setProperty(API_TOKEN_CACHE_KEYS_PROP_, JSON.stringify(keys));
  }
};

/**
 * 記録済みのAPIトークンキャッシュを一括クリア（メニュー・エディタどちらからも実行可能）
 * クライアントID/シークレットの変更、スコープ追加、権限エラーの再現テストなどの後に使う。
 */
function clearApiTokenCaches() {
  let props = PropertiesService.getScriptProperties();
  let raw = props.getProperty(API_TOKEN_CACHE_KEYS_PROP_);
  let keys = raw ? JSON.parse(raw) : [];
  if (keys.length === 0) {
    notifyUser("クリア対象のAPIトークンキャッシュはありません。");
    return;
  }
  CacheService.getScriptCache().removeAll(keys);
  props.deleteProperty(API_TOKEN_CACHE_KEYS_PROP_);
  notifyUser(`APIトークンキャッシュをクリアしました（${keys.length}件）。`);
}

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
  rememberApiTokenCacheKey_(cacheKey);
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

/** 店舗一覧を取得（GET /stores、ページング対応） */
const getSmaregiStores_ = () => {
  let token = getSmaregiAccessToken_("pos.stores:read");
  let baseUrl = `${SMAREGI_CONFIG.apiBase}/${SMAREGI_CONFIG.contractId}/pos/stores`;
  let stores = [];
  let limit = 100;

  for (let page = 1; page <= 10; page++) {
    let res = UrlFetchApp.fetch(`${baseUrl}?limit=${limit}&page=${page}`, {
      method: "get",
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    let code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(`スマレジ店舗一覧取得API失敗 status=${code} body=${res.getContentText().slice(0, 500)}`);
    }
    let pageStores = extractSmaregiListFromResponse_(JSON.parse(res.getContentText() || "[]"));
    if (pageStores.length === 0) break;
    stores = stores.concat(pageStores);
    if (pageStores.length < limit) break;
  }
  return stores;
};

/** 予算・実績 D1 の表示値（例: "1: 渋谷店"）を storeId/storeName に分解 */
const parseSmaregiStoreCellValue_ = (cellValue) => {
  let s = String(cellValue == null ? "" : cellValue).trim();
  let m = s.match(/^([0-9]+)\s*[:：]/);
  if (!m) return null;
  return { storeId: m[1], storeName: s.slice(m[0].length).trim() };
};

/** 予算・実績 D1 から選択中の店舗を解決（未選択ならエラー） */
const resolveSelectedSmaregiStore_ = (budgetSheet) => {
  if (!budgetSheet) {
    throw new Error(`「${SHEET_NAMES.BUDGET_ACTUAL}」シートが見つかりません。`);
  }
  let raw = budgetSheet.getRange(SMAREGI_STORE_DROPDOWN_CELL_).getValue();
  let parsed = parseSmaregiStoreCellValue_(raw);
  if (!parsed) {
    throw new Error(
      `「${SHEET_NAMES.BUDGET_ACTUAL}」の${SMAREGI_STORE_DROPDOWN_CELL_}で対象店舗が選択されていません。`
      + "先にメニュー「スマレジ店舗一覧を更新」を実行してから選択してください。"
    );
  }
  return parsed;
};

/**
 * スマレジの店舗一覧を取得し、予算・実績 C1(見出し)/D1(プルダウン) を整備する（メニューから手動実行）
 * D1 の選択肢は "storeId: storeName" 形式。既存の選択値が一覧に残っていればそのまま維持する。
 */
const setupSmaregiStoreDropdown_ = () => {
  let stores = getSmaregiStores_();
  if (stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。");
    return;
  }

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  if (!budgetSheet) {
    throw new Error(`「${SHEET_NAMES.BUDGET_ACTUAL}」シートが見つかりません。`);
  }

  let options = stores.map((s) => { return `${s.storeId}: ${s.storeName}`; });
  let labelCell = budgetSheet.getRange(SMAREGI_STORE_LABEL_CELL_);
  let dropdownCell = budgetSheet.getRange(SMAREGI_STORE_DROPDOWN_CELL_);

  labelCell.setValue("対象店舗");

  let rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(options, true)
    .setAllowInvalid(false)
    .build();
  dropdownCell.setDataValidation(rule);

  let current = String(dropdownCell.getValue() || "").trim();
  if (options.indexOf(current) === -1) {
    dropdownCell.setValue(options[0]);
  }

  notifyUser(`スマレジ店舗一覧を更新しました（${stores.length}件）。「${SHEET_NAMES.BUDGET_ACTUAL}」${SMAREGI_STORE_DROPDOWN_CELL_}で対象店舗を選択してください。`);
};

/**
 * 指定日(JST 00:00〜23:59:59)・指定店舗の取引を取得
 * 通常取引(transactionHeadDivision=1)かつ取消でない(cancelDivision=0)ものだけを対象にする。
 * 明細(details)だけでなく取引ヘッダーの total（レジ側で確定済みの合計金額）も保持し、
 * 金額集計は明細行の再計算ではなくこの total の合計を使う（丸め誤差の蓄積を避けるため）。
 */
const fetchSmaregiTransactions_ = (dateStr, storeId) => {
  let token = getSmaregiAccessToken_("pos.transactions:read");
  let fromIso = `${dateStr}T00:00:00+09:00`;
  let toIso = `${dateStr}T23:59:59+09:00`;
  let baseUrl = `${SMAREGI_CONFIG.apiBase}/${SMAREGI_CONFIG.contractId}/pos/transactions`;

  let allTransactions = [];
  let limit = 100;
  let maxPages = 50; // 安全弁（1日あたり最大5000取引を想定。想定外の応答形式での無限ループを防ぐ）

  for (let page = 1; page <= maxPages; page++) {
    let url = baseUrl
      + `?transaction_date_time-from=${encodeURIComponent(fromIso)}`
      + `&transaction_date_time-to=${encodeURIComponent(toIso)}`
      + (storeId ? `&store_id=${encodeURIComponent(storeId)}` : "")
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
      allTransactions.push(t);
    });

    if (transactions.length < limit) break;
  }

  return allTransactions;
};

/**
 * 実績出数ログの見出しを用意（無ければ新規シート作成）
 * 見出し行全体を期待値と比較し、1列でもズレていれば書き直す
 * （A1の"日付"だけを見ていると、列追加（例: 店舗列）で見出しとデータがズレたまま気づけない）
 */
const ensureActualSalesLogSheet_ = (ss) => {
  let sheet = ss.getSheetByName(SHEET_NAMES.ACTUAL_SALES_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.ACTUAL_SALES_LOG);
    Logger.log(`[スマレジ] シート「${SHEET_NAMES.ACTUAL_SALES_LOG}」を新規作成`);
  }
  let currentHeaders = sheet.getRange(1, 1, 1, ACTUAL_SALES_LOG_HEADERS_.length).getValues()[0]
    .map((v) => { return String(v == null ? "" : v).trim(); });
  let matches = ACTUAL_SALES_LOG_HEADERS_.every((h, i) => { return currentHeaders[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, ACTUAL_SALES_LOG_HEADERS_.length).setValues([ACTUAL_SALES_LOG_HEADERS_]);
    Logger.log(`[スマレジ] 「${SHEET_NAMES.ACTUAL_SALES_LOG}」の見出し行を更新しました`);
  }
  return sheet;
};

/** 指定日付+店舗の既存行を削除し、集計済み行に置き換える（同日同店舗の再取得は上書き。他店舗は保持） */
const writeActualSalesLogForDate_ = (sheet, dateStr, storeId, aggregatedRows) => {
  let lastRow = sheet.getLastRow();
  let keptRows = [];
  if (lastRow >= 2) {
    let existing = sheet.getRange(2, 1, lastRow - 1, ACTUAL_SALES_LOG_HEADERS_.length).getValues();
    keptRows = existing.filter((row) => {
      return !(formatSheetDateToKey(row[0]) === dateStr && String(row[1]) === String(storeId));
    });
  }

  let newRows = (aggregatedRows || []).map((r) => {
    return [dateStr, storeId, r.menuName, r.salesQty, r.salesAmount];
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
 * 指定日・指定店舗のスマレジ実績を取得し「実績出数ログ」へ書込み、「予算・実績」の実績列も更新する
 * （実績列は店舗区分を持たないため、現在選択中の店舗の合計金額でそのまま上書きする）
 *
 * 金額合計は明細行(unitDiscountedSum)の再計算ではなく、取引ヘッダーの total（レジ側で
 * 確定済みの合計金額）を合算して使う。明細の税抜換算を1行ずつ行うと端数処理が積み重なり
 * 実際のPOS集計とズレるため、合計は取引単位でまとめてから1回だけ税抜換算する。
 * 商品別の内訳（実績出数ログ用の数量・按分金額）は引き続き明細行から作る。
 */
const importSmaregiDailyActuals_ = (dateStr, store) => {
  let transactions = fetchSmaregiTransactions_(dateStr, store.storeId);

  let details = [];
  let totalIncTax = 0;
  transactions.forEach((t) => {
    (t.details || []).forEach((d) => { details.push(d); });
    totalIncTax += Number(t.total) || 0;
  });

  let rows = details.map((d) => {
    return { rawName: d.productName, qty: d.quantity, salesIncTax: d.unitDiscountedSum };
  });
  let aggregated = aggregateCleanedSalesRows_(rows);

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ensureActualSalesLogSheet_(ss);
  writeActualSalesLogForDate_(logSheet, dateStr, store.storeId, aggregated);

  let totalAmount = convertPosSalesToExTax(totalIncTax);
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let budgetWritten = budgetSheet ? writeBudgetRatioAtDate_(budgetSheet, dateStr, "実績", totalAmount) : false;

  notifyUser(
    `スマレジ実績取込完了 [${dateStr} / ${store.storeName || store.storeId}]: ${aggregated.length}商品 / 合計${Math.round(totalAmount).toLocaleString()}円`
    + (budgetWritten ? "（予算・実績「実績」列を更新）" : "（予算・実績: 対象日の行が見つからず書込みスキップ）")
  );

  return { dateStr: dateStr, storeId: store.storeId, productCount: aggregated.length, totalAmount: totalAmount };
};

/** 当日分を取得（メニューからの手動再取得用。営業終了間際までの実績を取り込む） */
const runSmaregiDailyAutoImport = () => {
  let budgetSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  importSmaregiDailyActuals_(formatJstDate_(new Date()), store);
};

/**
 * 毎晩22:45ごろの時間トリガー本体: 当日分のスマレジ実績を取り込み、
 * その実績を使って翌日の仕込み・発注指示を計算し指示書へ反映する。
 * 例: 22:45に7/1の実績を取込→指示書B2を7/2に設定→7/2の計算を実行。
 */
const runDailyPosImportAndPlanNextDay = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let store = resolveSelectedSmaregiStore_(budgetSheet);

  let today = formatJstDate_(new Date());
  importSmaregiDailyActuals_(today, store);

  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  if (!orderSheet) {
    throw new Error(`「${SHEET_NAMES.ORDER_FORM}」シートが見つかりません。`);
  }
  let tomorrow = addDaysToDateStr_(today, 1);
  orderSheet.getRange("B2").setValue(new Date(`${tomorrow}T12:00:00`));

  runSimulationPipeline();
};

/** 日付を指定して手動再取得（空欄なら本日、対象店舗は予算・実績 D1 の選択に従う） */
const promptAndImportSmaregiActuals_ = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let store = resolveSelectedSmaregiStore_(budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());
  let res = ui.prompt(
    "スマレジ実績取得",
    `対象店舗: ${store.storeName || store.storeId}\n対象日を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let input = String(res.getResponseText() || "").trim();
  let dateStr = input || today;
  if (isNaN(new Date(`${dateStr}T12:00:00`).getTime())) {
    ui.alert(`日付の形式が正しくありません: ${input}`);
    return;
  }
  importSmaregiDailyActuals_(dateStr, store);
};

const SMAREGI_DAILY_TRIGGER_HANDLER_ = "runDailyPosImportAndPlanNextDay";
/** 過去バージョンのトリガーハンドラ名（残っていたら置き換える） */
const SMAREGI_DAILY_TRIGGER_LEGACY_HANDLERS_ = ["runSmaregiDailyAutoImport"];

/** 日次自動トリガーを設定（旧トリガーや重複があれば削除してから作り直す） */
const setupSmaregiDailyTrigger = () => {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    let fn = t.getHandlerFunction();
    if (fn === SMAREGI_DAILY_TRIGGER_HANDLER_ || SMAREGI_DAILY_TRIGGER_LEGACY_HANDLERS_.indexOf(fn) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger(SMAREGI_DAILY_TRIGGER_HANDLER_).timeBased().everyDays(1).atHour(22).nearMinute(45).create();
  notifyUser(
    "スマレジ日次自動取得トリガーを設定しました（毎日22:45ごろ、当日分の実績取得→翌日の仕込み・発注計算まで自動実行）。"
    + (removed > 0 ? `既存トリガー${removed}件を置き換えました。` : "")
  );
};
