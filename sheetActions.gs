/**
 * 5. sheet_actions.gs: チェックボックス連動（onEdit）— 計算は TRUE 時のみ手動実行
 *
 * 指示書 A1=操作プルダウン / B1=実行チェックボックス。
 * B1 がオフ→オンのとき、A1 で選んだ処理だけ実行する。
 * 手動入力エリア O2:Q5（生樽・炭酸ガス）の編集では onEdit による書換えは行わない。
 */

/** チェックボックス action 名 → 実行関数（初回参照時に解決。const の TDZ / ファイル読込順を避ける） */
let checkboxActionsCache_ = null;
const getCheckboxAction_ = (action) => {
  if (!checkboxActionsCache_) {
    checkboxActionsCache_ = {
      formatPosRawToClean: formatPosRawToClean,
      runSimulationPipeline: runSimulationPipeline,
      commitOrderSheetToBacklogAndLog: commitOrderSheetToBacklogAndLog,
      runWeeklyFoodCostRatioPipeline: runWeeklyFoodCostRatioPipeline
    };
  }
  return checkboxActionsCache_[action] || null;
};

/** シンプルトリガー onEdit（インストール型と併用、Lock で二重実行防止） */
function onEdit(e) {
  handleSpreadsheetEdit_(e);
}

/** インストール型 onEdit（oldValue 利用・実行時間延長） */
function onEditInstallable(e) {
  handleSpreadsheetEdit_(e);
}

/**
 * 編集トリガー本体
 * 計算系はチェックボックスのオフ→オンのみ。それ以外の自動実行はしない。
 */
const handleSpreadsheetEdit_ = (e) => {
  if (!e || !e.range) return;

  let lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;

  try {
    let sheet = e.range.getSheet();
    if (!sheet) return;
    let sheetName = sheet.getName();

    if (sheetName === SHEET_NAMES.ORDER_FORM) {
      // 生樽・炭酸ガス手入力（O2:Q5）は onEdit で書換えしない（確定コミット前に消えないよう保護）
      if (isOrderSheetManualInputEdit_(e)) return;
      let triggerCells = [ORDER_SHEET_B1_TRIGGER_];
      if (isCheckboxSkipActive_(CHECKBOX_SKIP_PROPS_.ORDER_FORM, e, triggerCells)) return;
      dispatchOrderSheetAction_(e, sheet);
      return;
    }
  } finally {
    lock.releaseLock();
  }
};

/** 指示書 B1: A1 で選んだ操作を実行 */
const dispatchOrderSheetAction_ = (e, sheet) => {
  let triggerCells = [ORDER_SHEET_B1_TRIGGER_];
  let trigger = isSheetCheckboxTriggerEdit_(e, triggerCells);
  if (!trigger) return;

  let menuItem = resolveOrderSheetActionMenuItem_(sheet);
  if (!menuItem) {
    notifyUser("A1 で実行する操作を選択してください。", "指示書");
    clearSheetTriggerCheckboxes_(sheet, triggerCells, CHECKBOX_SKIP_PROPS_.ORDER_FORM);
    return;
  }

  let actionFn = getCheckboxAction_(menuItem.action);
  if (!actionFn) {
    Logger.log(`[チェックボックス] 未登録 action: ${menuItem.action}`);
    return;
  }

  runCheckboxAction_(sheet, ORDER_SHEET_B1_TRIGGER_, () => {
    let result = actionFn();
    if (menuItem.action === "runWeeklyFoodCostRatioPipeline" && result) {
      notifyUser(result.message || "週次原価率の処理が完了しました", menuItem.label);
    }
  }, menuItem.label, CHECKBOX_SKIP_PROPS_.ORDER_FORM);
};

/** メニュー・手動実行用: D2 と A5〜 から曜日列を一括更新 */
function syncBudgetWeekdaysFromD2() {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.BUDGET_ACTUAL);
  if (!sheet) {
    notifyUser(`「${SHEET_NAMES.BUDGET_ACTUAL}」シートが見つかりません。`, "曜日更新");
    return;
  }
  if (!findBudgetYearMonthFromD2_(sheet)) {
    notifyUser("D2 に有効な年月日を入力してください。", "曜日更新");
    return;
  }
  fillBudgetWeekdaysFromStartDate(sheet);
  notifyUser("予算・実績の曜日列（B5以降）を更新しました。", "曜日更新");
}

/** 予算・実績シートの B5 以降へ曜日を自動入力（全行）。年月は D2 参照 */
const fillBudgetWeekdaysFromStartDate = (sheet) => {
  if (!sheet || sheet.getName() !== SHEET_NAMES.BUDGET_ACTUAL) return;
  let lastRow = sheet.getLastRow();
  if (lastRow < 5) return;
  fillBudgetWeekdaysForRows_(sheet, 5, lastRow - 4);
};

/** 指定行だけ A列の日(1〜31) → B列曜日を更新 */
const fillBudgetWeekdaysForRows_ = (sheet, startRow, numRows) => {
  if (!sheet || sheet.getName() !== SHEET_NAMES.BUDGET_ACTUAL) return;
  if (numRows <= 0) return;

  let ym = findBudgetYearMonthFromD2_(sheet);
  if (!ym) return;
  let year = ym.year;
  let month = ym.month;

  let dayVals = sheet.getRange(startRow, 1, numRows, 1).getValues();
  let weekdayVals = dayVals.map((row) => {
    let dayNum = parseBudgetDayOfMonth_(row[0]);
    if (isNaN(dayNum) || dayNum <= 0) return [""];
    let d = new Date(year, month, dayNum);
    if (isNaN(d.getTime()) || d.getMonth() !== month) return [""];
    let weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
    return [weekday];
  });

  let props = PropertiesService.getScriptProperties();
  props.setProperty("SKIP_BUDGET_WEEKDAY_ONEDIT", "1");
  try {
    sheet.getRange(startRow, 2, numRows, 1).setValues(weekdayVals);
  } finally {
    props.deleteProperty("SKIP_BUDGET_WEEKDAY_ONEDIT");
  }
};

/** D2 の日付から年・月のみ取得（日付部分は使わない） */
const findBudgetYearMonthFromD2_ = (sheet) => {
  let d = parseDateValue_(sheet.getRange("D2").getValue());
  if (!d) return null;
  return { year: d.getFullYear(), month: d.getMonth() };
};

/** A列の「日」: 1,2,3… または日だけ持つ Date */
const parseBudgetDayOfMonth_ = (val) => {
  if (val === "" || val == null) return NaN;
  if (typeof val === "number" && !isNaN(val)) return Math.floor(val);
  if (val instanceof Date && !isNaN(val.getTime())) return val.getDate();
  let n = parseInt(String(val).trim(), 10);
  return isNaN(n) ? NaN : n;
};

const parseDateValue_ = (val) => {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  let d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * POSデータ_生 → POSデータ_整形後
 * 商品名クレンジング → 純売上>0（例外あり）→ 税込→税抜 → 統一商品名で合算 → 純売上降順
 */
const formatPosRawToClean = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let rawSheet = ss.getSheetByName(SHEET_NAMES.POS_RAW);
  let cleanSheet = ss.getSheetByName(SHEET_NAMES.POS_CLEAN);
  if (!rawSheet) {
    throw new Error(`「${SHEET_NAMES.POS_RAW}」シートが見つかりません。`);
  }
  if (!cleanSheet) {
    throw new Error(`「${SHEET_NAMES.POS_CLEAN}」シートが見つかりません。`);
  }

  let aggregated = aggregatePosRawSheet(rawSheet);
  writePosCleanSheet(cleanSheet, aggregated);
  let hoppeiCount = aggregated.filter((r) => {
    return r.menuName === "ホッピー白" || r.menuName === "ホッピー黒";
  }).length;
  notifyUser(`POS整形完了: ${aggregated.length} 商品（ホッピー白/黒: ${hoppeiCount}件）を「${SHEET_NAMES.POS_CLEAN}」に出力。オプション系の変換はログを確認。`);
};

const normalizeProductNameBrackets_ = (s) => {
  return s.replace(/</g, "(").replace(/>/g, ")")
    .replace(/[《〈【（\[]/g, "(").replace(/[》〉】）\]]/g, ")");
};

/** 味噌付き商品を先頭括弧除去で消さない */
const PROTECTED_MISO_PRODUCTS_ = {
  "(がつミノ(味噌))": "がつミノ(味噌)",
  "(ハラミの味噌)": "ハラミの味噌",
  "(ハラミ(味噌))": "ハラミ(味噌)"
};

const unwrapProtectedProductParens_ = (s) => {
  return PROTECTED_MISO_PRODUCTS_[s] || s;
};

const isProtectedProductName_ = (s) => {
  return PROTECTED_MISO_PRODUCTS_[s] != null || Object.values(PROTECTED_MISO_PRODUCTS_).indexOf(s) !== -1;
};

const normalizeProductNameChars_ = (s) => {
  try {
    s = s.normalize("NFKC");
  } catch (e) {
    // normalize 非対応環境はそのまま
  }
  return s.replace(/\u3000/g, " ").trim();
};

/** タグ除去後に ホッピー / ホッピー外 なら除外 */
const isOriginalHoppeiToDrop_ = (s) => {
  let t = normalizeProductNameBrackets_(normalizeProductNameChars_(String(s)));
  t = t.replace(/^[0-9]+\.\s*/, "").replace(/^[0-9]{3,}\s*/, "");
  t = t.replace(/^\(.*?\)\s*/, "").trim();
  return t === "ホッピー" || t === "ホッピー外";
};

const hasOptionHoppeiSource_ = (s) => {
  return /オプション/.test(s) && /白|黒/.test(s);
};

const applyOptionHoppeiRenames_ = (s) => {
  s = s.replace(/\(オプション白\)/g, "ホッピー白");
  s = s.replace(/\(オプション黒\)/g, "ホッピー黒");
  s = s.replace(/\(オプション\)\s*白/g, "ホッピー白");
  s = s.replace(/\(オプション\)\s*黒/g, "ホッピー黒");
  // オプション(白) オプション・白 オプション/白 など
  s = s.replace(/オプション\s*[・･\/／\s]*[\(（]?\s*白\s*[\)）]?/g, "ホッピー白");
  s = s.replace(/オプション\s*[・･\/／\s]*[\(（]?\s*黒\s*[\)）]?/g, "ホッピー黒");
  return s;
};

/** オプション グラス → サワーの中身おかわり */
const applyOptionGlassRename_ = (s) => {
  return s.replace(
    /オプション\s*[・･\/／\s]*[\(（]?\s*グラス\s*[\)）]?/g,
    "サワーの中身おかわり"
  );
};

/** はじめの1杯・元の1杯 など特定の末尾括弧を削除 */
const applyFirstCupSuffixStrip_ = (s) => {
  s = s.replace(/^究極レモンサワー\(はじめの1杯\)$/, "究極レモンサワー");
  s = s.replace(/^香ばし茶ハイ\(元の1杯\)$/, "香ばし茶ハイ");
  s = s.replace(/^香ばし茶ハイ\(はじめの1杯\)$/, "香ばし茶ハイ");
  return s;
};

/** サワー・お茶ハイ系のおかわり名寄せ */
const applySawaoiwariUnifyRenames_ = (s) => {
  if (s === "香ばし茶ハイ中身おかわり(やかん)") return "やかんのおかわり";

  let unifyToSawa = {
    "お茶ハイ中身おかわり(グラス)": 1,
    "サワーの中身おかわり(グラス)": 1,
    "サワーの中身のおかわり(グラス)": 1,
    "梅干しサワー(中身おかわり)": 1,
    "香ばし茶ハイ(グラス)": 1,
    "香ばし茶ハイ中身おかわり(グラス)": 1,
    "お茶ハイ中身おかわり(やかん)": 1,
    "サワーの中身おかわり(やかん)": 1,
    "サワーの中身のおかわり(やかん)": 1,
    "香ばし茶ハイ(やかん)": 1,
    "サワーのおかわり(究極)": 1
  };
  return unifyToSawa[s] ? "サワーの中身おかわり" : s;
};

/** 商品ごとの表記ゆれ・名寄せ */
const applyProductUnifyRenames_ = (s) => {
  // 中黒除去（ラテ・ハイ→ラテハイ、コカ・コーラ→コカコーラ）
  s = s.split("・").join("");
  s = s.split("･").join("");

  // こぐまラテハイ → ラテハイ
  if (s === "こぐまラテハイ") s = "ラテハイ";

  // しいたけ: 末尾括弧除去
  s = s.replace(/^しいたけ\(.*\)$/, "しいたけ");

  // ねぎポン酢
  if (s === "ネギポン酢") s = "ねぎポン酢";

  // ハラミ(塩) など → ハラミ（味噌は残す）
  if (s !== "ハラミ(味噌)" && s !== "ハラミの味噌") {
    s = s.replace(/^ハラミ\(.*\)$/, "ハラミ");
  }

  // ヤゲン軟骨(黒胡椒) → ヤゲン軟骨黒胡椒
  s = s.replace(/^ヤゲン軟骨\((.+)\)$/, "ヤゲン軟骨$1");

  // 芋ハイボール系 → だいやめソーダ
  if (s === "芋ハイボール" || s === "芋ハイボール(だいやめ)") s = "だいやめソーダ";

  // スパイス系 → カルダモン
  if (s === "スパイス焼酎ハイボール") s = "カルダモンハイボール";
  if (s === "スパイス紅茶ハイ") s = "カルダモン紅茶ハイ";

  return s;
};

/** 純売上0でも集計に含める行 */
const isZeroSalesExempt_ = (rawName, unifiedName) => {
  if (unifiedName === "ホッピー白" || unifiedName === "ホッピー黒") return true;
  if (unifiedName === "にんごまのおかわり" || unifiedName === "キャベツのおかわり") return true;
  if (isProtectedProductName_(unifiedName)) return true;
  let norm = normalizeProductNameBrackets_(normalizeProductNameChars_(rawName));
  return /オプション/.test(norm) && /グラス/.test(norm);
};

/** オプション除去後に (白) だけ残った場合の救済 */
const resolveOptionHoppeiRemainder_ = (s, normalized) => {
  if (!/オプション/.test(normalized)) return s;
  let bare = s.replace(/[\(（\)）]/g, "").trim();
  if (bare === "白") return "ホッピー白";
  if (bare === "黒") return "ホッピー黒";
  return s;
};

/**
 * POS生データの商品名クレンジング
 */
const cleanProductName = (name) => {
  let raw = normalizeProductNameChars_(String(name == null ? "" : name));
  if (!raw) return "";

  let normalized = normalizeProductNameBrackets_(raw);
  normalized = unwrapProtectedProductParens_(normalized);
  let fromOptionHoppei = hasOptionHoppeiSource_(normalized);
  if (isOriginalHoppeiToDrop_(raw)) return "";

  let s = applyOptionHoppeiRenames_(normalized);
  s = applyOptionGlassRename_(s);
  s = s.replace(/\(ホッピー白\)/g, "ホッピー白");
  s = s.replace(/\(ホッピー黒\)/g, "ホッピー黒");

  s = s.replace(/★+/g, "");
  s = s.replace(/^[0-9]+\.\s*/, "");
  s = s.replace(/^[0-9]{3,}\s*/, "");
  s = s.replace(/^\(.*?\)\s*/, "");
  s = s.trim();
  s = s.split("オプション").join("");
  s = s.trim();
  s = resolveOptionHoppeiRemainder_(s, normalized);

  if (s === "ホッピー" || s === "ホッピー外") return "";

  // (ホッピー)白 等が 白/黒 だけ残る場合は除外（オプション由来は上で ホッピー白/黒 済み）
  if ((s === "白" || s === "黒") && /ホッピー/.test(normalized) && !/オプション/.test(normalized)) return "";

  s = applyFirstCupSuffixStrip_(s);
  s = applySawaoiwariUnifyRenames_(s);
  s = applyProductUnifyRenames_(s);

  // ホッピー白/黒・おかわり系 は名寄せせずそのまま
  if (s === "ホッピー白" || s === "ホッピー黒") return s;
  if (s === "サワーの中身おかわり" || s === "やかんのおかわり"
      || s === "にんごまのおかわり" || s === "キャベツのおかわり") return s;
  if (isProtectedProductName_(s)) return s;

  // ガツミノ表記ゆれのみ → がつミノ（がつミノ(味噌) はそのまま）
  if (s.indexOf("ガツミノ") !== -1) {
    s = s.split("ガツミノ").join("がつミノ");
  }
  if (s.indexOf("生ニンニク") === -1 && s.indexOf("朝挽き") === -1) {
    if (s.indexOf("レバ刺し") !== -1 || s.indexOf("レバネギ") !== -1) {
      s = "レバ刺し";
    }
  }

  return s.trim();
};

/** 生POSを読み、クレンジング後に統一商品名で合算 */
const aggregatePosRawSheet = (rawSheet) => {
  let meta = findPosRawHeaderMeta(rawSheet);
  if (!meta) {
    throw new Error(`「${SHEET_NAMES.POS_RAW}」に 商品名(またはメニュー名/品名)・販売点数・純売上 の見出しが必要です。`);
  }
  if (meta.idxSales === -1) {
    throw new Error(`「${SHEET_NAMES.POS_RAW}」に「純売上」列が見つかりません。`);
  }

  let map = {};
  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let row = meta.fullData[i];
    let rawName = String(row[meta.idxName]).trim();
    if (!rawName) continue;

    let unifiedName = cleanProductName(rawName);
    if (/オプション|ホッピー|^白$|^黒$/.test(rawName)) {
      Logger.log(`[POS整形] ${rawName} → ${unifiedName || "(除外)"}`);
    }
    if (!unifiedName) continue;

    let amount = convertPosSalesToExTax(Number(row[meta.idxSales]) || 0);
    if (amount <= 0 && !isZeroSalesExempt_(rawName, unifiedName)) continue;

    let qty = Number(row[meta.idxQty]) || 0;
    if (!map[unifiedName]) {
      map[unifiedName] = { menuName: unifiedName, salesQty: 0, salesAmount: 0 };
    }
    map[unifiedName].salesQty += qty;
    map[unifiedName].salesAmount += amount;
  }

  let rows = Object.keys(map).map((k) => { return map[k]; });
  rows.sort((a, b) => { return b.salesAmount - a.salesAmount; });
  return rows;
};

const findPosRawHeaderMeta = (sheet) => {
  if (!sheet) return null;
  let lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  let lastCol = Math.max(sheet.getLastColumn(), 1);
  let scanRows = Math.min(lastRow, 20);
  let topRows = sheet.getRange(1, 1, scanRows, lastCol).getValues();
  let nameHeaders = ["商品名", "メニュー名", "品名", "メニュー"];

  for (let i = 0; i < topRows.length; i++) {
    let row = topRows[i].map((cell) => { return String(cell).trim(); });
    let idxQty = row.indexOf("販売点数");
    if (idxQty === -1) continue;

    let idxName = -1;
    let nameHeader = "";
    for (let j = 0; j < nameHeaders.length; j++) {
      let ni = row.indexOf(nameHeaders[j]);
      if (ni !== -1) {
        idxName = ni;
        nameHeader = nameHeaders[j];
        break;
      }
    }
    if (idxName === -1) continue;

    let idxSales = row.indexOf("純売上");
    let dataStartRow = i + 1;
    let firstDataSheetRow = i + 2;
    let numDataRows = lastRow - firstDataSheetRow + 1;
    let fullData;
    if (numDataRows > 0) {
      let dataRows = sheet.getRange(firstDataSheetRow, 1, numDataRows, lastCol).getValues();
      fullData = topRows.slice(0, i + 1).concat(dataRows);
    } else {
      fullData = topRows.slice(0, i + 1);
    }

    return {
      fullData: fullData,
      dataStartRow: dataStartRow,
      nameHeader: nameHeader,
      idxName: idxName,
      idxQty: idxQty,
      idxSales: idxSales
    };
  }
  return null;
};

const writePosCleanSheet = (cleanSheet, rows) => {
  let meta = findHeaderRowAndIndices(cleanSheet, ["統一商品名", "販売点数", POS_SALES_HEADER_EX_TAX]);
  if (!meta) {
    meta = findHeaderRowAndIndices(cleanSheet, ["統一商品名", "販売点数", "純売上"]);
  }
  let dataStartRow;
  let idxName;
  let idxQty;
  let idxSales;

  if (meta) {
    dataStartRow = meta.dataStartRow + 1;
    idxName = meta.headers.indexOf("統一商品名") + 1;
    idxQty = meta.headers.indexOf("販売点数") + 1;
    let salesMeta = findPosSalesColumnMeta_(meta.headers);
    idxSales = salesMeta.idx + 1;
    if (salesMeta.idx !== -1 && !salesMeta.exTax) {
      cleanSheet.getRange(meta.headerRowIdx + 1, idxSales).setValue(POS_SALES_HEADER_EX_TAX);
    }
  } else {
    dataStartRow = 2;
    idxName = 1;
    idxQty = 2;
    idxSales = 3;
    cleanSheet.getRange(1, 1, 1, 3).setValues([["統一商品名", "販売点数", POS_SALES_HEADER_EX_TAX]]);
  }

  let lastRow = cleanSheet.getLastRow();
  if (lastRow >= dataStartRow) {
    let numCols = Math.max(idxName, idxQty, idxSales);
    cleanSheet.getRange(dataStartRow, 1, lastRow - dataStartRow + 1, numCols).clearContent();
  }

  if (rows.length === 0) return;

  let numCols = Math.max(idxName, idxQty, idxSales > 0 ? idxSales : 0);
  let normalized = rows.map((r) => {
    let full = new Array(numCols).fill("");
    full[idxName - 1] = r.menuName;
    full[idxQty - 1] = r.salesQty;
    if (idxSales > 0) full[idxSales - 1] = r.salesAmount;
    return full;
  });

  cleanSheet.getRange(dataStartRow, 1, normalized.length, numCols).setValues(normalized);
};

/**
 * 確定コミット: バックログへ最終反映 + 手動調整を AI予測手動調整ログ へ出力
 */
const commitOrderSheetToBacklogAndLog = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  if (!orderSheet) {
    throw new Error(`「${SHEET_NAMES.ORDER_FORM}」シートが見つかりません。`);
  }

  let logSheet = ss.getSheetByName(SHEET_NAMES.MANUAL_ADJUSTMENT_LOG);
  if (!logSheet) {
    throw new Error(`「${SHEET_NAMES.MANUAL_ADJUSTMENT_LOG}」シートが見つかりません。`);
  }

  let rawDate = orderSheet.getRange("B2").getValue();
  if (!rawDate || isNaN(new Date(rawDate).getTime())) {
    throw new Error("指示書 B2 に有効な日付を入力してください。");
  }
  let dateStr = formatJstDate_(rawDate);
  let aiSnapshot = loadOrderSheetAiSnapshot_(dateStr);
  let rawMaster = loadRawMaterialMasterCached_(ss);

  let backlogRows = buildCommittedBacklogRows_(dateStr, orderSheet, aiSnapshot, rawMaster);
  let backlogCount = replaceBacklogRowsForDate_(dateStr, backlogRows);

  let entries = collectManualAdjustmentEntries(orderSheet, aiSnapshot, rawMaster);
  writeManualAdjustmentLogForDate(logSheet, dateStr, entries);

  notifyUser(`確定コミット: ${dateStr} / バックログ ${backlogCount} 件 / 手動調整ログ ${entries.length} 件`);
};

/** メニュー互換 */
const exportManualAdjustmentToLog = () => {
  commitOrderSheetToBacklogAndLog();
};

/**
 * デバッグ用: バックログ系の履歴を一括削除
 * メニュー「発注管理」または Apps Script から resetBacklogRelatedHistory() を実行
 */
function resetBacklogRelatedHistory() {
  let ui = SpreadsheetApp.getUi();
  let answer = ui.alert(
    "バックログ系データの一括削除",
    "次をすべて削除します（元に戻せません）。\n"
      + "・バックログ\n"
      + "・予測出数ログ\n"
      + "・棚卸し履歴（週次原価率の前回日付もリセット）\n"
      + "・AIスナップショット（確定コミット比較用）\n"
      + "・AI予測手動調整ログ\n\n"
      + "続けますか？",
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let backlogRows = clearBacklogSheetData_(ss);
  let forecastRows = clearForecastDemandLogData_(ss);
  let stockResult = clearStockSnapshotHistory_(ss);
  let aiSnapshots = clearAiSnapshotProperties_();
  let manualLogRows = clearManualAdjustmentLogData_(ss);

  Logger.log(`[バックログ系リセット] バックログ=${backlogRows} 予測出数ログ=${forecastRows} 棚卸し履歴=${stockResult.clearedRows} AIスナップショット=${aiSnapshots} 手動調整ログ=${manualLogRows}`);

  notifyUser(
    `削除完了\nバックログ ${backlogRows} 行\n予測出数ログ ${forecastRows} 行\n棚卸し履歴 ${stockResult.clearedRows} 行\nAIスナップショット ${aiSnapshots} 件\n手動調整ログ ${manualLogRows} 行`,
    "バックログ系リセット"
  );
}

/** 指示書から手動調整ログ対象行を収集（AI予測との差分・変更量・理由・O4:Q5手動入力） */
const collectManualAdjustmentEntries = (orderSheet, aiSnapshot, rawMaster) => {
  let entries = [];
  ["仕込み", "発注"].forEach((category) => {
    readOrderSheetBlockRows_(orderSheet, category, aiSnapshot).forEach((entry) => {
      if (shouldLogManualAdjustmentEntry_(entry)) entries.push(entry);
    });
  });

  if (!rawMaster) {
    rawMaster = loadRawMaterialMasterCached_(orderSheet.getParent());
  }
  let sheetOrderNames = {};
  entries.forEach((e) => {
    if (e.category === "発注") sheetOrderNames[e.name] = true;
  });

  readOrderSheetManualEntries(orderSheet, { rawMaster: rawMaster }).forEach((entry) => {
    let aiEntry = aiSnapshot && aiSnapshot.order ? aiSnapshot.order[entry.name] : null;
    let logEntry = {
      name: entry.name,
      category: entry.category,
      qty: entry.qty,
      unit: entry.unit,
      changeQty: "",
      reason: "手動入力（O列）",
      aiQty: aiEntry ? aiEntry.qty : null,
      aiUnit: aiEntry ? aiEntry.unit : "",
      source: "manual"
    };
    if (shouldLogManualAdjustmentEntry_(logEntry)) {
      if (!sheetOrderNames[entry.name]) {
        entries.push(logEntry);
      } else {
        let idx = -1;
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].name === entry.name && entries[i].category === "発注") {
            idx = i;
            break;
          }
        }
        if (idx >= 0) {
          entries[idx].qty = entry.qty;
          entries[idx].unit = entry.unit;
          entries[idx].reason = entries[idx].reason
            ? entries[idx].reason + " / 手動入力（O列）" : "手動入力（O列）";
        } else {
          entries.push(logEntry);
        }
      }
    }
  });

  return entries;
};

/** 同一日付の行を差し替えてログを更新 */
const writeManualAdjustmentLogForDate = (logSheet, dateStr, entries) => {
  let meta = findHeaderRowAndIndices(logSheet, ["日付", "商材名", "分類"]);
  if (!meta) {
    throw new Error(`「${SHEET_NAMES.MANUAL_ADJUSTMENT_LOG}」に 日付・商材名・分類 の見出しがありません。`);
  }

  let idxDate = meta.headers.indexOf("日付");
  let idxName = meta.headers.indexOf("商材名");
  let idxType = meta.headers.indexOf("分類");
  let idxQty = meta.headers.indexOf("確定量");
  let idxUnit = meta.headers.indexOf("単位");
  let idxAiQty = findColumnIndex_(meta.headers, ["AI予測量", "AI予測数量", "自動指示量"]);
  let idxChange = findColumnIndex_(meta.headers, ["変更量", "仕込み変更量", "発注変更量"]);
  let idxReason = findColumnIndex_(meta.headers, ["調整理由", "仕込み調整理由", "発注調整理由"]);
  let numCols = meta.headers.length;

  let kept = [];
  for (let i = meta.dataStartRow; i < meta.fullData.length; i++) {
    let row = meta.fullData[i];
    let rawDate = row[idxDate];
    if (!rawDate) {
      kept.push(row);
      continue;
    }
    let rowDateStr = formatJstDate_(rawDate);
    if (rowDateStr !== dateStr) kept.push(row);
  }

  let newRows = entries.map((e) => {
    let row = new Array(numCols).fill("");
    row[idxDate] = new Date(dateStr + "T12:00:00");
    row[idxName] = e.name;
    row[idxType] = e.category;
    if (idxQty !== -1) row[idxQty] = e.qty;
    if (idxUnit !== -1) row[idxUnit] = e.unit;
    if (idxAiQty !== -1 && e.aiQty !== null && e.aiQty !== undefined) row[idxAiQty] = e.aiQty;
    if (idxChange !== -1 && e.changeQty !== "" && e.changeQty != null) row[idxChange] = e.changeQty;
    if (idxReason !== -1 && e.reason) row[idxReason] = e.reason;
    return row;
  });

  let allRows = kept.concat(newRows);
  let startRow = meta.dataStartRow + 1;
  let lastRow = logSheet.getLastRow();
  if (lastRow >= startRow) {
    logSheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).clearContent();
  }
  if (allRows.length > 0) {
    logSheet.getRange(startRow, 1, allRows.length, numCols).setValues(allRows);
  }
};
