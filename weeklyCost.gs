/**
 * 週次原価率（棚卸しベース）— 指示書 A1「④週次原価率計算」+ B1 実行で呼び出し
 *
 * 週次原価率 = (前回棚卸金額 + 期間総仕入れ額 − 今回棚卸金額) ÷ 期間総売上
 * 仕入れ額 = バックログ発注を納品日（発注日+LT）で期間集計した金額
 * 原価率差異 = 週次原価率 − 日次原価率（材料原価率列をフォールバック）
 * 日次原価率（①計算実行）はメニュー出数＋仕込み指示の歩留まりロス＋期限切れ廃棄を含む（coreFunction.gs）
 */

const STOCK_SNAPSHOT_SHEET_ = "棚卸し履歴";
const STOCK_TAKING_LAST_DATE_KEY_ = "STOCK_TAKING_LAST_DATE";
const STOCK_TAKING_PREV_DATE_KEY_ = "STOCK_TAKING_PREV_DATE";
/** 棚卸し表と同じく店舗別タブのため、履歴シートは1枚共有のまま「店舗」列で区別する（実績出数ログと同じ方式） */
const STOCK_SNAPSHOT_HEADERS_ = ["棚卸日", "店舗", "商品名", "種別", "数量", "単位"];

/** 週次原価率の前回/今回棚卸し日プロパティキー（店舗別。全店舗共有のスクリプトプロパティのため店舗名を含める） */
const buildStockTakingPropKey_ = (baseKey, storeName) => {
  return storeName ? `${baseKey}_${storeName}` : baseKey;
};

/**
 * 週次原価率パイプライン（指示書 A1/B1 から呼び出し）
 * @param {object} [storeSheets] 対象店舗の4シート一式（未指定時はアクティブシートから解決）
 * @return {{ updated: boolean, weeklyRatio: number|null, message: string }}
 */
const runWeeklyFoodCostRatioPipeline = (storeSheets) => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  storeSheets = storeSheets || resolveStoreSheetsFromActiveSheet_(ss);
  let storeName = storeSheets.storeName;
  let stockSheet = resolveStockTakingSheet_(ss, storeName);
  let budgetSheet = storeSheets.budgetSheet;
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
  let lastDateKey = buildStockTakingPropKey_(STOCK_TAKING_LAST_DATE_KEY_, storeName);
  let prevDateKey = buildStockTakingPropKey_(STOCK_TAKING_PREV_DATE_KEY_, storeName);
  let lastDateStr = props.getProperty(lastDateKey) || "";
  let prevDateStr = props.getProperty(prevDateKey) || "";

  if (!lastDateStr) {
    saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot, storeName);
    props.setProperty(lastDateKey, currentDateStr);
    Logger.log(`[週次原価率] 初回棚卸しを記録: ${currentDateStr}`);
    return { updated: false, weeklyRatio: null, message: "初回棚卸しを記録しました（次回から週次原価率を算出）" };
  }

  let period = resolveWeeklyCostPeriod_(currentDateStr, lastDateStr, prevDateStr, ss, storeName);
  if (!period) {
    return { updated: false, weeklyRatio: null, message: "棚卸日が前回より過去のためスキップしました" };
  }
  if (!period.prevSnapshot || isStockSnapshotEmpty_(period.prevSnapshot)) {
    saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot, storeName);
    props.setProperty(prevDateKey, period.prevDateStr || "");
    props.setProperty(lastDateKey, currentDateStr);
    return { updated: false, weeklyRatio: null, message: "前回棚卸しが無いため記録のみ行いました" };
  }

  let breakdown = computeWeeklyFoodCostBreakdown_(
    budgetSheet, period.prevDateStr, period.prevSnapshot, currentDateStr, currentSnapshot, ctx, storeSheets.backlogSheet
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

  saveStockSnapshotToHistory_(ss, currentDateStr, currentSnapshot, storeName);
  if (currentDateStr !== lastDateStr) {
    props.setProperty(prevDateKey, period.prevDateStr);
  }
  props.setProperty(lastDateKey, currentDateStr);

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
const computeWeeklyFoodCostBreakdown_ = (budgetSheet, prevDateStr, prevSnapshot, currentDateStr, currentSnapshot, ctx, backlogSheet) => {
  let salesFromStr = addDaysToDateStr_(prevDateStr, 1);
  let salesToStr = currentDateStr;
  if (salesFromStr > salesToStr) {
    return { ok: false, message: "集計期間が無効です" };
  }

  let prevAmount = calcStockSnapshotValue_(prevSnapshot, ctx);
  let currentAmount = calcStockSnapshotValue_(currentSnapshot, ctx);
  let purchaseDetail = calcPeriodPurchaseAmount_(salesFromStr, salesToStr, ctx, backlogSheet);
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
  let storeSheets = resolveStoreSheetsFromActiveSheet_(ss);
  let storeName = storeSheets.storeName;
  let stockSheet = resolveStockTakingSheet_(ss, storeName);
  let budgetSheet = storeSheets.budgetSheet;
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
  let lastDateStr = props.getProperty(buildStockTakingPropKey_(STOCK_TAKING_LAST_DATE_KEY_, storeName)) || "";
  let prevDateStr = props.getProperty(buildStockTakingPropKey_(STOCK_TAKING_PREV_DATE_KEY_, storeName)) || "";
  if (!lastDateStr) {
    Logger.log("[診断] 初回棚卸しのみ記録済み。次回棚卸し後に週次原価率を算出できます。");
    return;
  }

  let ctx = loadCostCalcMasters_(ss);
  let currentSnapshot = loadStockTakingData(stockSheet, ctx.nameUnifyMap, ctx.rawMaster, ctx.preparationRecipes);
  let period = resolveWeeklyCostPeriod_(currentDateStr, lastDateStr, prevDateStr, ss, storeName);
  if (!period || !period.prevSnapshot) {
    Logger.log("[診断] 前回棚卸しスナップショットがありません");
    return;
  }

  let breakdown = computeWeeklyFoodCostBreakdown_(
    budgetSheet, period.prevDateStr, period.prevSnapshot, currentDateStr, currentSnapshot, ctx, storeSheets.backlogSheet
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

const resolveWeeklyCostPeriod_ = (currentDateStr, lastDateStr, prevDateStr, ss, storeName) => {
  let periodPrevDateStr;
  let periodPrevSnapshot;

  if (currentDateStr === lastDateStr) {
    periodPrevDateStr = prevDateStr;
    periodPrevSnapshot = periodPrevDateStr
      ? loadStockSnapshotFromHistory_(ss, periodPrevDateStr, storeName)
      : null;
  } else if (currentDateStr > lastDateStr) {
    periodPrevDateStr = lastDateStr;
    periodPrevSnapshot = loadStockSnapshotFromHistory_(ss, periodPrevDateStr, storeName);
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
const calcPeriodPurchaseAmount_ = (fromDateStr, toDateStr, ctx, sheet) => {
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

const saveStockSnapshotToHistory_ = (ss, dateStr, stockData, storeName) => {
  let sheet = ensureStockSnapshotSheet_(ss);
  removeStockSnapshotRowsForDate_(sheet, dateStr, storeName);

  let store = storeName || "";
  let rows = [];
  Object.keys(stockData.rawStock || {}).forEach((name) => {
    let s = stockData.rawStock[name];
    rows.push([dateStr, store, name, "raw", s.qty, s.unit]);
  });
  Object.keys(stockData.prepStock || {}).forEach((name) => {
    let s = stockData.prepStock[name];
    rows.push([dateStr, store, name, "prep", s.qty, s.unit]);
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

/** 対象日・対象店舗（店舗別タブのため、他店舗の同日分は残す）の行だけ削除 */
const removeStockSnapshotRowsForDate_ = (sheet, dateStr, storeName) => {
  let lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  let store = storeName || "";
  let data = sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).getValues();
  let kept = data.filter((row) => {
    return !(formatSheetDateToKey(row[0]) === dateStr && String(row[1] || "") === store);
  });
  if (kept.length === data.length) return;

  sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).clearContent();
  if (kept.length > 0) writeSheetRows(sheet, 2, 1, kept);
};

const loadStockSnapshotFromHistory_ = (ss, dateStr, storeName) => {
  let sheet = ss.getSheetByName(STOCK_SNAPSHOT_SHEET_);
  let lastRow = sheet ? sheet.getLastRow() : 0;
  if (!sheet || lastRow < 2) return null;

  let store = storeName || "";
  let data = sheet.getRange(2, 1, lastRow - 1, STOCK_SNAPSHOT_HEADERS_.length).getValues();
  let rawStock = {};
  let prepStock = {};
  let found = false;

  data.forEach((row) => {
    if (formatSheetDateToKey(row[0]) !== dateStr) return;
    if (String(row[1] || "") !== store) return;
    found = true;
    let name = String(row[2]).trim();
    let qty = Number(row[4]);
    let unit = String(row[5]).trim();
    if (!name || isNaN(qty)) return;

    if (String(row[3]).trim() === "prep") {
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
  let allProps = props.getProperties();
  let lastDate = allProps[STOCK_TAKING_LAST_DATE_KEY_] || "";
  let prevDate = allProps[STOCK_TAKING_PREV_DATE_KEY_] || "";
  Object.keys(allProps).forEach((key) => {
    if (key.indexOf(STOCK_TAKING_LAST_DATE_KEY_) === 0 || key.indexOf(STOCK_TAKING_PREV_DATE_KEY_) === 0) {
      props.deleteProperty(key);
    }
  });

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

/**
 * 過去日の「日次原価率」だけを再計算する（読み取り専用の需要計算のみ。バックログ・指示書・
 * 予測出数ログへの書き込みは一切行わない）。
 *
 * ①計算実行（runSimulationPipeline）は日次原価率と同時にバックログ（仕込み・発注指示）も
 * 上書きするため、過去日に向けてまとめて実行すると、その間に確定運用してきたバックログの
 * 実データを消してしまうリスクがある。日次原価率の算出自体は「その日の実績POS出数から
 * レシピ展開した理論原価」のみに依存し（coreFunction.gs buildDemandCache_）、バックログを
 * 生成する在庫・発注シミュレーションのループとは独立しているため、それだけを切り出す。
 *
 * 対象日を1日単独のシミュレーション窓（simDays=1）として計算するため、複数日にまたがる
 * 仕込みロットの廃棄判定は当日分のみでの近似になる（①計算実行を毎日連続運用した場合と
 * 完全には一致しない場合がある）。
 */
const recalculateDailyCostRatioForDate_ = (storeSheets, dateStr, vendorData) => {
  let orderDate = new Date(`${dateStr}T12:00:00`);
  let ctx = buildSimulationContext(orderDate, 1, "当日", orderDate, {
    storeSheets: storeSheets,
    inventoryDateStr: dateStr,
    vendorData: vendorData
  });
  let demandCache = buildDemandCache_(ctx);
  let dayDemand = demandCache.days[0];
  let ratio = dayDemand.foodCostRatio != null
    ? dayDemand.foodCostRatio
    : calcFoodCostRatio_(dayDemand.rawOutputDemand, ctx.rawMaster, ctx.budgetActualData[dateStr]);
  return { date: dateStr, foodCostRatio: ratio };
};

/**
 * 開始日〜終了日（未入力なら本日）を1日ずつ日次原価率だけ再計算する
 * （対象店舗は開いているタブの予算・実績 D1 の選択に従う。バックログ・指示書は変更しない）。
 * 予算・実績はD2の年月1か月分のみを対象にした月次シートのため、月をまたぐ範囲を指定した場合、
 * 現在表示中の月に該当する日のみが実際に書き込まれる（他の月の日は計算はされるが書込まれない）。
 */
const promptAndRecalculateDailyCostRatioRange = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let storeSheets = resolveStoreSheetsFromActiveSheet_(ss);
  if (!storeSheets.budgetSheet) {
    throw new Error(`「${SHEET_NAMES.BUDGET_ACTUAL}」シートが見つかりません。`);
  }
  let store = resolveSelectedSmaregiStore_(storeSheets.budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());

  let startRes = ui.prompt(
    "日次原価率だけ再計算（バックログ・指示書は変更しません）",
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
    "日次原価率だけ再計算（バックログ・指示書は変更しません）",
    `終了日を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
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

  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);

  let results = [];
  let failed = [];
  let cursor = startInput;
  while (cursor <= endStr) {
    try {
      results.push(recalculateDailyCostRatioForDate_(storeSheets, cursor, vendorData));
    } catch (err) {
      failed.push(`${cursor}: ${err.message}`);
      Logger.log(`[日次原価率再計算] ${cursor} 失敗: ${err.message}`);
    }
    cursor = addDaysToDateStr_(cursor, 1);
  }

  let written = writeBudgetFoodCostRatios_(storeSheets.budgetSheet, results, { targetDatesStr: [startInput, endStr] });

  notifyUser(
    `日次原価率の再計算完了: ${startInput}〜${endStr}（計算${results.length}日 / 予算・実績へ書込${written}件）`
      + (failed.length > 0 ? `\n失敗: ${failed.join(" / ")}` : ""),
    "日次原価率だけ再計算"
  );
};
