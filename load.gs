/**
 * 3. load.gs: データロード・コンテキスト構築関数群
 */

const buildSimulationContext = (simStartDate, simDays, periodMode, orderDate, options) => {
  options = options || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const nameUnifySheet = ss.getSheetByName(SHEET_NAMES.NAME_UNIFY_MASTER);
  const stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  const rawSheet = ss.getSheetByName(SHEET_NAMES.RAW_MASTER);
  const prepSheet = ss.getSheetByName(SHEET_NAMES.PREPARATION_RECIPE);
  const recipeSheet = ss.getSheetByName(SHEET_NAMES.RECIPE_MASTER);
  const budgetSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  const vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  const yieldSheet = ss.getSheetByName(SHEET_NAMES.YIELD_MASTER);
  let period = periodMode || "当日";
  let budgetAnchor = simStartDate;

  let inventoryDateStr = options.inventoryDateStr;
  if (!inventoryDateStr) {
    let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
    inventoryDateStr = (inventoryVal && !isNaN(new Date(inventoryVal).getTime()))
      ? formatJstDate_(inventoryVal)
      : formatJstDate_(simStartDate);
  }

  let nameUnifyMap = loadNameUnifyMaster(nameUnifySheet);
  let rawMaster = loadRawMaterialMaster(rawSheet);
  let prepRecipes = loadPreparationRecipes(prepSheet, nameUnifyMap);
  let recipeMaster = loadRecipeMaster(recipeSheet, nameUnifyMap);
  let stockData = loadStockTakingData(stockSheet, nameUnifyMap, rawMaster, prepRecipes);
  logNameUnifyWarnings_(stockData, rawMaster, prepRecipes, nameUnifyMap);
  logRecipeIngredientWarnings_(recipeMaster, prepRecipes, rawMaster);
  logPreparationRecipeCycles_(prepRecipes);

  let targetDatesStr = [];
  let startStr = formatJstDate_(simStartDate);
  for (let i = 0; i < simDays; i++) {
    let d = new Date(startStr + "T12:00:00");
    d.setDate(d.getDate() + i);
    targetDatesStr.push(formatJstDate_(d));
  }

  // 商品別バイアス係数の遡り参照(SALES_BIAS_LOOKBACK_DAYS_の2倍まで)が前月にまたがっても
  // 対象月として読み込まれるよう、遡り境界日もキー一覧に含める
  let biasLookbackAnchorStr = addDaysToDateStr_(targetDatesStr[0], -(SALES_BIAS_LOOKBACK_DAYS_ * 2));
  let budgetLoadDateKeys = targetDatesStr.concat([biasLookbackAnchorStr]);
  let budgetActualData = loadBudgetAndActualData(budgetSheet, budgetAnchor, budgetLoadDateKeys);
  let vendorData = options.vendorData || loadSTVendorCalendar(vendorSheet);
  let yieldMap = loadYieldMaster(yieldSheet, nameUnifyMap);
  logYieldMasterWarnings_(yieldMap, prepRecipes);

  logMissingBudgetDates(targetDatesStr, budgetActualData);

  let posCleanData = loadPosCleanData(ss.getSheetByName(SHEET_NAMES.POS_CLEAN));
  let posTotalRevenue = 0;
  let posTotalSalesQty = 0;
  posCleanData.forEach((r) => {
    posTotalRevenue += Number(r.salesAmount) || 0;
    posTotalSalesQty += Number(r.salesQty) || 0;
  });

  let actualSalesLogData = {};
  try {
    let selectedStore = resolveSelectedSmaregiStore_(budgetSheet);
    actualSalesLogData = loadActualSalesLogData(ss.getSheetByName(SHEET_NAMES.ACTUAL_SALES_LOG), selectedStore.storeId);
  } catch (err) {
    Logger.log(`[実績出数] 対象店舗が未選択のため実績データはスキップ: ${err.message}`);
  }

  let backlogSheet = ss.getSheetByName(SHEET_NAMES.BACKLOG);
  let backlogMeta = backlogSheet ? findSheetHeaderMeta(backlogSheet, ["日付", "商材名", "分類"]) : null;

  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  let averageSpend = 4000;
  if (options.averageSpend != null && !isNaN(options.averageSpend)) {
    averageSpend = Number(options.averageSpend);
  } else if (orderSheet) {
    let spendVal = orderSheet.getRange("F2").getValue();
    if (spendVal && !isNaN(spendVal)) averageSpend = Number(spendVal);
  }

  Logger.log(`[期間] モード=${period} 開始=${targetDatesStr[0]} 終了=${targetDatesStr[targetDatesStr.length - 1]} 指示書=${formatJstDate_(orderDate || simStartDate)} 在庫基準=${inventoryDateStr} POS=期間合計のまま使用（日数割りなし）`);

  return {
    targetDate: simStartDate,
    simDays: simDays,
    periodMode: period,
    targetDatesStr: targetDatesStr,
    inventoryDateStr: inventoryDateStr,
    rawMaster: rawMaster,
    preparationRecipes: prepRecipes,
    recipeMaster: recipeMaster,
    stockObj: stockData.rawStock,
    prepStockObj: stockData.prepStock,
    budgetActualData: budgetActualData,
    vendorCalendars: vendorData.calendars,
    vendorOrder: vendorData.order,
    posCleanData: posCleanData,
    posTotalRevenue: posTotalRevenue,
    posTotalSalesQty: posTotalSalesQty,
    actualSalesLogData: actualSalesLogData,
    backlogMeta: backlogMeta,
    averageSpend: averageSpend,
    nameUnifyMap: nameUnifyMap,
    yieldMap: yieldMap
  };
};

/**
 * 歩留まりマスタ
 * A1=商品名 / B1=歩留まり / A2〜=中間レシピ表の仕込み品名 / B2〜=0〜1
 */
const loadYieldMaster = (sheet, unifyMap) => {
  let map = {};
  if (!sheet) return map;

  let meta = findHeaderRowAndIndices(sheet, ["商品名", "歩留まり"]);
  let dataStartRow;
  let rows;

  if (meta) {
    dataStartRow = meta.dataStartRow;
    rows = meta.fullData;
  } else {
    let lastRow = sheet.getLastRow();
    if (lastRow < 2) return map;
    rows = sheet.getRange(1, 1, lastRow, 2).getValues();
    if (String(rows[0][0]).trim() !== "商品名" || String(rows[0][1]).trim() !== "歩留まり") {
      Logger.log(`[警告] 「${SHEET_NAMES.YIELD_MASTER}」に A1=商品名 / B1=歩留まり の見出しがありません。`);
      return map;
    }
    dataStartRow = 1;
  }

  let applied = 0;
  for (let i = dataStartRow; i < rows.length; i++) {
    let rawName = String(rows[i][0]).trim();
    let rate = Number(rows[i][1]);
    if (!rawName) continue;
    if (isNaN(rate) || rate <= 0 || rate > 1) {
      Logger.log(`[警告] 歩留まりマスタ「${rawName}」の歩留まりが無効: ${rows[i][1]}`);
      continue;
    }
    let name = resolveCanonicalName_(rawName, unifyMap);
    map[name] = rate;
    applied++;
  }

  Logger.log(`[歩留まり] ${applied} 件ロード`);
  return map;
};

/** 中間レシピ表に無くても許容する歩留まりマスタの品目（手動発注のため仕込み計算対象外） */
const YIELD_MASTER_MISMATCH_ALLOWED_ = {
  "生ビール": true
};

/** 歩留まりマスタの商品名が中間レシピ表に存在するか確認 */
const logYieldMasterWarnings_ = (yieldMap, prepRecipes) => {
  Object.keys(yieldMap || {}).forEach((name) => {
    if (!prepRecipes[name] && !YIELD_MASTER_MISMATCH_ALLOWED_[name]) {
      Logger.log(`[警告] 歩留まりマスタの商品名が中間レシピ表に無い: ${name}`);
    }
  });
};

/**
 * 名寄せマスタ
 * A1=棚卸し表 / B1=統一商品名 / C1=備考
 * A2〜=棚卸し表の商品名 → B2〜=統一商品名（原材料名・仕込み品名のいずれも可）
 */
const loadNameUnifyMaster = (sheet) => {
  let map = {};
  if (!sheet) return map;

  let meta = findNameUnifyHeaderMeta_(sheet);
  if (!meta) {
    Logger.log(`[警告] 「${SHEET_NAMES.NAME_UNIFY_MASTER}」に A1=棚卸し表 / B1=統一商品名 の見出しがありません。`);
    return map;
  }

  let applied = 0;
  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let stockName = String(meta.fullData[i][meta.idxStock]).trim();
    let unifiedName = String(meta.fullData[i][meta.idxUnified]).trim();
    if (!stockName || !unifiedName) continue;
    map[stockName] = unifiedName;
    applied++;
  }

  Logger.log(`[名寄せ] ${applied} 件ロード（棚卸し表→統一商品名）`);
  return map;
};

const findNameUnifyHeaderMeta_ = (sheet) => {
  let meta = findHeaderRowAndIndices(sheet, ["棚卸し表", "統一商品名"]);
  if (!meta) return null;
  return {
    dataStartRow: meta.dataStartRow,
    fullData: meta.fullData,
    idxStock: meta.headers.indexOf("棚卸し表"),
    idxUnified: meta.headers.indexOf("統一商品名")
  };
};

/**
 * B列の統一商品名がどちらのマスタに属するか判定
 * 原材料・仕込み品の両方にある名称は原材料を優先（棚卸しの生鮮品など）
 * @return {"raw"|"prep"|"unknown"}
 */
const classifyUnifiedName_ = (name, rawMaster, prepRecipes) => {
  let n = String(name == null ? "" : name).trim();
  if (!n) return "unknown";
  let kind = routeUnifiedMaterial_(n, { rawMaster: rawMaster, preparationRecipes: prepRecipes }).kind;
  if (kind === "raw" && rawMaster[n] && prepRecipes[n]) {
    Logger.log(`[警告] 「${n}」が原材料マスタと中間レシピ表の両方に存在 → 原材料として処理`);
  }
  return kind;
};

/**
 * 材料名を名寄せ後、仕込み品 or 原材料へ振り分け
 * 両方に存在する場合は原材料を優先（例: なす）
 * @return {{ kind: string, name: string }}
 */
const routeUnifiedMaterial_ = (name, ctx) => {
  let n = resolveCanonicalName_(name, ctx && ctx.nameUnifyMap);
  let inRaw = ctx && ctx.rawMaster && ctx.rawMaster[n];
  let inPrep = ctx && ctx.preparationRecipes && ctx.preparationRecipes[n];
  if (inRaw && inPrep) {
    return { kind: "raw", name: n };
  }
  if (inPrep) return { kind: "prep", name: n };
  if (inRaw) return { kind: "raw", name: n };
  return { kind: "unknown", name: n };
};

/** 名寄せマスタを辿って正規名へ（連鎖・自己参照に対応） */
const resolveCanonicalName_ = (name, unifyMap) => {
  let n = String(name == null ? "" : name).trim();
  if (!n || !unifyMap) return n;

  let seen = {};
  while (unifyMap[n] && unifyMap[n] !== n) {
    if (seen[n]) {
      Logger.log(`[警告] 名寄せの循環参照: ${name}`);
      break;
    }
    seen[n] = true;
    n = String(unifyMap[n]).trim();
  }
  return n;
};

/** 原材料マスタに無くても許容する棚卸し品目（停止済み・賄い専用など、発注計算に使わないため） */
const STOCK_TAKING_MASTER_MISMATCH_ALLOWED_ = {
  "和牛ブリスケ(原料)": true,
  "賄い鶏もも": true,
  "にんにくホイル焼き": true,
  "サラダ油": true,
  "タンスパイス": true,
  "カレー": true
};

/** 棚卸し名寄せ後にマスタへ無い名称を警告 */
const logNameUnifyWarnings_ = (stockData, rawMaster, prepRecipes, unifyMap) => {
  if (!stockData) return;

  let unifyCount = Object.keys(unifyMap || {}).length;
  if (unifyCount === 0) {
    Logger.log("[警告] 名寄せマスタが空のため、棚卸し・レシピ材料は名称完全一致で照合します。");
  }

  Object.keys(stockData.rawStock || {}).forEach((name) => {
    if (!rawMaster[name] && !STOCK_TAKING_MASTER_MISMATCH_ALLOWED_[name]) {
      Logger.log(`[警告] 棚卸し(名寄せ後・原材料)が原材料マスタに無い: ${name}`);
    }
  });
  Object.keys(stockData.prepStock || {}).forEach((name) => {
    if (!prepRecipes[name]) {
      Logger.log(`[警告] 棚卸し(名寄せ後・仕込み品)が中間レシピ表に無い: ${name}`);
    }
  });
};

/** レシピ・中間レシピの材料名（名寄せ後）がマスタに存在するか確認 */
const logRecipeIngredientWarnings_ = (recipeMaster, prepRecipes, rawMaster) => {
  let warned = {};

  const warnOnce_ = (context, ingName) => {
    let key = `${context}|${ingName}`;
    if (warned[key]) return;
    warned[key] = true;
    Logger.log(`[警告] ${context} 材料(名寄せ後)が未登録: ${ingName}`);
  };

  Object.keys(recipeMaster || {}).forEach((menu) => {
    if (Number(recipeMaster[menu].stopFlag) === 1) return;
    (recipeMaster[menu].ingredients || []).forEach((ing) => {
      if (!rawMaster[ing.name] && !prepRecipes[ing.name]) {
        warnOnce_(`レシピ「${menu}」`, ing.name);
      }
    });
  });

  Object.keys(prepRecipes || {}).forEach((prepName) => {
    if (Number(prepRecipes[prepName].stopFlag) === 1) return;
    (prepRecipes[prepName].ingredients || []).forEach((ing) => {
      if (!rawMaster[ing.name] && !prepRecipes[ing.name]) {
        warnOnce_(`中間レシピ「${prepName}」`, ing.name);
      }
    });
  });
};

/** 中間レシピ表の仕込み品ネストに循環がないか検出（名寄せ後） */
const logPreparationRecipeCycles_ = (prepRecipes) => {
  if (!prepRecipes) return;
  let reported = {};

  const walk_ = (current, path) => {
    let idx = path.indexOf(current);
    if (idx !== -1) {
      let cycle = path.slice(idx).concat([current]).join(" → ");
      if (!reported[cycle]) {
        reported[cycle] = true;
        Logger.log(`[警告] 中間レシピの循環参照: ${cycle}`);
      }
      return;
    }
    let prep = prepRecipes[current];
    if (!prep || !prep.ingredients) return;
    let nextPath = path.concat([current]);
    prep.ingredients.forEach((ing) => {
      if (prepRecipes[ing.name]) walk_(ing.name, nextPath);
    });
  };

  Object.keys(prepRecipes).forEach((name) => {
    walk_(name, []);
  });
};

const mergeStockEntry_ = (map, name, qty, unit) => {
  if (!map[name]) {
    map[name] = { qty: qty, unit: unit };
    return;
  }
  if (map[name].unit === unit) {
    map[name].qty += qty;
    return;
  }
  Logger.log(`[警告] 棚卸し名寄せ後の単位不一致: ${name} (${map[name].unit} + ${unit}) — 数量は加算しません`);
};

/** シミュレーション期間中に予算・実績が無い日をログ */
const logMissingBudgetDates = (targetDatesStr, budgetActualData) => {
  let missing = [];
  targetDatesStr.forEach((ds) => {
    if (!budgetActualData[ds]) missing.push(ds);
  });
  if (missing.length > 0) {
    Logger.log(`[警告] 予算・実績に無い日付 ${missing.length}件: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}`);
  }
};

/**
 * POSデータ_整形後を読込（A列: 統一商品名、B列: 販売点数、純売上列があれば総売上分母に使用）
 * 見出しが「純売上」のときのみ税込→税抜へ変換（「純売上(税抜)」は変換済み）
 */
const parsePosCleanRow_ = (row, idxName, idxQty, idxSales, salesAlreadyExTax) => {
  let name = String(row[idxName]).trim();
  if (!name) return null;
  let amount = idxSales !== -1 ? (Number(row[idxSales]) || 0) : 0;
  if (amount > 0 && !salesAlreadyExTax) {
    amount = convertPosSalesToExTax(amount);
  }
  return {
    menuName: name,
    salesQty: Number(row[idxQty]) || 0,
    salesAmount: amount
  };
};

const loadPosCleanData = (sheet) => {
  let data = [];
  if (!sheet) return data;

  let meta = findHeaderRowAndIndices(sheet, ["統一商品名", "販売点数"]);
  if (meta) {
    let idxName = meta.headers.indexOf("統一商品名");
    let idxQty = meta.headers.indexOf("販売点数");
    let salesMeta = findPosSalesColumnMeta_(meta.headers);
    for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
      let row = parsePosCleanRow_(meta.fullData[i], idxName, idxQty, salesMeta.idx, salesMeta.exTax);
      if (row) data.push(row);
    }
    return data;
  }

  // フォールバック: B1=販売点数、A列=商品名、2行目以降がデータ
  let lastRow = sheet.getLastRow();
  if (lastRow < 2) return data;

  let headerRow = sheet.getRange(1, 1, 1, Math.max(2, sheet.getLastColumn())).getValues()[0]
    .map((cell) => { return String(cell).trim(); });
  let idxName = 0, idxQty = 1;
  let salesMeta = findPosSalesColumnMeta_(headerRow);
  for (let c = 0; c < headerRow.length; c++) {
    let h = headerRow[c];
    if (h === "販売点数") idxQty = c;
    if (h === "統一商品名") idxName = c;
  }
  let maxCol = Math.max(idxName, idxQty, salesMeta.idx);
  let rows = sheet.getRange(2, 1, lastRow, maxCol + 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    let row = parsePosCleanRow_(rows[i], idxName, idxQty, salesMeta.idx, salesMeta.exTax);
    if (row) data.push(row);
  }
  return data;
};

/**
 * 実績出数ログ（日付|店舗|統一商品名|販売点数|純売上(税抜)）を日付ごとにグルーピング。
 * storeId を指定した場合はその店舗の行だけに絞り込む（複数店舗分が同じシートに同居するため）。
 * @return {{[dateStr:string]: {menuName:string, salesQty:number, salesAmount:number}[]}}
 */
const loadActualSalesLogData = (sheet, storeId) => {
  let data = {};
  if (!sheet) return data;

  let meta = findHeaderRowAndIndices(sheet, ["日付", "店舗", "統一商品名", "販売点数", POS_SALES_HEADER_EX_TAX]);
  if (!meta) return data;

  let idxDate = meta.headers.indexOf("日付");
  let idxStore = meta.headers.indexOf("店舗");
  let idxName = meta.headers.indexOf("統一商品名");
  let idxQty = meta.headers.indexOf("販売点数");
  let idxSales = meta.headers.indexOf(POS_SALES_HEADER_EX_TAX);

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let row = meta.fullData[i];
    if (storeId != null && String(row[idxStore]) !== String(storeId)) continue;

    let dateKey = formatSheetDateToKey(row[idxDate]);
    let name = String(row[idxName] || "").trim();
    if (!dateKey || !name) continue;

    if (!data[dateKey]) data[dateKey] = [];
    data[dateKey].push({
      menuName: name,
      salesQty: Number(row[idxQty]) || 0,
      salesAmount: Number(row[idxSales]) || 0
    });
  }
  return data;
};

const loadRawMaterialMaster = (sheet) => {
  let map = {};
  let meta = findHeaderRowAndIndices(sheet, ["原材料名", "仕入先業者", "商品ロット", "商品ロット単位", "発注単位", "最低在庫(発注単位)"]);
  if (!meta) return map;

  let headers = meta.headers;
  let indices = {
    name: headers.indexOf("原材料名"),
    vendor: headers.indexOf("仕入先業者"),
    lotQty: headers.indexOf("商品ロット"),
    lotUnit: headers.indexOf("商品ロット単位"),
    orderUnit: headers.indexOf("発注単位"),
    minStock: headers.indexOf("最低在庫(発注単位)"),
    stop: headers.indexOf("停止フラグ"),
    lot14Pri: findColumnIndex_(headers, ["14kg優先順位", "優先順位", "14kg優先"], -1),
    maxStock: findColumnIndex_(headers, ["最大在庫(発注単位)", "最大在庫"], -1),
    lot14Kg: findColumnIndex_(headers, ["14kg換算(kg)", "14kg換算", "kg換算(14kg)"], -1),
    unitPrice: findColumnIndex_(headers, ["単価"], 10)
  };

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let name = String(meta.fullData[i][indices.name]).trim();
    if (!name) continue;
    map[name] = {
      vendor: String(meta.fullData[i][indices.vendor]).trim(),
      lotQty: Number(meta.fullData[i][indices.lotQty]) || 1,
      lotUnit: String(meta.fullData[i][indices.lotUnit]).trim(),
      orderUnit: String(meta.fullData[i][indices.orderUnit]).trim(),
      minStock: Number(meta.fullData[i][indices.minStock]) || 0,
      stopFlag: indices.stop !== -1 ? Number(meta.fullData[i][indices.stop]) || 0 : 0,
      lot14Priority: indices.lot14Pri !== -1 ? Number(meta.fullData[i][indices.lot14Pri]) || 0 : 0,
      maxStock: indices.maxStock !== -1 ? Number(meta.fullData[i][indices.maxStock]) || 0 : 0,
      lot14KgPerOrderUnit: indices.lot14Kg !== -1 ? Number(meta.fullData[i][indices.lot14Kg]) || 0 : 0,
      unitPrice: indices.unitPrice !== -1 ? Number(meta.fullData[i][indices.unitPrice]) || 0 : 0
    };
  }
  return map;
};

/** レシピ行から原材料1〜N列を読み取る */
const loadIngredientRows_ = (headers, row, maxCols, unifyMap, withUnit) => {
  let ingredients = [];
  for (let k = 1; k <= maxCols; k++) {
    let idxIng = headers.indexOf("原材料" + k);
    let idxQty = headers.indexOf("必要量" + k);
    if (idxIng === -1 || idxQty === -1) continue;
    let ingName = resolveCanonicalName_(String(row[idxIng]).trim(), unifyMap);
    let ingQty = Number(row[idxQty]) || 0;
    if (!ingName || ingQty <= 0) continue;
    let ing = { name: ingName, qty: ingQty };
    if (withUnit) {
      let idxU = headers.indexOf("単位" + k);
      ing.unit = idxU !== -1 ? String(row[idxU]).trim() : "g";
    }
    ingredients.push(ing);
  }
  return ingredients;
};

const loadPreparationRecipes = (sheet, unifyMap) => {
  let map = {};
  let meta = findHeaderRowAndIndices(sheet, ["仕込み品名", "仕込みロット", "仕込み単位"]);
  if (!meta) return map;

  let headers = meta.headers;
  let idxName = headers.indexOf("仕込み品名");
  let idxLot = headers.indexOf("仕込みロット");
  let idxUnit = headers.indexOf("仕込み単位");
  let idxStop = headers.indexOf("停止フラグ");
  let idxVendor = findColumnIndex_(headers, ["仕入先業者", "仕込み業者", "業者"], -1);
  let idxSort = findColumnIndex_(headers, ["表示順", "出力順", "並び順"], -1);

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let rawName = String(meta.fullData[i][idxName]).trim();
    if (!rawName) continue;
    let name = resolveCanonicalName_(rawName, unifyMap);
    if (map[name] && rawName !== name) {
      Logger.log(`[警告] 中間レシピの名寄せ後に仕込み品名が重複: ${rawName} → ${name}`);
    }

    map[name] = {
      finishedQty: Number(meta.fullData[i][idxLot]) || 1,
      processUnit: String(meta.fullData[i][idxUnit]).trim(),
      stopFlag: idxStop !== -1 ? (Number(meta.fullData[i][idxStop]) || 0) : 0,
      vendor: idxVendor !== -1 ? String(meta.fullData[i][idxVendor]).trim() : "",
      sortOrder: idxSort !== -1 ? Number(meta.fullData[i][idxSort]) || 9999 : 9999,
      sheetRowIndex: i - meta.dataStartRow,
      ingredients: loadIngredientRows_(meta.headers, meta.fullData[i], 6, unifyMap, true)
    };
  }
  return map;
};

const loadRecipeMaster = (sheet, unifyMap) => {
  let map = {};
  let meta = findHeaderRowAndIndices(sheet, ["統一商品名", "原材料1", "必要量1"]);
  if (!meta) return map;

  let idxName = meta.headers.indexOf("統一商品名");
  let idxNote = findColumnIndex_(meta.headers, ["備考"], -1);
  let idxStop = findColumnIndex_(meta.headers, ["停止フラグ"], -1);

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let name = String(meta.fullData[i][idxName]).trim();
    if (!name) continue;

    map[name] = {
      note: idxNote !== -1 ? String(meta.fullData[i][idxNote]).trim() : "",
      stopFlag: idxStop !== -1 ? (Number(meta.fullData[i][idxStop]) || 0) : 0,
      ingredients: loadIngredientRows_(meta.headers, meta.fullData[i], 6, unifyMap, false)
    };
  }
  return map;
};

/** 棚卸し表のデータ開始行（C列=単位は3行目〜） */
const STOCK_TAKING_DATA_START_ROW = 3;

/**
 * 棚卸し表の列定義を解決
 * - 見出し行があれば 原材料名/在庫数/単位 を使用
 * - なければ A=名称, B=在庫数, C=単位（3行目〜）
 * - C列の単位は商品ロット単位または発注単位での記述を想定
 */
const resolveStockTakingMeta_ = (sheet) => {
  if (!sheet) return null;

  let meta = findHeaderRowAndIndices(sheet, ["原材料名", "在庫数", "単位"]);
  if (meta) {
    let minDataRowIdx = STOCK_TAKING_DATA_START_ROW - 1;
    return {
      fullData: meta.fullData,
      dataStartRow: Math.max(meta.dataStartRow, minDataRowIdx),
      idxName: meta.headers.indexOf("原材料名"),
      idxQty: meta.headers.indexOf("在庫数"),
      idxUnit: meta.headers.indexOf("単位")
    };
  }

  let lastRow = sheet.getLastRow();
  if (lastRow < STOCK_TAKING_DATA_START_ROW) return null;
  return {
    fullData: sheet.getRange(1, 1, lastRow, 3).getValues(),
    dataStartRow: STOCK_TAKING_DATA_START_ROW - 1,
    idxName: 0,
    idxQty: 1,
    idxUnit: 2
  };
};

/** 棚卸しの単位が原材料マスタの発注単位・商品ロット単位として妥当か確認 */
const logRawStockUnitValidation_ = (name, qty, unit, rawRow) => {
  if (!rawRow) return;
  let stockUnit = String(unit).trim();
  let orderUnit = String(rawRow.orderUnit).trim();
  let lotUnit = String(rawRow.lotUnit).trim();
  let issues = auditRawUnitConversion(rawRow, stockUnit);

  if (issues.length > 0) {
    Logger.log(`[警告] 棚卸し単位: ${name} ${qty}${stockUnit} — ${issues.join(" / ")}`);
    return;
  }

  let matchesMaster = unitsEquivalent(stockUnit, orderUnit)
    || unitsEquivalent(stockUnit, lotUnit)
    || isPackagingUnit(stockUnit);
  if (!matchesMaster && !isMassVolumeLargeUnit(stockUnit) && !isMassVolumeBaseUnit(stockUnit)) {
    Logger.log(`[情報] 棚卸し単位: ${name} ${stockUnit} (マスタ: 発注=${orderUnit} / ロット=${rawRow.lotQty}${lotUnit})`);
  }
};

const loadStockTakingData = (sheet, unifyMap, rawMaster, prepRecipes) => {
  let rawStock = {};
  let prepStock = {};
  if (!sheet) return { rawStock: rawStock, prepStock: prepStock };

  let stockMeta = resolveStockTakingMeta_(sheet);
  if (!stockMeta) return { rawStock: rawStock, prepStock: prepStock };

  for (let i = stockMeta.dataStartRow; i < stockMeta.fullData.length; i++) {
    let row = stockMeta.fullData[i];
    let rawName = String(row[stockMeta.idxName]).trim();
    let qty = Number(row[stockMeta.idxQty]);
    let unit = String(row[stockMeta.idxUnit]).trim();
    if (!rawName || isNaN(qty)) continue;

    let name = resolveCanonicalName_(rawName, unifyMap);
    let kind = classifyUnifiedName_(name, rawMaster, prepRecipes);

    if (kind === "prep") {
      mergeStockEntry_(prepStock, name, qty, unit);
    } else {
      logRawStockUnitValidation_(name, qty, unit, rawMaster[name]);
      mergeStockEntry_(rawStock, name, qty, unit);
    }
  }
  return { rawStock: rawStock, prepStock: prepStock };
};

const loadBudgetAndActualData = (sheet, simulationStartDate, simulationDateKeys) => {
  let budgetActualData = {};
  if (!sheet) return budgetActualData;

  let meta = findHeaderRowAndIndices(sheet, ["日付", "予算", "実績"]);
  if (!meta) {
    Logger.log("[エラー] 予算・実績シートの見出しが見つかりません。");
    return budgetActualData;
  }

  let monthsToLoad = collectBudgetMonthsToLoad_(sheet, simulationStartDate, simulationDateKeys);
  monthsToLoad.forEach((ym) => {
    loadBudgetMonthIntoMap_(meta, ym.year, ym.month, budgetActualData);
  });

  Logger.log(`[完了] 予算・実績データを ${Object.keys(budgetActualData).length} 件ロード（${monthsToLoad.length}ヶ月分）`);
  return budgetActualData;
};

/** 原価率計算に必要なマスタのみロード */
const loadCostCalcMasters_ = (ss) => {
  let nameUnifySheet = ss.getSheetByName(SHEET_NAMES.NAME_UNIFY_MASTER);
  let rawSheet = ss.getSheetByName(SHEET_NAMES.RAW_MASTER);
  let prepSheet = ss.getSheetByName(SHEET_NAMES.PREPARATION_RECIPE);
  let yieldSheet = ss.getSheetByName(SHEET_NAMES.YIELD_MASTER);
  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);

  let nameUnifyMap = loadNameUnifyMaster(nameUnifySheet);
  let vendorData = loadSTVendorCalendar(vendorSheet);
  return {
    rawMaster: loadRawMaterialMaster(rawSheet),
    preparationRecipes: loadPreparationRecipes(prepSheet, nameUnifyMap),
    yieldMap: loadYieldMaster(yieldSheet, nameUnifyMap),
    nameUnifyMap: nameUnifyMap,
    vendorCalendars: vendorData.calendars || {}
  };
};

/** 予算・実績の年月候補（D2 と対象日） */
const collectBudgetYearMonthCandidates_ = (budgetSheet, dateStr) => {
  let ymCandidates = [];
  let seenYm = {};

  const pushYm_ = (year, month) => {
    let key = year + "-" + month;
    if (seenYm[key]) return;
    seenYm[key] = true;
    ymCandidates.push({ year: year, month: month });
  };

  let d2Ym = findBudgetYearMonthFromD2_(budgetSheet);
  if (d2Ym) pushYm_(d2Ym.year, d2Ym.month);
  if (dateStr) {
    let target = parseJstDateStr_(dateStr);
    pushYm_(target.getFullYear(), target.getMonth());
  }
  return ymCandidates;
};

/**
 * 予算・実績シートの日付行を解決（yyyy-MM-dd）
 * meta.fullData を使い日付列の getRange を省略
 */
const findBudgetRowForDate_ = (budgetSheet, dateStr, cachedMeta) => {
  let meta = cachedMeta || findHeaderRowAndIndices(budgetSheet, ["日付", "予算", "実績"]);
  if (!meta) return null;

  let target = parseJstDateStr_(dateStr);
  let dayOfMonth = target.getDate();
  let ymCandidates = collectBudgetYearMonthCandidates_(budgetSheet, dateStr);
  let idxDate = meta.headers.indexOf("日付");
  if (idxDate < 0) return null;

  for (let y = 0; y < ymCandidates.length; y++) {
    let ym = ymCandidates[y];
    for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
      let dayNum = parseBudgetDayOfMonth_(meta.fullData[i][idxDate]);
      if (isNaN(dayNum) || dayNum !== dayOfMonth) continue;

      let d = new Date(ym.year, ym.month, dayNum);
      if (isNaN(d.getTime()) || d.getMonth() !== ym.month) continue;
      if (formatJstDate_(d) !== dateStr) continue;

      return {
        sheetRow: i + 1,
        headers: meta.headers,
        meta: meta
      };
    }
  }
  return null;
};

/** 予算・実績の指定行・複数列へ比率を一括書き込む */
const writeBudgetRatioCellsOnRow_ = (budgetSheet, rowInfo, columnValues, numberFormat) => {
  if (!budgetSheet || !rowInfo || !columnValues) return false;

  let props = PropertiesService.getScriptProperties();
  props.setProperty("SKIP_BUDGET_WEEKDAY_ONEDIT", "1");
  let written = false;
  try {
    Object.keys(columnValues).forEach((columnName) => {
      let value = columnValues[columnName];
      if (value == null || isNaN(value)) return;

      let idxCol = findExactHeaderColumn_(rowInfo.headers, columnName);
      if (idxCol < 0) return;

      let cell = budgetSheet.getRange(rowInfo.sheetRow, idxCol + 1);
      cell.setValue(value);
      if (numberFormat) cell.setNumberFormat(numberFormat);
      written = true;
    });
  } finally {
    props.deleteProperty("SKIP_BUDGET_WEEKDAY_ONEDIT");
  }
  return written;
};

/** 予算・実績の指定日・列へ比率を1セル書き込む */
const writeBudgetRatioAtDate_ = (budgetSheet, dateStr, columnName, value, numberFormat) => {
  if (value == null || isNaN(value)) return false;

  let rowInfo = findBudgetRowForDate_(budgetSheet, dateStr);
  if (!rowInfo) return false;

  let out = {};
  out[columnName] = value;
  return writeBudgetRatioCellsOnRow_(budgetSheet, rowInfo, out, numberFormat);
};

/** 予算・実績の指定日・「日次原価率」列（なければ「材料原価率」）を読み取る */
const readBudgetDailyCostRatio_ = (budgetSheet, dateStr, cachedMeta, cachedRowInfo) => {
  let rowInfo = cachedRowInfo || findBudgetRowForDate_(budgetSheet, dateStr, cachedMeta);
  if (!rowInfo) return null;

  let idxDaily = findExactHeaderColumn_(rowInfo.headers, BUDGET_COL_DAILY_COST_RATIO_);
  if (idxDaily < 0) idxDaily = findExactHeaderColumn_(rowInfo.headers, BUDGET_COL_MATERIAL_COST_RATIO_);
  if (idxDaily < 0) return null;

  return parseRatioCellValue_(budgetSheet.getRange(rowInfo.sheetRow, idxDaily + 1).getValue());
};

/** 予算・実績の期間売上合計（実績優先、なければ予算） */
const sumBudgetActualSalesForPeriod_ = (budgetSheet, fromDateStr, toDateStr) => {
  let dateKeys = enumerateDateKeys_(fromDateStr, toDateStr);
  if (dateKeys.length === 0) return 0;

  let budgetActualData = loadBudgetAndActualData(
    budgetSheet,
    parseJstDateStr_(dateKeys[0]),
    dateKeys
  );

  let total = 0;
  dateKeys.forEach((dateKey) => {
    let ba = budgetActualData[dateKey];
    if (!ba) return;
    total += resolveDailySalesBase_(ba).amount;
  });
  return total;
};

/** シミュレーション範囲と D2 から読み込む年月の一覧 */
const collectBudgetMonthsToLoad_ = (sheet, simulationStartDate, simulationDateKeys) => {
  let seen = {};
  let list = [];

  const addYm_ = (year, month) => {
    let key = year + "-" + month;
    if (seen[key]) return;
    seen[key] = true;
    list.push({ year: year, month: month });
  };

  let d2 = sheet ? findBudgetYearMonthFromD2_(sheet) : null;
  if (d2) addYm_(d2.year, d2.month);

  if (simulationStartDate && !isNaN(new Date(simulationStartDate).getTime())) {
    let ref = new Date(simulationStartDate);
    addYm_(ref.getFullYear(), ref.getMonth());
  }

  (simulationDateKeys || []).forEach((dateStr) => {
    if (!dateStr) return;
    let d = new Date(String(dateStr).trim() + "T12:00:00");
    if (!isNaN(d.getTime())) addYm_(d.getFullYear(), d.getMonth());
  });

  if (list.length === 0) {
    addYm_(new Date().getFullYear(), new Date().getMonth());
  }
  return list;
};

const loadBudgetMonthIntoMap_ = (meta, year, month, budgetActualData) => {
  let idxDate = meta.headers.indexOf("日付");
  let idxBudget = meta.headers.indexOf("予算");
  let idxActual = meta.headers.indexOf("実績");

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let row = meta.fullData[i];
    let dayNum = parseInt(row[idxDate], 10);
    if (isNaN(dayNum) || dayNum <= 0) continue;

    let targetDate = new Date(year, month, dayNum);
    if (targetDate.getMonth() !== month) continue;

    let dateKey = formatJstDate_(targetDate);
    let budgetStr = String(row[idxBudget] || "0").replace(/,/g, "").replace(/"/g, "").trim();
    let rawActual = row[idxActual];
    let hasActual = rawActual !== "" && rawActual !== null && rawActual !== undefined;
    let actualStr = hasActual
      ? String(rawActual).replace(/,/g, "").replace(/"/g, "").trim()
      : "";

    budgetActualData[dateKey] = {
      budget: Number(budgetStr) || 0,
      actual: hasActual ? (Number(actualStr) || 0) : null,
      hasActual: hasActual
    };
  }
};

/** 予算・実績の列見出し（名称完全一致） */
const BUDGET_COL_DAILY_COST_RATIO_ = "日次原価率";
const BUDGET_COL_MATERIAL_COST_RATIO_ = "材料原価率";
const BUDGET_COL_WEEKLY_COST_RATIO_ = "週次原価率";
const BUDGET_COL_COST_VARIANCE_ = "原価率差異";

/**
 * シミュレーション結果の日次原価率を予算・実績へ書き込む
 * 「原価率」は目標値のため「日次原価率」または「材料原価率」列を使用
 * @return {number} 書き込んだ行数
 */
const writeBudgetFoodCostRatios_ = (sheet, simulationResults, ctx) => {
  if (!sheet || !simulationResults || simulationResults.length === 0) return 0;

  let meta = findHeaderRowAndIndices(sheet, ["日付", "予算", "実績"]);
  if (!meta) {
    Logger.log("[警告] 予算・実績の見出しが無いため原価率を書き込めません。");
    return 0;
  }

  let ratioByDate = {};
  simulationResults.forEach((day) => {
    if (day.foodCostRatio != null && !isNaN(day.foodCostRatio)) {
      ratioByDate[day.date] = day.foodCostRatio;
    }
  });
  if (Object.keys(ratioByDate).length === 0) return 0;

  let costColIdx = findExactHeaderColumn_(meta.headers, BUDGET_COL_DAILY_COST_RATIO_);
  if (costColIdx < 0) costColIdx = findExactHeaderColumn_(meta.headers, BUDGET_COL_MATERIAL_COST_RATIO_);
  if (costColIdx < 0) {
    Logger.log("[原価率] 日次原価率/材料原価率列が無いため日次書込をスキップ（原価率列は目標値）");
    return 0;
  }

  let idxDate = meta.headers.indexOf("日付");
  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return 0;

  let numRows = lastRow - startRow + 1;
  let costCol = costColIdx + 1;
  let ratioCol = sheet.getRange(startRow, costCol, numRows, 1).getValues();
  let written = 0;

  let d2Ym = findBudgetYearMonthFromD2_(sheet);
  let sheetYm = d2Ym;
  if (!sheetYm && ctx && ctx.targetDatesStr && ctx.targetDatesStr.length > 0) {
    let first = parseJstDateStr_(ctx.targetDatesStr[0]);
    sheetYm = { year: first.getFullYear(), month: first.getMonth() };
  }
  if (!sheetYm) return 0;

  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let dayNum = parseBudgetDayOfMonth_(meta.fullData[i][idxDate]);
    if (isNaN(dayNum) || dayNum <= 0) continue;

    let d = new Date(sheetYm.year, sheetYm.month, dayNum);
    if (isNaN(d.getTime()) || d.getMonth() !== sheetYm.month) continue;

    let dateKey = formatJstDate_(d);
    if (ratioByDate[dateKey] == null) continue;

    let rowIdx = i - meta.dataStartRow;
    if (rowIdx < 0 || rowIdx >= ratioCol.length) continue;

    ratioCol[rowIdx][0] = ratioByDate[dateKey];
    written++;
  }

  if (written <= 0) return 0;

  let props = PropertiesService.getScriptProperties();
  props.setProperty("SKIP_BUDGET_WEEKDAY_ONEDIT", "1");
  try {
    let ratioRange = sheet.getRange(startRow, costCol, numRows, 1);
    ratioRange.setValues(ratioCol);
    ratioRange.setNumberFormat("0.0%");
  } finally {
    props.deleteProperty("SKIP_BUDGET_WEEKDAY_ONEDIT");
  }

  Logger.log(`[原価率] 予算・実績 ${written} 行を更新（${meta.headers[costColIdx]}）`);
  return written;
};

/**
 * 発注業者マスタ（A:業者名 B:LT C-I:月~日 1=納品不可/0=可能 J:祝日配送 K:14kg合算 L:停止）
 */
const loadSTVendorCalendar = (sheet) => {
  let calendars = {};
  let order = [];
  if (!sheet) return { calendars: calendars, order: order };

  let meta = findHeaderRowAndIndices(sheet, ["業者名", "リードタイム", "月", "火", "水", "木", "金", "土", "日"]);
  if (!meta) return { calendars: calendars, order: order };

  let dataStartRow = meta.dataStartRow;
  let rows = meta.fullData;
  let idxName = meta.headers.indexOf("業者名");
  let idxLT = meta.headers.indexOf("リードタイム");
  let idxMon = meta.headers.indexOf("月");
  let idxHoliday = findColumnIndex_(meta.headers, ["祝日配送", "祝日"], 9);
  let idxLot14 = findColumnIndex_(meta.headers, ["14kg", "14kg合算", "合算ロット"], 10);
  let idxStop = findColumnIndex_(meta.headers, ["停止フラグ", "停止"], 11);

  for (let i = dataStartRow; i < rows.length; i++) {
    let row = rows[i];
    let name = String(row[idxName]).trim();
    if (!name || name === "業者名") continue;

    order.push(name);
    calendars[name] = {
      _vendorName: name,
      leadTime: Number(row[idxLT]) || 0,
      "月": parseVendorWeekdayFlag(row[idxMon]),
      "火": parseVendorWeekdayFlag(row[idxMon + 1]),
      "水": parseVendorWeekdayFlag(row[idxMon + 2]),
      "木": parseVendorWeekdayFlag(row[idxMon + 3]),
      "金": parseVendorWeekdayFlag(row[idxMon + 4]),
      "土": parseVendorWeekdayFlag(row[idxMon + 5]),
      "日": parseVendorWeekdayFlag(row[idxMon + 6]),
      holidayDelivery: parseVendorHolidayFlag(row[idxHoliday]),
      lot14kg: parseVendorBinaryFlag(row[idxLot14]),
      stopFlag: parseVendorBinaryFlag(row[idxStop])
    };
  }
  return { calendars: calendars, order: order };
};

/** 曜日列: 1=納品不可, 0=納品可能（空欄は可能扱い） */
const parseVendorWeekdayFlag = (val) => {
  if (val === "" || val === null || val === undefined) return 0;
  return Number(val) === 1 ? 1 : 0;
};

/** 祝日配送: 1=可能, 空欄=不可 */
const parseVendorHolidayFlag = (val) => {
  if (val === "" || val === null || val === undefined) return false;
  return Number(val) === 1 || String(val).trim() === "1";
};

const parseVendorBinaryFlag = (val) => {
  return Number(val) === 1 || String(val).trim() === "1" ? 1 : 0;
};
