/**
 * 週次原価率（棚卸しベース）— 予算・実績 F1 チェックボックスでのみ実行
 *
 * 週次原価率 = (前回棚卸金額 + 期間総仕入れ額 − 今回棚卸金額) ÷ 期間総売上
 * 仕入れ額 = バックログ発注を納品日（発注日+LT）で期間集計した金額
 * 原価率差異 = 週次原価率 − 日次原価率（材料原価率列をフォールバック）
 * 日次原価率（E1）はメニュー出数＋仕込み指示の歩留まりロス＋期限切れ廃棄を含む（coreFunction.gs）
 */

const STOCK_SNAPSHOT_SHEET_ = "棚卸し履歴";
const STOCK_TAKING_LAST_DATE_KEY_ = "STOCK_TAKING_LAST_DATE";
const STOCK_TAKING_PREV_DATE_KEY_ = "STOCK_TAKING_PREV_DATE";
const STOCK_SNAPSHOT_HEADERS_ = ["棚卸日", "商品名", "種別", "数量", "単位"];

/**
 * 週次原価率パイプライン（予算・実績 F1 チェックボックス TRUE 時のみ呼び出し）
 * @return {{ updated: boolean, weeklyRatio: number|null, message: string }}
 */
const runWeeklyFoodCostRatioPipeline = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  if (!stockSheet || !budgetSheet) {
    return { updated: false, weeklyRatio: null, message: "棚卸し表または予算・実績がありません" };
  }

  let inventoryVal = stockSheet.getRange("B1").getValue();
  if (!inventoryVal || isNaN(new Date(inventoryVal).getTime())) {
    return { updated: false, weeklyRatio: null, message: "棚卸し表B1に有効な日付がありません" };
  }
  let currentDateStr = formatJstDate_(inventoryVal);

  let ctx = loadCostCalcMasters_(ss);
  let currentSnapshot = loadStockTakingData(stockSheet, ctx.nameUnifyMap, ctx.rawMaster, ctx.preparationRecipes);
  if (isStockSnapshotEmpty_(currentSnapshot)) {
    return { updated: false, weeklyRatio: null, message: "棚卸しデータが空です" };
  }

  let props = PropertiesService.getScriptProperties();
  let lastDateStr = props.getProperty(STOCK_TAKING_LAST_DATE_KEY_) || "";
  let prevDateStr = props.getProperty(STOCK_TAKING_PREV_DATE_KEY_) || "";

  if (!lastDateStr) {
    saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot);
    props.setProperty(STOCK_TAKING_LAST_DATE_KEY_, currentDateStr);
    Logger.log(`[週次原価率] 初回棚卸しを記録: ${currentDateStr}`);
    return { updated: false, weeklyRatio: null, message: "初回棚卸しを記録しました（次回から週次原価率を算出）" };
  }

  let period = resolveWeeklyCostPeriod_(currentDateStr, lastDateStr, prevDateStr, ss);
  if (!period) {
    return { updated: false, weeklyRatio: null, message: "棚卸日が前回より過去のためスキップしました" };
  }
  if (!period.prevSnapshot || isStockSnapshotEmpty_(period.prevSnapshot)) {
    saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot);
    props.setProperty(STOCK_TAKING_PREV_DATE_KEY_, period.prevDateStr || "");
    props.setProperty(STOCK_TAKING_LAST_DATE_KEY_, currentDateStr);
    return { updated: false, weeklyRatio: null, message: "前回棚卸しが無いため記録のみ行いました" };
  }

  let breakdown = computeWeeklyFoodCostBreakdown_(
    budgetSheet, period.prevDateStr, period.prevSnapshot, currentDateStr, currentSnapshot, ctx
  );
  if (!breakdown.ok) {
    return { updated: false, weeklyRatio: null, message: breakdown.message };
  }

  let budgetMeta = findHeaderRowAndIndices(budgetSheet, ["日付", "予算", "実績"]);
  let rowInfo = findBudgetRowForDate_(budgetSheet, currentDateStr, budgetMeta);
  let dailyRatio = readBudgetDailyCostRatio_(budgetSheet, currentDateStr, budgetMeta, rowInfo);
  let variance = (dailyRatio != null && !isNaN(dailyRatio) && breakdown.weeklyRatio != null)
    ? breakdown.weeklyRatio - dailyRatio
    : null;

  writeWeeklyFoodCostRatioToBudget_(budgetSheet, rowInfo, breakdown.weeklyRatio, variance);

  saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot);
  if (currentDateStr !== lastDateStr) {
    props.setProperty(STOCK_TAKING_PREV_DATE_KEY_, period.prevDateStr);
  }
  props.setProperty(STOCK_TAKING_LAST_DATE_KEY_, currentDateStr);

  logWeeklyFoodCostBreakdown_(breakdown, variance);

  return {
    updated: true,
    weeklyRatio: breakdown.weeklyRatio,
    message: "週次原価率 " + (breakdown.weeklyRatio * 100).toFixed(1) + "% を更新しました"
  };
};

/**
 * 週次原価率の内訳を算出（診断・本番共通）
 * 仕入れはバックログ発注を納品日で期間判定する
 */
const computeWeeklyFoodCostBreakdown_ = (budgetSheet, prevDateStr, prevSnapshot, currentDateStr, currentSnapshot, ctx) => {
  let salesFromStr = addDaysToDateStr_(prevDateStr, 1);
  let salesToStr = currentDateStr;
  if (salesFromStr > salesToStr) {
    return { ok: false, message: "集計期間が無効です" };
  }

  let prevAmount = calcStockSnapshotValue_(prevSnapshot, ctx);
  let currentAmount = calcStockSnapshotValue_(currentSnapshot, ctx);
  let purchaseDetail = calcPeriodPurchaseAmount_(salesFromStr, salesToStr, ctx);
  let purchaseAmount = purchaseDetail.total;
  let periodSales = sumBudgetActualSalesForPeriod_(budgetSheet, salesFromStr, salesToStr);

  if (periodSales <= 0) {
    Logger.log(`[週次原価率] 期間売上0: ${salesFromStr}〜${salesToStr}`);
    return { ok: false, message: "期間売上が0のため週次原価率を算出できません" };
  }

  let cogsAmount = prevAmount + purchaseAmount - currentAmount;
  let weeklyRatio = calcFoodCostRatioFromAmounts_(cogsAmount, periodSales);

  return {
    ok: true,
    prevDateStr: prevDateStr,
    currentDateStr: currentDateStr,
    salesFromStr: salesFromStr,
    salesToStr: salesToStr,
    prevAmount: prevAmount,
    currentAmount: currentAmount,
    purchaseAmount: purchaseAmount,
    periodSales: periodSales,
    cogsAmount: cogsAmount,
    weeklyRatio: weeklyRatio,
    purchaseDetail: purchaseDetail
  };
};

const logWeeklyFoodCostBreakdown_ = (breakdown, variance) => {
  Logger.log(`[週次原価率] 前回棚卸=${breakdown.prevDateStr} 今回棚卸=${breakdown.currentDateStr} 集計=${breakdown.salesFromStr}〜${breakdown.salesToStr}`);
  Logger.log(`[週次原価率] 前回棚卸額=${Math.round(breakdown.prevAmount)} 仕入額=${Math.round(breakdown.purchaseAmount)} 今回棚卸額=${Math.round(breakdown.currentAmount)} 原価(棚卸差)=${Math.round(breakdown.cogsAmount)} 売上=${Math.round(breakdown.periodSales)} → ${(breakdown.weeklyRatio * 100).toFixed(1)}%${variance != null ? ` 差異=${(variance * 100).toFixed(1)}pt` : ""}`);

  let detail = breakdown.purchaseDetail || {};
  Logger.log(`[週次原価率] 仕入行=${detail.matchedRows || 0} スキップ(納品期間外)=${detail.skippedOutsidePeriod || 0} スキップ(マスタ不明)=${detail.skippedUnknownItem || 0} 在庫増減=${Math.round(breakdown.currentAmount - breakdown.prevAmount)}`);

  (detail.topItems || []).forEach((item) => {
    Logger.log(`  仕入 ${item.name} 納品${item.deliveryDateStr} (発注${item.orderDateStr}) ¥${Math.round(item.amount)}`);
  });
};

/**
 * 診断用: Apps Script エディタから debugWeeklyFoodCostRatio() を実行しログを確認
 */
const debugWeeklyFoodCostRatio = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  if (!stockSheet || !budgetSheet) {
    Logger.log("[診断] 棚卸し表または予算・実績がありません");
    return;
  }

  let inventoryVal = stockSheet.getRange("B1").getValue();
  if (!inventoryVal || isNaN(new Date(inventoryVal).getTime())) {
    Logger.log("[診断] 棚卸し表B1に有効な日付がありません");
    return;
  }
  let currentDateStr = formatJstDate_(inventoryVal);

  let props = PropertiesService.getScriptProperties();
  let lastDateStr = props.getProperty(STOCK_TAKING_LAST_DATE_KEY_) || "";
  let prevDateStr = props.getProperty(STOCK_TAKING_PREV_DATE_KEY_) || "";
  if (!lastDateStr) {
    Logger.log("[診断] 初回棚卸しのみ記録済み。次回棚卸し後に週次原価率を算出できます。");
    return;
  }

  let ctx = loadCostCalcMasters_(ss);
  let currentSnapshot = loadStockTakingData(stockSheet, ctx.nameUnifyMap, ctx.rawMaster, ctx.preparationRecipes);
  let period = resolveWeeklyCostPeriod_(currentDateStr, lastDateStr, prevDateStr, ss);
  if (!period || !period.prevSnapshot) {
    Logger.log("[診断] 前回棚卸しスナップショットがありません");
    return;
  }

  let breakdown = computeWeeklyFoodCostBreakdown_(
    budgetSheet, period.prevDateStr, period.prevSnapshot, currentDateStr, currentSnapshot, ctx
  );
  if (!breakdown.ok) {
    Logger.log(`[診断] ${breakdown.message}`);
    return;
  }

  Logger.log("========== 週次原価率 診断 ==========");
  logWeeklyFoodCostBreakdown_(breakdown, null);

  if (breakdown.cogsAmount < breakdown.periodSales * 0.2) {
    Logger.log("[診断ヒント] 原価(棚卸差)が売上の20%未満です。仕入不足・在庫増加・棚卸金額の過大評価が疑われます。");
    if ((breakdown.purchaseDetail.matchedRows || 0) === 0) {
      Logger.log("[診断ヒント] 期間内の仕入行が0件です。I1確定コミットでバックログへ発注を記録しているか確認してください。");
    }
    if (breakdown.currentAmount > breakdown.prevAmount + breakdown.purchaseAmount) {
      Logger.log("[診断ヒント] 今回棚卸額 > 前回+仕入 です。在庫が増えた週は原価率が下がります。");
    }
  }
  Logger.log("====================================");
};

const resolveWeeklyCostPeriod_ = (currentDateStr, lastDateStr, prevDateStr, ss) => {
  let periodPrevDateStr;
  let periodPrevSnapshot;

  if (currentDateStr === lastDateStr) {
    periodPrevDateStr = prevDateStr;
    periodPrevSnapshot = periodPrevDateStr
      ? loadStockSnapshotFromHistory_(ss, periodPrevDateStr)
      : null;
  } else if (currentDateStr > lastDateStr) {
    periodPrevDateStr = lastDateStr;
    periodPrevSnapshot = loadStockSnapshotFromHistory_(ss, periodPrevDateStr);
  } else {
    Logger.log(`[週次原価率] 過去日付スキップ: ${currentDateStr} < ${lastDateStr}`);
    return null;
  }

  return {
    prevDateStr: periodPrevDateStr,
    prevSnapshot: periodPrevSnapshot
  };
};

const isStockSnapshotEmpty_ = (stockData) => {
  if (!stockData) return true;
  return Object.keys(stockData.rawStock || {}).length
    + Object.keys(stockData.prepStock || {}).length === 0;
};

const calcStockSnapshotValue_ = (stockData, ctx) => {
  return calcMaterialCostFromMinQtyMap_(
    stockSnapshotToRawMinQtyMap_(stockData, ctx),
    ctx.rawMaster
  );
};

/**
 * 前回棚卸し翌日〜今回棚卸し日に納品されたバックログ発注を金額化
 * バックログの日付は発注日のため、業者LTで納品日へ換算して期間判定する
 */
const calcPeriodPurchaseAmount_ = (fromDateStr, toDateStr, ctx) => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.BACKLOG);
  let empty = {
    total: 0,
    matchedRows: 0,
    skippedOutsidePeriod: 0,
    skippedUnknownItem: 0,
    topItems: []
  };
  if (!sheet) return empty;

  let meta = findSheetHeaderMeta(sheet, ["日付", "商材名", "分類"]);
  if (!meta) return empty;

  let rows = readBacklogDataRows_(sheet, meta);
  let idxDate = meta.headers.indexOf("日付");
  let idxName = meta.headers.indexOf("商材名");
  let idxKind = meta.headers.indexOf("分類");
  let idxQty = meta.headers.indexOf("数量");
  let idxMinQty = findColumnIndex_(meta.headers, ["最小単位量"], -1);
  let vendorCalendars = ctx.vendorCalendars || {};
  let maxLt = getMaxVendorLeadTimeFromCalendars_(vendorCalendars);
  let orderScanFrom = addDaysToDateStr_(fromDateStr, -maxLt);
  let holidayCache = {};
  let rawMinQty = {};
  let lineItems = [];
  let matchedRows = 0;
  let skippedOutsidePeriod = 0;
  let skippedUnknownItem = 0;

  rows.forEach((row) => {
    let orderDateStr = formatSheetDateToKey(row[idxDate]);
    if (!orderDateStr || orderDateStr < orderScanFrom || orderDateStr > toDateStr) return;
    if (String(row[idxKind]).trim() !== "発注") return;

    let name = resolveCanonicalName_(String(row[idxName]).trim(), ctx.nameUnifyMap);
    let rawRow = ctx.rawMaster[name];
    if (!rawRow) {
      skippedUnknownItem++;
      return;
    }

    let vCal = vendorCalendars[rawRow.vendor];
    let deliveryDateStr = resolveDeliveryDateStrForBacklogOrder_(orderDateStr, vCal, holidayCache);
    if (!deliveryDateStr || deliveryDateStr < fromDateStr || deliveryDateStr > toDateStr) {
      skippedOutsidePeriod++;
      return;
    }

    let minQty = 0;
    if (idxMinQty !== -1 && row[idxMinQty] !== "" && row[idxMinQty] != null) {
      minQty = Number(row[idxMinQty]) || 0;
    }
    if (minQty <= 0 && idxQty !== -1) {
      let displayQty = Number(row[idxQty]) || 0;
      if (displayQty > 0) minQty = convertToMinUnit(displayQty, rawRow.orderUnit, rawRow);
    }
    if (minQty <= 0) return;

    rawMinQty[name] = (rawMinQty[name] || 0) + minQty;
    matchedRows++;

    let orderLotMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
    let unitPrice = Number(rawRow.unitPrice) || 0;
    let amount = (orderLotMin > 0 && unitPrice > 0) ? (minQty / orderLotMin) * unitPrice : 0;
    lineItems.push({
      name: name,
      orderDateStr: orderDateStr,
      deliveryDateStr: deliveryDateStr,
      amount: amount
    });
  });

  lineItems.sort((a, b) => { return b.amount - a.amount; });

  return {
    total: calcMaterialCostFromMinQtyMap_(rawMinQty, ctx.rawMaster),
    matchedRows: matchedRows,
    skippedOutsidePeriod: skippedOutsidePeriod,
    skippedUnknownItem: skippedUnknownItem,
    topItems: lineItems.slice(0, 10)
  };
};

const writeWeeklyFoodCostRatioToBudget_ = (budgetSheet, rowInfo, weeklyRatio, variance) => {
  if (!rowInfo) {
    Logger.log("[週次原価率] 予算・実績に棚卸日の行が見つかりません");
    return false;
  }

  let columnValues = {};
  if (weeklyRatio != null && !isNaN(weeklyRatio)) {
    columnValues[BUDGET_COL_WEEKLY_COST_RATIO_] = weeklyRatio;
  }
  if (variance != null && !isNaN(variance)) {
    columnValues[BUDGET_COL_COST_VARIANCE_] = variance;
  }

  let ok = writeBudgetRatioCellsOnRow_(budgetSheet, rowInfo, columnValues, "0.0%");
  if (!ok) {
    Logger.log("[週次原価率] 週次原価率・原価率差異の列が見つかりません");
  }
  return ok;
};

const ensureStockSnapshotSheet_ = (ss) => {
  let sheet = ss.getSheetByName(STOCK_SNAPSHOT_SHEET_);
  if (sheet) return sheet;

  sheet = ss.insertSheet(STOCK_SNAPSHOT_SHEET_);
  sheet.getRange(1, 1, 1, STOCK_SNAPSHOT_HEADERS_.length).setValues([STOCK_SNAPSHOT_HEADERS_]);
  return sheet;
};

const saveStockSnapshotToHistory_ = (ss, dateStr, stockData) => {
  let sheet = ensureStockSnapshotSheet_(ss);
  removeStockSnapshotRowsForDate_(sheet, dateStr);

  let rows = [];
  Object.keys(stockData.rawStock || {}).forEach((name) => {
    let s = stockData.rawStock[name];
    rows.push([dateStr, name, "raw", s.qty, s.unit]);
  });
  Object.keys(stockData.prepStock || {}).forEach((name) => {
    let s = stockData.prepStock[name];
    rows.push([dateStr, name, "prep", s.qty, s.unit]);
  });
  if (rows.length === 0) return;

  let lastRow = sheet.getLastRow();
  let startRow = lastRow < 1 ? 2 : lastRow + 1;
  if (lastRow < 1) {
    sheet.getRange(1, 1, 1, STOCK_SNAPSHOT_HEADERS_.length).setValues([STOCK_SNAPSHOT_HEADERS_]);
    startRow = 2;
  }
  writeSheetRows(sheet, startRow, 1, rows);
};

const removeStockSnapshotRowsForDate_ = (sheet, dateStr) => {
  let lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  let data = sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).getValues();
  let kept = data.filter((row) => {
    return formatSheetDateToKey(row[0]) !== dateStr;
  });
  if (kept.length === data.length) return;

  sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).clearContent();
  if (kept.length > 0) writeSheetRows(sheet, 2, 1, kept);
};

const loadStockSnapshotFromHistory_ = (ss, dateStr) => {
  let sheet = ss.getSheetByName(STOCK_SNAPSHOT_SHEET_);
  let lastRow = sheet ? sheet.getLastRow() : 0;
  if (!sheet || lastRow < 2) return null;

  let data = sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).getValues();
  let rawStock = {};
  let prepStock = {};
  let found = false;

  data.forEach((row) => {
    if (formatSheetDateToKey(row[0]) !== dateStr) return;
    found = true;
    let name = String(row[1]).trim();
    let qty = Number(row[3]);
    let unit = String(row[4]).trim();
    if (!name || isNaN(qty)) return;

    if (String(row[2]).trim() === "prep") {
      mergeStockEntry_(prepStock, name, qty, unit);
    } else {
      mergeStockEntry_(rawStock, name, qty, unit);
    }
  });

  return found ? { rawStock: rawStock, prepStock: prepStock } : null;
};

/**
 * 棚卸し履歴シートと週次原価率用の前回日付プロパティを削除
 * @return {{ clearedRows: number, lastDate: string, prevDate: string }}
 */
const clearStockSnapshotHistory_ = (ss) => {
  let spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(STOCK_SNAPSHOT_SHEET_);
  let clearedRows = 0;

  if (sheet) {
    let lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      clearedRows = lastRow - 1;
      sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).clearContent();
    }
    sheet.getRange(1, 1, 1, STOCK_SNAPSHOT_HEADERS_.length).setValues([STOCK_SNAPSHOT_HEADERS_]);
  }

  let props = PropertiesService.getScriptProperties();
  let lastDate = props.getProperty(STOCK_TAKING_LAST_DATE_KEY_) || "";
  let prevDate = props.getProperty(STOCK_TAKING_PREV_DATE_KEY_) || "";
  props.deleteProperty(STOCK_TAKING_LAST_DATE_KEY_);
  props.deleteProperty(STOCK_TAKING_PREV_DATE_KEY_);

  return { clearedRows: clearedRows, lastDate: lastDate, prevDate: prevDate };
};

/**
 * テスト用: 棚卸し履歴と週次原価率の前回/前々回日付をリセット
 * Apps Script エディタから resetStockSnapshotHistory() を直接実行
 */
const resetStockSnapshotHistory = () => {
  let result = clearStockSnapshotHistory_(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log(`[棚卸し履歴リセット] 履歴行=${result.clearedRows} / 前回日付=${result.lastDate || "(なし)"} / 前々回日付=${result.prevDate || "(なし)"}`);
};
