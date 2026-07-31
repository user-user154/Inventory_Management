/**
 * 1. main.gs: シミュレーション全体の実行管理
 * 定数は constants.gs のみ（main に SHEET_NAMES 等を書かないこと）
 */

/**
 * スプレッドシートを開いたときにカスタムメニューを表示（PC用。スマホは指示書 A1/B1）
 * メニュー作成を最優先で行い、後続処理（権限が必要なトリガー確認など）が失敗してもメニューは必ず出るようにする。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("発注管理")
    .addItem("予算・実績の曜日を更新（対象店舗のタブを開いてから実行）", "syncBudgetWeekdaysFromD2")
    .addSeparator()
    .addItem("店舗別シートを作成・整備（予算実績/指示書/POS生/POS整形後/バックログ/AI調整ログ/予測出数ログ）", "setupPerStoreOperationSheets")
    .addItem("スマレジ店舗一覧を更新（対象店舗の予算・実績 D1）", "setupSmaregiStoreDropdown")
    .addItem("スマレジ実績を取得（当日分・対象店舗のタブを開いてから実行）", "runSmaregiDailyAutoImport")
    .addItem("スマレジ実績を取得（日付指定・対象店舗のタブを開いてから実行）", "promptAndImportSmaregiActuals")
    .addItem("スマレジ実績を再取得（期間を1日ずつ・対象店舗のタブを開いてから実行）", "promptAndBackfillSmaregiActuals")
    .addItem("日次原価率だけ再計算（期間を1日ずつ・バックログ/指示書は変更しません）", "promptAndRecalculateDailyCostRatioRange")
    .addItem("実績取得→翌日の仕込み・発注計算を今すぐ実行（全店舗）", "runDailyPosImportAndPlanNextDay")
    .addItem("スマレジ日次自動取得トリガーを設定（全店舗を毎晩自動処理）", "setupSmaregiDailyTrigger")
    .addSeparator()
    .addItem("InfomartのPFIDを登録（対象店舗のタブを開いてから実行）", "promptInfomartCredentialRegistration")
    .addItem("Infomart請求書を取得（当日分・対象店舗のタブを開いてから実行）", "runInfomartInvoiceImportToday")
    .addItem("Infomart請求書を取得（日付指定・対象店舗のタブを開いてから実行）", "promptAndImportInfomartInvoices")
    .addItem("Infomart受発注データを取得（日付範囲指定・対象店舗のタブを開いてから実行）", "promptAndImportInfomartOrderDelivery")
    .addItem("onEdit連携トリガーを設定（長時間実行用・任意）", "setupOnEditInstallableTrigger")
    .addItem("祝日キャッシュを更新（1年分取得）", "runRefreshJapaneseHolidayCache")
    .addSeparator()
    .addItem("APIトークンキャッシュをクリア（デバッグ用）", "clearApiTokenCaches")
    .addItem("AIスナップショットのプロパティだけをクリア（デバッグ用・スクリプトプロパティ上限対策）", "runClearAiSnapshotProperties")
    .addItem("バックログ系データを一括削除（デバッグ用）", "resetBacklogRelatedHistory")
    .addToUi();

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  clearStaleCheckboxSkipProps_();
  // シンプルトリガーの onOpen からは ScriptApp.getProjectTriggers が権限エラーになるため、
  // ここで失敗してもメニュー表示やシート初期化を止めない。
  try {
    ensureOnEditInstallableTrigger_(ss);
  } catch (err) {
    Logger.log(`[onOpen] インストール型 onEdit の確認をスキップ: ${err.message}`);
  }

  // 元の固定名シート＋店舗別シートのすべてに対して初期化する（店舗別シート導入前の単一店舗運用にも対応）。
  ss.getSheets().forEach((sheet) => {
    let name = sheet.getName();
    if (isOrderFormSheetName_(name)) {
      setupOrderSheetActionControls_(sheet);
      setupOrderSheetManualInputArea(sheet);
      resetStuckOrderSheetCheckboxIfNeeded_(sheet);
    } else if (isBudgetActualSheetName_(name)) {
      setupBudgetStartDateDropdown_(sheet);
    }
  });
}

/**
 * 祝日キャッシュ（PropertiesService）を手動更新（メニュー・エディタどちらからも実行可能）
 * 通常はシミュレーション実行時に残り有効期間が少なくなると自動更新されるが、
 * 導入直後の初回取得や、任意タイミングでの更新確認に使う。
 */
function runRefreshJapaneseHolidayCache() {
  let cache = refreshJapaneseHolidayCache_(HOLIDAY_CACHE_FETCH_DAYS_);
  notifyUser(`祝日キャッシュを更新しました: ${cache.rangeStart}〜${cache.rangeEnd}（${cache.dates.length}件）`);
}

/**
 * @param {object} [storeSheets] 対象店舗の4シート一式（resolveStoreSheetsFromActiveSheet_ 等で解決済み）。
 *   未指定時はアクティブシートから解決する（メニュー・チェックボックス以外からの直接実行用）。
 * @param {object} [sharedMasters] loadSharedSimulationMasters_ の戻り値。夜間の全店舗バッチ
 *   （runDailyPosImportAndPlanNextDay）が店舗ループの外側で1回だけロードした共通マスタを渡すことで、
 *   店舗数ぶんの重複読み込みを避ける。未指定時はこれまで通りこの関数内でロードする。
 */
const runSimulationPipeline = (storeSheets, sharedMasters) => {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  storeSheets = storeSheets || resolveStoreSheetsFromActiveSheet_(ss);
  let runStarted = Date.now();

  // 1. シミュレーション条件の取得（指示書シートから読み込む）
  let orderSheet = storeSheets.orderSheet;
  if (!orderSheet) {
    throw new Error(`「${SHEET_NAMES.ORDER_FORM}」シートが見つかりません。`);
  }

  let configBlock = orderSheet.getRange("B2:F3").getValues();
  let rawDate = configBlock[0][0]; // B2 基準日
  let b3Days = configBlock[1][0]; // B3 期間フォールバック
  let averageSpend = configBlock[0][4]; // F2 客単価

  if (!rawDate || isNaN(new Date(rawDate).getTime())) {
    throw new Error("指示書シートのB2セルに有効な日付が入力されていません。");
  }

  let orderDate = new Date(rawDate); // 指示書 B2（計算したい基準日）
  let budgetSheet = storeSheets.budgetSheet;
  let period = "当日"; // 予算・実績 D1 は店舗選択に転用したため、期間は常に当日固定
  let stockSheet = resolveStockTakingSheet_(ss, storeSheets.storeName);
  let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
  let inventoryDate = (inventoryVal && !isNaN(new Date(inventoryVal).getTime())) ? new Date(inventoryVal) : null;

  // 在庫基準点は棚卸し表B1。数量は棚卸し表を優先し、B1が前日以前なら指示書日から理論在庫を進める。
  let orderDateStr = formatJstDate_(orderDate);
  let inventoryDateStr = inventoryDate ? formatJstDate_(inventoryDate) : null;
  let simStartDate = inventoryDate || getSimulationStartDate(orderDate, period);
  if (inventoryDate && inventoryDate.getTime() > orderDate.getTime()) {
    throw new Error(`棚卸し表B1（${formatJstDate_(inventoryDate)}）より前の日付を指示書B2（${formatJstDate_(orderDate)}）で計算しようとしています。B2 を棚卸し日以降にしてください。`);
  }
  if (inventoryDateStr && inventoryDateStr === addDaysToDateStr_(orderDateStr, -1)) {
    if (period === "当日") {
      simStartDate = new Date(orderDate.getTime());
    }
    Logger.log(`[run] 棚卸し前日基準: 在庫=${inventoryDateStr} 計算開始=${formatJstDate_(simStartDate)}（棚卸し優先・納品加算なし）`);
  }

  let vendorData = (sharedMasters && sharedMasters.vendorData)
    || loadSTVendorCalendar(ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER));
  let maxLt = getMaxVendorLeadTimeDaysFromData_(vendorData);
  let simDays = resolveSimulationDaysIncludingOrderDate(period, simStartDate, orderDate, b3Days, maxLt);
  Logger.log(`[run] D1期間=${period} B2=${formatJstDate_(orderDate)} 棚卸し基準=${formatJstDate_(simStartDate)} シミュレーション=${simDays}日`);

  // 2. コンテキスト（各マスタ・棚卸データ）のロード
  let contextStarted = Date.now();
  let ctx = buildSimulationContext(simStartDate, simDays, period, orderDate, {
    vendorData: vendorData,
    nameUnifyMap: sharedMasters && sharedMasters.nameUnifyMap,
    rawMaster: sharedMasters && sharedMasters.rawMaster,
    prepRecipes: sharedMasters && sharedMasters.prepRecipes,
    recipeMaster: sharedMasters && sharedMasters.recipeMaster,
    yieldMap: sharedMasters && sharedMasters.yieldMap,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend,
    storeSheets: storeSheets
  });
  ctx.orderDate = orderDate;
  Logger.log(`[run] buildSimulationContext 所要時間=${Date.now() - contextStarted}ms`);

  // 3. コア計算シミュレーションの実行（バックログの一括更新含む）
  let simulationStarted = Date.now();
  let simulationResults = executeCoreSimulation(ctx);
  Logger.log(`[run] executeCoreSimulation 所要時間=${Date.now() - simulationStarted}ms`);

  let costRatioRows = writeBudgetFoodCostRatios_(budgetSheet, simulationResults, ctx);

  let dayIdx = clampDayIndex_(
    getOrderSheetDayIndex(orderDate, period, simStartDate),
    simulationResults ? simulationResults.length : 0
  );

  // 4. B2 の日付に対応する結果を指示書へ出力（月間は月初起算で B2 の日）
  if (simulationResults && simulationResults.length > 0) {
    let dayOutForSheet = simulationResults[dayIdx];
    let dayForSheet = {
      date: dayOutForSheet.date,
      baseFlag: dayOutForSheet.baseFlag,
      inProcess: dayOutForSheet.inProcess,
      orders: collectOrderSheetOrdersForDay_(ctx, simulationResults, dayIdx)
    };
    saveOrderSheetAiSnapshot_(orderDate, dayForSheet, ctx, storeSheets.storeName);
    outputToOrderSheet(orderSheet, dayForSheet, ctx);
  }

  clearOrderSheetCheckboxes(orderSheet);

  let dayOut = simulationResults && simulationResults[dayIdx] ? simulationResults[dayIdx] : null;
  let prepN = dayOut ? Object.keys(dayOut.inProcess).length : 0;
  let orderN = dayOut ? Object.keys(dayOut.orders).length : 0;
  notifyUser(`完了 [${period} ${simDays}日]: 指示書=${formatJstDate_(orderDate)} 仕込み${prepN}件 / 発注${orderN}件 / 原価率${costRatioRows}日（バックログは${formatJstDate_(simStartDate)}〜）`);
  Logger.log(`[run] 所要時間=${Date.now() - runStarted}ms`);
};
