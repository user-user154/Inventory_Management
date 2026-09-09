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

/**
 * まだ運用（店舗別シート整備・原材料マスタ登録等）が完了していない業態は、
 * 夜間の全店舗自動実行（runDailyPosImportAndPlanNextDay）でPOSデータ取得の対象から除外する。
 * 準備が整い次第ここから名前を外せば自動的に対象に含まれるようになる。
 */
const SMAREGI_STORE_EXCLUDE_LIST_ = ["炊きたてあり〼"];

/**
 * 実績出数ログの保持日数。シミュレーション側が参照するのは商品別バイアス係数の
 * 遡り参照分（SALES_BIAS_LOOKBACK_DAYS_の2倍=28日、load.gs参照）だけなので、
 * 十分な余裕を持たせて90日にしている。これを超える古い行はwriteActualSalesLogForDate_の
 * たびに削除する（元データはスマレジ側に残るため、必要なら「スマレジ実績を再取得」で戻せる）。
 * 無制限に増え続けると、毎晩・店舗ごとに発生する全件読み書きがどんどん重くなるため。
 */
const ACTUAL_SALES_LOG_RETENTION_DAYS_ = 90;

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
 * スマレジの店舗一覧を取得し、対象店舗（アクティブなタブ）の予算・実績 C1(見出し)/D1(プルダウン) を
 * 整備する（メニューから手動実行。対象店舗の予算・実績等のタブを開いてから実行すること）。
 * D1 の選択肢は "storeId: storeName" 形式。既存の選択値が一覧に残っていればそのまま維持する。
 */
const setupSmaregiStoreDropdown = () => {
  let stores = getSmaregiStores_();
  if (stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。");
    return;
  }

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
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

/**
 * 指定日付+店舗の既存行を削除し、集計済み行に置き換える（同日同店舗の再取得は上書き。他店舗は保持）
 * 併せて ACTUAL_SALES_LOG_RETENTION_DAYS_ より古い行もここで削除し、シートが無制限に
 * 肥大化しないようにする（古いほど毎晩の全件読み書きコストが増えるため）。
 */
const writeActualSalesLogForDate_ = (sheet, dateStr, storeId, aggregatedRows) => {
  let lastRow = sheet.getLastRow();
  let keptRows = [];
  if (lastRow >= 2) {
    let retentionCutoff = addDaysToDateStr_(dateStr, -ACTUAL_SALES_LOG_RETENTION_DAYS_);
    let existing = sheet.getRange(2, 1, lastRow - 1, ACTUAL_SALES_LOG_HEADERS_.length).getValues();
    keptRows = existing.filter((row) => {
      let rowDateStr = formatSheetDateToKey(row[0]);
      if (rowDateStr === dateStr && String(row[1]) === String(storeId)) return false; // 同日同店舗は置き換え
      if (rowDateStr && rowDateStr < retentionCutoff) return false; // 保持期間切れ
      return true;
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
 *
 * @param {string} dateStr
 * @param {object} store {storeId, storeName}
 * @param {Sheet} [budgetSheetOverride] 明示的に対象店舗の予算・実績シートを指定する場合
 *   （夜間トリガーなど「アクティブシート」が無い文脈から店舗ループで呼ぶ用）。
 *   未指定時はアクティブシートから解決する（メニューからの手動実行用）。
 */
const importSmaregiDailyActuals_ = (dateStr, store, budgetSheetOverride) => {
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
  let budgetSheet = budgetSheetOverride || resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let budgetWritten = budgetSheet ? writeBudgetRatioAtDate_(budgetSheet, dateStr, "実績", totalAmount, "#,##0") : false;

  notifyUser(
    `スマレジ実績取込完了 [${dateStr} / ${store.storeName || store.storeId}]: ${aggregated.length}商品 / 合計${Math.round(totalAmount).toLocaleString()}円`
    + (budgetWritten ? "（予算・実績「実績」列を更新）" : "（予算・実績: 対象日の行が見つからず書込みスキップ）")
  );

  return { dateStr: dateStr, storeId: store.storeId, productCount: aggregated.length, totalAmount: totalAmount };
};

/** 当日分を取得（メニューからの手動再取得用。営業終了間際までの実績を取り込む。対象店舗のタブを開いてから実行） */
const runSmaregiDailyAutoImport = () => {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  importSmaregiDailyActuals_(formatJstDate_(new Date()), store, budgetSheet);
};

/**
 * 毎晩23:10ごろの時間トリガー本体: スマレジの全店舗について、各店舗ごとに
 * 当日分の実績を取り込み、その実績を使って翌日の仕込み・発注指示を計算し
 * その店舗の指示書へ反映する。例: 23:10に7/1の実績を取込→指示書B2を7/2に設定→7/2の計算を実行。
 * （22:45だと当日の遅い時間帯の取引が取りきれないケースがあったため23:10に変更）
 *
 * 店舗数が増えると全店舗を1回の実行でforEachした場合にGASの実行時間上限(6分)に達し、
 * ループの後方にいる店舗が未処理のまま打ち切られる（実績が抜け落ちる）不具合があったため、
 * 全店舗を1つの実行で回さず、店舗ごとに独立した実行（1店舗=1回のトリガー起動）へキュー化する。
 * この関数はキューを積んで最初のトリガーを起動するだけで即座に返り、実際の1店舗分の処理は
 * processSmaregiDailyQueueItem_ が担う。
 *
 * 時間トリガーには「アクティブシート」という概念が無いため、
 * resolveStoreSheetsFromActiveSheet_ には頼らず、店舗ごとに明示的にシートを解決する。
 * 「発注管理」→「店舗別シートを作成・整備」を先に実行し、各店舗の4シートを用意しておく必要がある
 * （未作成の店舗はスキップしてログに残し、他店舗の処理は継続する）。
 */
const SMAREGI_DAILY_QUEUE_PROP_KEY_ = "SMAREGI_DAILY_QUEUE_V1";
const SMAREGI_DAILY_QUEUE_TRIGGER_HANDLER_ = "processSmaregiDailyQueueItem_";
/** 店舗間の間隔。各店舗を別実行にすることでタイムアウト・時間上限の影響を1店舗分だけに閉じ込める */
const SMAREGI_DAILY_QUEUE_STEP_DELAY_MS_ = 5000;

const runDailyPosImportAndPlanNextDay = () => {
  let stores = getSmaregiStores_();
  if (!stores || stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。");
    return;
  }

  let today = formatJstDate_(new Date());
  let tomorrow = addDaysToDateStr_(today, 1);
  let queue = stores
    .map((s) => ({ storeId: s.storeId, storeName: String(s.storeName || "").trim() }))
    .filter((s) => SMAREGI_STORE_EXCLUDE_LIST_.indexOf(s.storeName) === -1);

  if (queue.length === 0) {
    notifyUser("対象店舗が0件でした（除外リストで全店舗が対象外になっていないか確認してください）。");
    return;
  }

  // 前回実行が途中で止まっていた場合に備え、古いキュー用トリガーを削除してから積み直す
  clearSmaregiDailyQueueTriggers_();
  // 共有マスタのキャッシュも今回分として作り直す（直前の編集を確実に反映するため、前回分は破棄）
  clearSharedSimulationMastersCache_();

  let state = { today: today, tomorrow: tomorrow, queue: queue, succeeded: [], failed: [] };
  PropertiesService.getScriptProperties().setProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_, JSON.stringify(state));

  ScriptApp.newTrigger(SMAREGI_DAILY_QUEUE_TRIGGER_HANDLER_).timeBased().after(1000).create();
  notifyUser(`日次自動実行を開始しました（対象${queue.length}店舗・店舗ごとに順次処理。完了時に改めて通知します）`, "日次自動実行");
};

/**
 * 夜間キューの先頭1店舗だけを処理し、残っていれば次のトリガーを作って自分は削除する
 * （1店舗=1回のGAS実行に閉じ込めることで、店舗数が増えても実行時間上限に達しないようにする）
 */
const processSmaregiDailyQueueItem_ = (e) => {
  deleteSmaregiDailyQueueTriggerForEvent_(e);

  let props = PropertiesService.getScriptProperties();
  let raw = props.getProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_);
  if (!raw) return; // 別実行で既に完了・削除済み

  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    props.deleteProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_);
    Logger.log(`[日次自動実行] キュー破損のため中断: ${err.message}`);
    return;
  }

  if (!state.queue || state.queue.length === 0) {
    props.deleteProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_);
    finishSmaregiDailyQueue_(state);
    return;
  }

  let store = state.queue.shift();
  try {
    processOneStoreForDailyQueue_(state, store);
    state.succeeded.push(store.storeName || store.storeId);
  } catch (err) {
    state.failed.push(`${store.storeName || store.storeId}: ${err.message}`);
    Logger.log(`[日次自動実行] 店舗「${store.storeName || store.storeId}」失敗: ${err.message}`);
  }

  if (state.queue.length > 0) {
    props.setProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_, JSON.stringify(state));
    ScriptApp.newTrigger(SMAREGI_DAILY_QUEUE_TRIGGER_HANDLER_)
      .timeBased().after(SMAREGI_DAILY_QUEUE_STEP_DELAY_MS_).create();
  } else {
    props.deleteProperty(SMAREGI_DAILY_QUEUE_PROP_KEY_);
    finishSmaregiDailyQueue_(state);
  }
};

/** 1店舗分: 当日実績の取込→翌日への月自動切替→指示書日付更新→翌日分の計算実行 */
const processOneStoreForDailyQueue_ = (state, store) => {
  let storeName = String(store.storeName || "").trim();
  if (!storeName) throw new Error(`storeId=${store.storeId} は店舗名が空です`);

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let storeSheets = resolveStoreSheetsByStoreName_(ss, storeName);
  if (!storeSheets.orderSheet || !storeSheets.budgetSheet || !storeSheets.backlogSheet) {
    throw new Error(`店舗別シート未作成です（「発注管理」→「店舗別シートを作成・整備」を先に実行してください）`);
  }

  // 当日分の実績は今日の月のD2のまま書き込み、その後に翌日分の月へ自動で切り替える
  // （月末の最終日はここで翌月に進む。予算未入力の日は buildSimulationContext 側の推定で埋める）
  importSmaregiDailyActuals_(state.today, store, storeSheets.budgetSheet);

  // 発注バックログ取得元がInfomartの場合、本日ぶんの発注実績をシミュレーション実行前に反映しておく
  // （Infomartのrequest→check→getは10〜60秒かかるため、シミュレーション中に都度呼ばずここで先に済ませる）。
  // 失敗しても実績取込・シミュレーション自体は継続する（PFID未登録店舗や一時的なAPI不調で
  // 夜間バッチ全体が止まらないようにするため）。
  if (getInfomartOrderBacklogSource_() === "infomart") {
    try {
      importInfomartOrderBacklogForDate_(state.today, storeName);
    } catch (err) {
      Logger.log(`[日次自動実行] 店舗「${storeName}」Infomart発注バックログ取込に失敗（継続します）: ${err.message}`);
    }
  }

  advanceBudgetStartDateIfNeeded_(storeSheets.budgetSheet, state.tomorrow);
  storeSheets.orderSheet.getRange("B2").setValue(new Date(`${state.tomorrow}T12:00:00`));
  // 各店舗が別々のGAS実行になるため、共有マスタはCacheServiceで使い回す
  // （1店舗目がロード＆キャッシュし、以降の店舗はシート読み込み無しで再利用する）
  let sharedMasters = loadSharedSimulationMastersCached_(ss);
  runSimulationPipeline(storeSheets, sharedMasters);
};

const finishSmaregiDailyQueue_ = (state) => {
  notifyUser(
    `日次自動実行完了: 成功${state.succeeded.length}店舗（${state.succeeded.join(", ")}）`
    + (state.failed.length > 0 ? ` / 失敗${state.failed.length}店舗（${state.failed.join(" / ")}）` : ""),
    "日次自動実行"
  );
};

/** 前回実行が途中で止まった場合などに残る古いキュー処理用トリガーを削除 */
const clearSmaregiDailyQueueTriggers_ = () => {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === SMAREGI_DAILY_QUEUE_TRIGGER_HANDLER_) {
      ScriptApp.deleteTrigger(t);
    }
  });
};

/** 今しがた発火したトリガー自身だけを削除（イベントにtriggerUidが無い場合は同名トリガーを全削除） */
const deleteSmaregiDailyQueueTriggerForEvent_ = (e) => {
  if (!e || !e.triggerUid) {
    clearSmaregiDailyQueueTriggers_();
    return;
  }
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getUniqueId() === e.triggerUid) ScriptApp.deleteTrigger(t);
  });
};

/** 日付を指定して手動再取得（空欄なら本日、対象店舗は開いているタブの予算・実績 D1 の選択に従う） */
const promptAndImportSmaregiActuals = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
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
  importSmaregiDailyActuals_(dateStr, store, budgetSheet);
};

/**
 * 開始日〜指定期日（未入力なら本日）を1日ずつ importSmaregiDailyActuals_ で取り直す（取得漏れの手当て用）。
 * 例: 取得トリガーの時刻変更前に取りきれていなかった期間を、開始日・終了日を指定してまとめて再取得する。
 * 対象店舗は promptAndImportSmaregiActuals と同じく開いているタブの予算・実績 D1 の選択に従う。
 * 1日ごとにAPIを叩き直すため、対象日数が多いと実行時間がかかる（GASの実行時間上限に注意）。
 */
const promptAndBackfillSmaregiActuals = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let store = resolveSelectedSmaregiStore_(budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());

  let startRes = ui.prompt(
    "スマレジ実績 再取得（期間を1日ずつ）",
    `対象店舗: ${store.storeName || store.storeId}\n開始日を yyyy-MM-dd で入力してください`,
    ui.ButtonSet.OK_CANCEL
  );
  if (startRes.getSelectedButton() !== ui.Button.OK) return;
  let startInput = String(startRes.getResponseText() || "").trim();
  if (!startInput || isNaN(new Date(`${startInput}T12:00:00`).getTime())) {
    ui.alert(`開始日の形式が正しくありません: ${startInput}`);
    return;
  }

  let endRes = ui.prompt(
    "スマレジ実績 再取得（期間を1日ずつ）",
    `終了日（指定期日）を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (endRes.getSelectedButton() !== ui.Button.OK) return;
  let endInput = String(endRes.getResponseText() || "").trim();
  let endStr = endInput || today;
  if (isNaN(new Date(`${endStr}T12:00:00`).getTime())) {
    ui.alert(`終了日の形式が正しくありません: ${endInput}`);
    return;
  }

  if (startInput > endStr) {
    ui.alert(`開始日（${startInput}）が終了日（${endStr}）より後になっています。`);
    return;
  }

  runSmaregiBackfillActuals_(startInput, endStr, store, budgetSheet);
};

/** startStr〜endStr（両端含む・yyyy-MM-dd）を1日ずつ再取得。1日分の失敗は握りつぶさず記録し、次の日へ続行する */
const runSmaregiBackfillActuals_ = (startStr, endStr, store, budgetSheet) => {
  let succeeded = [];
  let failed = [];
  let cursor = startStr;
  while (cursor <= endStr) {
    try {
      importSmaregiDailyActuals_(cursor, store, budgetSheet);
      succeeded.push(cursor);
    } catch (err) {
      failed.push(`${cursor}: ${err.message}`);
      Logger.log(`[スマレジ再取得] ${cursor} 失敗: ${err.message}`);
    }
    Utilities.sleep(300);
    cursor = addDaysToDateStr_(cursor, 1);
  }

  notifyUser(
    `スマレジ実績 再取得完了 [${store.storeName || store.storeId}] ${startStr}〜${endStr}: 成功${succeeded.length}日`
    + (failed.length > 0 ? ` / 失敗${failed.length}日（${failed.join(", ")}）` : ""),
    "スマレジ再取得"
  );
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

  ScriptApp.newTrigger(SMAREGI_DAILY_TRIGGER_HANDLER_).timeBased().everyDays(1).atHour(23).nearMinute(25).create();
  notifyUser(
    "スマレジ日次自動取得トリガーを設定しました（毎日23:25ごろ、当日分の実績取得→翌日の仕込み・発注計算まで自動実行）。"
    + (removed > 0 ? `既存トリガー${removed}件を置き換えました。` : "")
  );
};

/**
 * 毎朝5:00ごろの時間トリガー本体: 前日分のスマレジ実績を全店舗で取り直し、
 * 「予算・実績」実績列の現在値とズレていれば上書きする（答え合わせ）。
 * POS側の後編集・取消の反映タイミングのズレなどで、23:25の夜間取込み時点では
 * まだ確定していなかった実績が、翌朝までに変わっていることがあるための保険。
 * importSmaregiDailyActuals_ 自体は常に上書きするため、ここでは実行前の値を控えておき、
 * 実行後の値と比較して「実際にズレていた店舗」だけをまとめの通知に出す。
 */
const runYesterdayPosVerifyAndFix = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stores = getSmaregiStores_();
  if (!stores || stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。", "前日実績の答え合わせ");
    return;
  }

  let yesterday = addDaysToDateStr_(formatJstDate_(new Date()), -1);
  let corrected = [];
  let failed = [];

  stores.forEach((store) => {
    let storeName = String(store.storeName || "").trim();
    try {
      if (!storeName) throw new Error(`storeId=${store.storeId} は店舗名が空です`);
      let storeSheets = resolveStoreSheetsByStoreName_(ss, storeName);
      if (!storeSheets.budgetSheet) {
        throw new Error("店舗別シート未作成です（「発注管理」→「店舗別シートを作成・整備」を先に実行してください）");
      }

      let before = readBudgetActualAtDate_(storeSheets.budgetSheet, yesterday);
      let result = importSmaregiDailyActuals_(yesterday, store, storeSheets.budgetSheet);

      if (before == null || Math.abs(before - result.totalAmount) >= 1) {
        let beforeLabel = before == null ? "(空欄)" : `${Math.round(before).toLocaleString()}円`;
        corrected.push(`${storeName}: ${beforeLabel} → ${Math.round(result.totalAmount).toLocaleString()}円`);
      }
    } catch (err) {
      failed.push(`${storeName || store.storeId}: ${err.message}`);
      Logger.log(`[前日実績の答え合わせ] 店舗「${storeName || store.storeId}」失敗: ${err.message}`);
    }
  });

  notifyUser(
    `前日(${yesterday})実績の答え合わせ完了: `
    + (corrected.length > 0 ? `ズレを修正${corrected.length}店舗（${corrected.join(" / ")}）` : "全店舗ズレなし")
    + (failed.length > 0 ? ` / 失敗${failed.length}店舗（${failed.join(" / ")}）` : ""),
    "前日実績の答え合わせ"
  );
};

const SMAREGI_VERIFY_TRIGGER_HANDLER_ = "runYesterdayPosVerifyAndFix";

/** 前日実績の答え合わせトリガーを設定（毎朝5:00ごろ。旧トリガーや重複があれば削除してから作り直す） */
const setupSmaregiVerifyTrigger = () => {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === SMAREGI_VERIFY_TRIGGER_HANDLER_) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger(SMAREGI_VERIFY_TRIGGER_HANDLER_).timeBased().everyDays(1).atHour(5).nearMinute(0).create();
  notifyUser(
    "前日実績の答え合わせトリガーを設定しました（毎朝5:00ごろ、前日分のスマレジ実績を再取得しズレがあれば上書き）。"
    + (removed > 0 ? `既存トリガー${removed}件を置き換えました。` : "")
  );
};

// ---------------------------------------------------------------------------
// 商品構成比レポート（店舗別・月次比較。実績出数ログの蓄積分から集計）
// ---------------------------------------------------------------------------

const SALES_MIX_REPORT_HEADERS_ = [
  "統一商品名", "対象月_販売点数", "対象月_構成比", "比較月_販売点数", "比較月_構成比", "構成比差分(pt)"
];

/**
 * 基準日から「対象月（前月）」「比較月（前々月）」を暦月（月初〜月末）で解決する。
 * 月初のトリガーで「締まったばかりの前月」を「その前の月」と比較する運用を想定。
 */
const resolveSalesMixReportMonths_ = (referenceDate) => {
  let ref = referenceDate ? new Date(referenceDate) : new Date();

  const monthRange = (yearsAgoMonths) => {
    let d = new Date(ref.getFullYear(), ref.getMonth() - yearsAgoMonths, 1);
    let from = new Date(d.getFullYear(), d.getMonth(), 1);
    let to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return {
      fromStr: formatJstDate_(from),
      toStr: formatJstDate_(to),
      label: formatBudgetYearMonthLabel_(d.getFullYear(), d.getMonth())
    };
  };

  return { target: monthRange(1), compare: monthRange(2) };
};

/**
 * 実績出数ログ全体を1回だけ読み込み、店舗×期間(target/compare)×商品ごとの販売点数へ集計する。
 * 店舗ごとに毎回シート全体を読み直すと（店舗数×2回）、ログが大きい場合に
 * スプレッドシートサービスがタイムアウトすることがあったための一括集計版。
 * @return {{ [storeId]: { target: {totals, grandTotal}, compare: {totals, grandTotal} } }}
 */
const aggregateSalesMixForAllStores_ = (logSheet, storeIds, target, compare) => {
  let result = {};
  storeIds.forEach((storeId) => {
    result[storeId] = {
      target: { totals: {}, grandTotal: 0 },
      compare: { totals: {}, grandTotal: 0 }
    };
  });
  if (!logSheet) return result;

  let lastRow = logSheet.getLastRow();
  if (lastRow < 2) return result;

  let values = logSheet.getRange(2, 1, lastRow - 1, ACTUAL_SALES_LOG_HEADERS_.length).getValues();
  values.forEach((row) => {
    let bucket = result[String(row[1])];
    if (!bucket) return; // 対象店舗以外の行は無視

    let rowDateStr = formatSheetDateToKey(row[0]);
    let periodKey = null;
    if (rowDateStr && rowDateStr >= target.fromStr && rowDateStr <= target.toStr) periodKey = "target";
    else if (rowDateStr && rowDateStr >= compare.fromStr && rowDateStr <= compare.toStr) periodKey = "compare";
    if (!periodKey) return;

    let name = String(row[2] || "").trim();
    let qty = Number(row[3]) || 0;
    if (!name || qty === 0) return;

    let agg = bucket[periodKey];
    agg.totals[name] = (agg.totals[name] || 0) + qty;
    agg.grandTotal += qty;
  });

  return result;
};

/** 対象月・比較月それぞれの構成比を商品ごとに並べる（対象月の構成比が大きい順） */
const buildSalesMixComparisonRows_ = (targetAgg, compareAgg) => {
  let names = {};
  Object.keys(targetAgg.totals).forEach((n) => { names[n] = true; });
  Object.keys(compareAgg.totals).forEach((n) => { names[n] = true; });

  let rows = Object.keys(names).map((name) => {
    let tQty = targetAgg.totals[name] || 0;
    let cQty = compareAgg.totals[name] || 0;
    let tRatio = targetAgg.grandTotal > 0 ? tQty / targetAgg.grandTotal : 0;
    let cRatio = compareAgg.grandTotal > 0 ? cQty / compareAgg.grandTotal : 0;
    return [name, tQty, tRatio, cQty, cRatio, (tRatio - cRatio) * 100];
  });

  rows.sort((a, b) => { return b[2] - a[2]; });
  return rows;
};

/** 商品構成比シートを用意（無ければ店舗別タブとして新規作成） */
const ensureSalesMixReportSheet_ = (ss, storeName) => {
  let sheetName = buildStoreSheetName_(SHEET_NAMES.SALES_MIX_REPORT, storeName);
  return ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
};

/** タイトル行（対象月・比較月・生成日時）＋見出し＋データを書き込む（毎回全消去して書き直す） */
const writeSalesMixReportSheet_ = (sheet, target, compare, rows) => {
  sheet.clearContents();
  sheet.getRange(1, 1).setValue(
    `対象月: ${target.label}（${target.fromStr}〜${target.toStr}） / 比較月: ${compare.label}（${compare.fromStr}〜${compare.toStr}） `
    + `生成日時: ${Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm")}`
  );
  sheet.getRange(2, 1, 1, SALES_MIX_REPORT_HEADERS_.length).setValues([SALES_MIX_REPORT_HEADERS_]);
  if (rows.length === 0) return;

  sheet.getRange(3, 1, rows.length, SALES_MIX_REPORT_HEADERS_.length).setValues(rows);
  sheet.getRange(3, 3, rows.length, 1).setNumberFormat("0.0%");
  sheet.getRange(3, 5, rows.length, 1).setNumberFormat("0.0%");
  sheet.getRange(3, 6, rows.length, 1).setNumberFormat("+0.0;-0.0");
};

/**
 * 全店舗ぶん、商品構成比レポート（対象月=前月 vs 比較月=前々月）を生成する（毎月1日ごろの自動トリガー本体）
 * 実績出数ログは一括で1回だけ読み込み、そこから対象月・比較月ぶんを店舗ごとに抽出する
 * （店舗数ぶん読み直すとログが大きい場合にスプレッドシートサービスがタイムアウトすることがあったため）。
 * 元データは実績出数ログ（90日保持）のため、比較月がその範囲外になっている場合は0件になる点に注意。
 */
const runMonthlySalesMixReportForAllStores = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stores = getSmaregiStores_();
  if (!stores || stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。", "商品構成比レポート");
    return;
  }

  let months = resolveSalesMixReportMonths_(new Date());
  let storeIds = stores.map((store) => { return String(store.storeId); });
  let logSheet = ss.getSheetByName(SHEET_NAMES.ACTUAL_SALES_LOG);
  let aggByStore = aggregateSalesMixForAllStores_(logSheet, storeIds, months.target, months.compare);

  let succeeded = [];
  let failed = [];

  stores.forEach((store) => {
    let storeName = String(store.storeName || "").trim();
    try {
      if (!storeName) throw new Error(`storeId=${store.storeId} は店舗名が空です`);
      let agg = aggByStore[String(store.storeId)];
      let rows = buildSalesMixComparisonRows_(agg.target, agg.compare);
      let sheet = ensureSalesMixReportSheet_(ss, storeName);
      writeSalesMixReportSheet_(sheet, months.target, months.compare, rows);
      succeeded.push(storeName);
    } catch (err) {
      failed.push(`${storeName || store.storeId}: ${err.message}`);
      Logger.log(`[商品構成比レポート] 店舗「${storeName || store.storeId}」失敗: ${err.message}`);
    }
  });

  notifyUser(
    `商品構成比レポート生成完了 [対象月=${months.target.label} / 比較月=${months.compare.label}]: `
    + `成功${succeeded.length}店舗（${succeeded.join(", ")}）`
    + (failed.length > 0 ? ` / 失敗${failed.length}店舗（${failed.join(" / ")}）` : ""),
    "商品構成比レポート"
  );
};

const SALES_MIX_REPORT_TRIGGER_HANDLER_ = "runMonthlySalesMixReportForAllStores";

/** 商品構成比レポートの月次トリガーを設定（毎月1日6:00ごろ。既存トリガーがあれば削除してから作り直す） */
const setupSalesMixReportTrigger = () => {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === SALES_MIX_REPORT_TRIGGER_HANDLER_) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger(SALES_MIX_REPORT_TRIGGER_HANDLER_).timeBased().onMonthDay(1).atHour(6).nearMinute(0).create();
  notifyUser(
    "商品構成比レポートの月次トリガーを設定しました（毎月1日6:00ごろ、前月と前々月の販売点数構成比を店舗別タブへ出力）。"
    + (removed > 0 ? `既存トリガー${removed}件を置き換えました。` : "")
  );
};
