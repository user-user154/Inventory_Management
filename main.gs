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
    .addItem("予算・実績の曜日を更新", "syncBudgetWeekdaysFromD2")
    .addSeparator()
    .addItem("スマレジ実績を取得（当日分）", "runSmaregiDailyAutoImport")
    .addItem("スマレジ実績を取得（日付指定）", "promptAndImportSmaregiActuals_")
    .addItem("スマレジ日次自動取得トリガーを設定", "setupSmaregiDailyTrigger")
    .addItem("onEdit連携トリガーを設定（長時間実行用・任意）", "setupOnEditInstallableTrigger")
    .addSeparator()
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

  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  if (orderSheet) {
    setupOrderSheetActionControls_(orderSheet);
    setupOrderSheetManualInputArea(orderSheet);
    resetStuckOrderSheetCheckboxIfNeeded_(orderSheet);
    clearLegacySheetTriggerCheckboxes_(orderSheet);
  }

  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  if (budgetSheet) {
    clearLegacySheetTriggerCheckboxes_(budgetSheet);
  }
}

const runSimulationPipeline = () => {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let runStarted = Date.now();
  
  // 1. シミュレーション条件の取得（指示書シートから読み込む）
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
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
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  let period = readSimulationPeriod(budgetSheet);
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
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

  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);
  let maxLt = getMaxVendorLeadTimeDaysFromData_(vendorData);
  let simDays = resolveSimulationDaysIncludingOrderDate(period, simStartDate, orderDate, b3Days, maxLt);
  Logger.log(`[run] D1期間=${period} B2=${formatJstDate_(orderDate)} 棚卸し基準=${formatJstDate_(simStartDate)} シミュレーション=${simDays}日`);

  // 2. コンテキスト（各マスタ・棚卸データ）のロード
  let ctx = buildSimulationContext(simStartDate, simDays, period, orderDate, {
    vendorData: vendorData,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend
  });
  ctx.orderDate = orderDate;

  // 3. コア計算シミュレーションの実行（バックログの一括更新含む）
  let simulationResults = executeCoreSimulation(ctx);

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
    saveOrderSheetAiSnapshot_(orderDate, dayForSheet, ctx);
    outputToOrderSheet(orderSheet, dayForSheet, ctx);
  }

  clearOrderSheetCheckboxes(orderSheet);

  let dayOut = simulationResults && simulationResults[dayIdx] ? simulationResults[dayIdx] : null;
  let prepN = dayOut ? Object.keys(dayOut.inProcess).length : 0;
  let orderN = dayOut ? Object.keys(dayOut.orders).length : 0;
  notifyUser(`完了 [${period} ${simDays}日]: 指示書=${formatJstDate_(orderDate)} 仕込み${prepN}件 / 発注${orderN}件 / 原価率${costRatioRows}日（バックログは${formatJstDate_(simStartDate)}〜）`);
  Logger.log(`[run] 所要時間=${Date.now() - runStarted}ms`);
};
