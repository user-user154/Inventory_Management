/**
 * 4. utility.gs: 計算補助・マスタ基準単位換算・指示書逆算出力関数群
 *
 * 【原材料マスタの単位関係】
 *   1 発注単位 (orderUnit) ＝ 1 包装 ＝ 商品ロット (lotQty) × 商品ロット単位 (lotUnit)
 *   例: キャベツ … lotQty=1, lotUnit=kg, orderUnit=パック → 1パック=1kg=1000g
 *   最低在庫(minStock)は「発注単位」基準 → 最小単位 = minStock × lotSizeToMinUnit(lotQty, lotUnit)
 *   最大在庫(maxStock)も「発注単位」基準 … 納品時（入荷後・当日消費前）にこれ以上抱えられない上限。
 *   発注量は不足分を満たしつつこの上限以下に収める（上限ぎりぎりが常態とは限らない）。
 */

const normalizeUnitKey = (unitStr) => {
  return String(unitStr).trim().toLowerCase();
};

const isMassVolumeLargeUnit = (unitStr) => {
  let u = normalizeUnitKey(unitStr);
  return u === "kg" || u === "l" || String(unitStr).trim() === "リットル";
};

const isMassVolumeBaseUnit = (unitStr) => {
  let u = normalizeUnitKey(unitStr);
  return u === "g" || u === "ml";
};

/** パック・袋・箱・本など「1ロット包装」を表す単位 */
const isPackagingUnit = (unitStr) => {
  let u = String(unitStr).trim();
  return /(パック|袋|箱|ケース|ロット|束|ダース|荷|本)/.test(u);
};

const unitsEquivalent = (unitA, unitB) => {
  if (!unitA || !unitB) return false;
  return String(unitA).trim() === String(unitB).trim();
};

/** 仕込み単位が「人前」か */
const isServingUnit_ = (unitStr) => {
  return String(unitStr || "").trim() === "人前";
};

/** 個・玉・枚などの個数単位 */
const isCountPieceUnit_ = (unitStr) => {
  let u = String(unitStr || "").trim();
  return u === "個" || u === "玉" || u === "枚";
};

/** 「カケ」（掛け/欠け表記ゆれ含む） */
const isKakeUnit_ = (unitStr) => {
  let u = String(unitStr || "").trim();
  return u === "カケ" || u === "掛け" || u === "欠け" || normalizeUnitKey(u) === "かけ";
};

/** 人前・カケなど「1単位=1出数」系の仕込み単位 */
const isServingLikeUnit_ = (unitStr) => {
  return isServingUnit_(unitStr) || isKakeUnit_(unitStr);
};

/** 単位が同じ換算系か（個↔人前、カケ↔人前 等） */
const unitsInSameConversionFamily_ = (unitA, unitB) => {
  if (unitsEquivalent(unitA, unitB)) return true;
  if (isServingLikeUnit_(unitA) && isServingLikeUnit_(unitB)) return true;
  if (isCountPieceUnit_(unitA) && (isCountPieceUnit_(unitB) || isServingLikeUnit_(unitB))) return true;
  if (isKakeUnit_(unitA) && (isCountPieceUnit_(unitB) || isServingLikeUnit_(unitB))) return true;
  return false;
};

/**
 * 材料1行を targetUnit 換算の数量へ（中間レシピ・原材料マスタ参照）
 */
const ingredientQtyToTargetUnit_ = (ing, targetUnit, ctx, stack) => {
  let qty = Number(ing.qty) || 0;
  if (qty <= 0) return 0;

  let u = String(ing.unit || "").trim();
  let target = String(targetUnit || "").trim();
  if (unitsInSameConversionFamily_(u, target)) return qty;

  if (normalizeUnitKey(target) === "g") {
    if (u === "g") return qty;
    if (u === "kg") return qty * 1000;
  }
  if (normalizeUnitKey(target) === "ml") {
    if (u === "ml") return qty;
    if (u === "L" || u === "リットル") return qty * 1000;
  }

  if (!ctx) return 0;

  let routed = routeUnifiedMaterial_(ing.name, ctx);
  if (routed.kind === "raw" && ctx.rawMaster[routed.name]) {
    let raw = ctx.rawMaster[routed.name];
    let minQty = convertToMinUnit(qty, u, raw);
    let minLabel = getMinUnitLabel(raw);
    if (normalizeUnitKey(target) === "g" && (normalizeUnitKey(minLabel) === "g" || raw.lotUnit === "kg")) {
      return minQty;
    }
    if (normalizeUnitKey(target) === "ml" && normalizeUnitKey(minLabel) === "ml") {
      return minQty;
    }
    if (unitsInSameConversionFamily_(minLabel, target)) return minQty;
    if (isServingLikeUnit_(target) && isKakeUnit_(raw.lotUnit) && isCountPieceUnit_(minLabel)) {
      let perKake = Number(raw.lotQty) || 1;
      return perKake > 0 ? minQty / perKake : minQty;
    }
    if (isKakeUnit_(target) && isCountPieceUnit_(raw.lotUnit)) {
      return minQty * (Number(raw.lotQty) || 1);
    }
  }

  if (routed.kind === "prep" && ctx.preparationRecipes[routed.name]) {
    let nestedName = routed.name;
    if (stack.indexOf(nestedName) !== -1) return 0;
    stack.push(nestedName);
    let nested = ctx.preparationRecipes[nestedName];
    let nestedAmount = convertQtyBetweenPrepUnits_(qty, u, nested, nestedName, ctx);
    if (nestedAmount == null || isNaN(nestedAmount)) nestedAmount = qty;
    let nestedBatchTarget = sumPrepBatchQtyInUnit_(nested, nestedName, target, ctx, stack);
    let nestedLot = Number(nested.finishedQty) || 1;
    let result = nestedLot > 0 ? nestedAmount * nestedBatchTarget / nestedLot : 0;
    stack.pop();
    return result;
  }

  return 0;
};

/**
 * 中間レシピ1ロット分を targetUnit で合計（g→人前と同型）
 * 仕込み単位そのもののときは finishedQty を返す
 */
const sumPrepBatchQtyInUnit_ = (prep, prepName, targetUnit, ctx, stack) => {
  if (!prep) return 0;

  let target = String(targetUnit || "").trim();
  let prepUnit = String(prep.processUnit || "").trim();
  let lotSize = Number(prep.finishedQty) || 1;
  let rule = prepName ? getPrepOrderSheetDisplayRule_(prepName) : null;

  if (unitsEquivalent(target, prepUnit) || (isServingLikeUnit_(target) && isServingLikeUnit_(prepUnit))) {
    return lotSize;
  }

  let total = 0;
  (prep.ingredients || []).forEach((ing) => {
    total += ingredientQtyToTargetUnit_(ing, target, ctx, stack || []);
  });

  if (total <= 0 && rule) {
    if (normalizeUnitKey(target) === "g" && Number(rule.gramsPerServing) > 0) {
      return Number(rule.gramsPerServing) * lotSize;
    }
    if ((isCountPieceUnit_(target) || isServingLikeUnit_(target)) && Number(rule.piecesPerServing) > 0) {
      return Number(rule.piecesPerServing) * lotSize;
    }
  }

  return total;
};

/** 商品ロット単位 (lotUnit) 上の数量 → 最小単位 (g/ml/個) */
const convertLotContentToMin = (qty, lotUnitStr) => {
  let q = Number(qty) || 0;
  if (isMassVolumeLargeUnit(lotUnitStr)) return q * 1000;
  if (isMassVolumeBaseUnit(lotUnitStr)) return q;
  return q;
};

/** 1 包装あたりの最小単位量 (1発注単位 = lotQty × lotUnit) */
const lotSizeToMinUnit = (lotQty, lotUnitStr) => {
  return convertLotContentToMin(Number(lotQty) || 1, lotUnitStr);
};

/** 最小単位の表示ラベル */
const getMinUnitLabel = (rawRow) => {
  if (!rawRow) return "個";
  let lotU = normalizeUnitKey(rawRow.lotUnit);
  if (lotU === "kg") return "g";
  if (lotU === "l" || rawRow.lotUnit === "リットル") return "ml";
  if (isMassVolumeBaseUnit(rawRow.lotUnit)) return rawRow.lotUnit;
  return rawRow.lotUnit || "個";
};

/** 中間レシピ品名に対応する歩留まり（未登録・無効時は 1） */
const resolveYieldRate_ = (prepName, ctx) => {
  if (!ctx || !ctx.yieldMap) return 1;
  let name = resolveCanonicalName_(prepName, ctx.nameUnifyMap);
  let rate = ctx.yieldMap[name];
  if (rate === undefined && name !== prepName) rate = ctx.yieldMap[prepName];
  if (rate === undefined || rate === null || rate === "") return 1;
  rate = Number(rate);
  if (isNaN(rate) || rate <= 0 || rate > 1) return 1;
  return rate;
};

/** 出来上がり量を歩留まりで割り、原材料の投入量（総量）へ換算 */
const applyYieldGrossQty_ = (finishedQty, prepName, ctx, skipYield) => {
  let qty = Number(finishedQty) || 0;
  if (qty <= 0) return 0;
  if (skipYield) return qty;
  let rate = resolveYieldRate_(prepName, ctx);
  return rate >= 1 ? qty : qty / rate;
};

/**
 * 任意単位 → 最小単位へ変換（棚卸し・消費・在庫計算共通）
 */
const convertToMinUnit = (qty, unitStr, rawRow) => {
  let q = Number(qty) || 0;
  if (!rawRow || q === 0) return q;

  let inputUnit = String(unitStr).trim();
  let lotUnit = String(rawRow.lotUnit).trim();
  let orderUnit = String(rawRow.orderUnit).trim();
  let onePackMin = lotSizeToMinUnit(rawRow.lotQty, lotUnit);

  if (isMassVolumeLargeUnit(inputUnit)) return q * 1000;
  if (isMassVolumeBaseUnit(inputUnit)) return q;

  if (unitsEquivalent(inputUnit, lotUnit)) {
    return convertLotContentToMin(q, lotUnit);
  }

  if (unitsEquivalent(inputUnit, orderUnit) || isPackagingUnit(inputUnit)) {
    return q * onePackMin;
  }

  // 発注単位が「本」など包装系だが入力が個・玉などの個数単位
  if (isPackagingUnit(orderUnit) && isCountPieceUnit_(inputUnit)) {
    return q * onePackMin;
  }

  // カケ ↔ 個（商品ロット単位が個: 1カケ = lotQty個、未設定時は1:1）
  if (isKakeUnit_(inputUnit) && isCountPieceUnit_(lotUnit)) {
    return q * (Number(rawRow.lotQty) || 1);
  }
  if (isCountPieceUnit_(inputUnit) && isKakeUnit_(lotUnit)) {
    let perKake = Number(rawRow.lotQty) || 1;
    return perKake > 0 ? q / perKake : q;
  }
  if (isKakeUnit_(inputUnit) && isKakeUnit_(lotUnit)) {
    return convertLotContentToMin(q, lotUnit);
  }
  if (isCountPieceUnit_(inputUnit) && isCountPieceUnit_(lotUnit)) {
    return unitsEquivalent(inputUnit, lotUnit) ? q : q * (Number(rawRow.lotQty) || 1);
  }

  return q;
};

/**
 * 仕込み品の単位相互換算（中間レシピ・原材料マスタ参照、g→人前と同型のロット比率）
 * @param {object} [ctx] シミュレーションコンテキスト（原材料マスタ参照用）
 * @return {number|null} 換算後数量（第2引数 from → 仕込み単位）。不可時は null
 */
const convertQtyBetweenPrepUnits_ = (qty, fromUnit, prep, prepName, ctx) => {
  if (!prep || qty <= 0) return null;

  let from = String(fromUnit || "").trim();
  let prepUnit = String(prep.processUnit || "").trim();
  if (from === prepUnit) return qty;

  let rule = prepName ? getPrepOrderSheetDisplayRule_(prepName) : null;

  // 1ロット内の材料合計比で換算（g→人前・個→カケ 等を同一ロジック）
  let totalFrom = sumPrepBatchQtyInUnit_(prep, prepName, from, ctx, []);
  let totalTo = sumPrepBatchQtyInUnit_(prep, prepName, prepUnit, ctx, []);
  if (totalFrom > 0 && totalTo > 0) {
    return qty * totalTo / totalFrom;
  }

  // 質量 → 人前/カケ（材料にgが無いとき resolvePrepGramsPerServing_ へ）
  let gPerServing = resolvePrepGramsPerServing_(prep, rule, ctx);
  if (isServingLikeUnit_(prepUnit) && (isMassVolumeBaseUnit(from) || isMassVolumeLargeUnit(from))) {
    let grams = isMassVolumeLargeUnit(from) ? qty * 1000 : qty;
    return gPerServing > 0 ? grams / gPerServing : null;
  }
  if (isServingLikeUnit_(from) && normalizeUnitKey(prepUnit) === "g") {
    return gPerServing > 0 ? qty * gPerServing : null;
  }

  // g / kg / ml / L → g, ml, kg 等（質量・容量同系）
  if (isMassVolumeLargeUnit(from) || isMassVolumeBaseUnit(from)) {
    let stockMin = convertLotContentToMin(qty, from);
    let prepKey = normalizeUnitKey(prepUnit);
    if (prepKey === "g") return stockMin;
    if (prepKey === "ml") return stockMin;
    if (prepKey === "kg" || prepUnit === "リットル") return stockMin / 1000;
  }

  // マスタ・レシピから導出できないときのみ 1:1（個↔人前はレシピ必須のため除外）
  if (isServingLikeUnit_(from) && isServingLikeUnit_(prepUnit)) return qty;
  if (isCountPieceUnit_(from) && isCountPieceUnit_(prepUnit)) return qty;
  if (isKakeUnit_(from) && isCountPieceUnit_(prepUnit)) return qty;
  if (isCountPieceUnit_(from) && isKakeUnit_(prepUnit)) return qty;

  return null;
};

/**
 * 仕込み品の棚卸し数量を仕込み需要の単位へ換算
 * 棚卸しC列は発注単位・商品ロット単位での記述も想定
 * @param {string} [prepName] 表示ルール参照用（任意）
 */
const convertPrepStockToProcessQty_ = (stock, prep, prepName, ctx) => {
  let q = Number(stock && stock.qty) || 0;
  if (q <= 0 || !prep) return 0;

  let stockUnit = String(stock.unit).trim();
  let prepUnit = String(prep.processUnit).trim();
  if (stockUnit === prepUnit) return q;

  // 発注単位（パック・箱・本 等）: 1単位 = 1仕込みロット分
  if (isPackagingUnit(stockUnit) || stockUnit === "本") {
    let lotSize = Number(prep.finishedQty) || 1;
    Logger.log(`[棚卸し] 仕込み品を発注単位で換算: ${stockUnit}×${q} → ${q * lotSize}${prepUnit}`);
    return q * lotSize;
  }

  let converted = convertQtyBetweenPrepUnits_(q, stockUnit, prep, prepName, ctx);
  if (converted != null && !isNaN(converted)) {
    Logger.log(`[棚卸し] 仕込み品単位換算: ${q}${stockUnit} → ${converted}${prepUnit}${prepName ? ` (${prepName})` : ""}`);
    return converted;
  }

  Logger.log(`[警告] 仕込み品棚卸しの単位換算不可: 棚卸し=${stockUnit} / 仕込み単位=${prepUnit}${prepName ? ` / 仕込み品=${prepName}` : ""}`);
  return 0;
};

/**
 * マスタ単位の整合性チェック（棚卸単位が換算可能か）
 */
const auditRawUnitConversion = (rawRow, stockUnit) => {
  let issues = [];
  if (!rawRow) return issues;

  let inputUnit = String(stockUnit || "").trim();
  let lotUnit = rawRow.lotUnit;
  let orderUnit = rawRow.orderUnit;

  if (isPackagingUnit(lotUnit) && isPackagingUnit(orderUnit) && !unitsEquivalent(lotUnit, orderUnit)) {
    issues.push("商品ロット単位「" + lotUnit + "」と発注単位「" + orderUnit + "」が両方包装系で不一致");
  }

  if (inputUnit) {
    let convertible = isMassVolumeLargeUnit(inputUnit) || isMassVolumeBaseUnit(inputUnit)
      || unitsEquivalent(inputUnit, lotUnit) || unitsEquivalent(inputUnit, orderUnit)
      || isPackagingUnit(inputUnit)
      || isCountPieceUnit_(inputUnit) || isKakeUnit_(inputUnit)
      || (isCountPieceUnit_(inputUnit) && (isCountPieceUnit_(lotUnit) || isKakeUnit_(lotUnit)))
      || (isKakeUnit_(inputUnit) && (isCountPieceUnit_(lotUnit) || isKakeUnit_(lotUnit)));
    if (!convertible) {
      issues.push("棚卸単位「" + inputUnit + "」をマスタ (lot:" + rawRow.lotQty + lotUnit + " / 発注:" + orderUnit + ") と関連付けできません");
    }
  }
  return issues;
};

/**
 * 仕込み需要量を仕込みロット単位で切り上げ
 */
const calcPrepLotAndAmount = (demand, lotSize) => {
  let size = Number(lotSize) || 1;
  if (demand <= 0 || size <= 0) return { lotCount: 0, prepAmount: 0 };
  let lotCount = Math.ceil(demand / size);
  return { lotCount: lotCount, prepAmount: size * lotCount };
};

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

const getJapaneseWeekday = (dateObj) => {
  return WEEKDAY_JA[new Date(dateObj).getDay()];
};

/** 祝日カレンダー（日本）— 取得失敗時は祝日配送不可として扱う */
const isJapanesePublicHoliday = (dateObj) => {
  try {
    let cal = CalendarApp.getCalendarById("ja.japanese#holiday@group.v.calendar.google.com");
    if (!cal) return false;
    let d = new Date(dateObj);
    d.setHours(12, 0, 0, 0);
    return cal.getEventsForDay(d).length > 0;
  } catch (e) {
    return false;
  }
};

/**
 * 指定日に業者が納品可能か（曜日 0=可/1=不可, 祝日は J列）
 * holidayCache: シミュレーション中の祝日判定キャッシュ（任意）
 */
const isVendorDeliveryAllowed = (vCal, deliveryDate, holidayCache) => {
  if (!vCal || Number(vCal.stopFlag) === 1) return false;

  let dow = getJapaneseWeekday(deliveryDate);
  if (Number(vCal[dow]) === 1) return false;

  if (isJapanesePublicHolidayCached(deliveryDate, holidayCache)) {
    return vCal.holidayDelivery === true;
  }
  return true;
};

const isJapanesePublicHolidayCached = (dateObj, cache) => {
  let key = Utilities.formatDate(new Date(dateObj), "JST", "yyyy-MM-dd");
  if (cache) {
    if (cache[key] !== undefined) return cache[key];
    cache[key] = isJapanesePublicHoliday(dateObj);
    return cache[key];
  }
  return isJapanesePublicHoliday(dateObj);
};

/** Date → yyyy-MM-dd（JST） */
const formatJstDate_ = (date) => {
  return Utilities.formatDate(new Date(date), "JST", "yyyy-MM-dd");
};

/** シミュレーション結果配列用の日インデックスを範囲内に収める */
const clampDayIndex_ = (idx, length) => {
  if (idx < 0) idx = 0;
  if (length > 0 && idx >= length) idx = length - 1;
  return idx;
};

/** 見出し配列から候補名の列インデックスを探す（見つからなければ fallback） */
const findColumnIndex_ = (headers, candidates, fallbackIdx) => {
  for (let i = 0; i < candidates.length; i++) {
    let idx = headers.indexOf(candidates[i]);
    if (idx !== -1) return idx;
  }
  return fallbackIdx !== undefined ? fallbackIdx : -1;
};

/** 見出し名称の完全一致で列インデックスを返す */
const findExactHeaderColumn_ = (headers, name) => {
  if (!headers || !name) return -1;
  return headers.indexOf(String(name).trim());
};

/** パーセント表示セルの値を小数比率へ（32 → 0.32、0.32 はそのまま） */
const parseRatioCellValue_ = (val) => {
  if (val === "" || val == null) return null;
  let n = Number(val);
  if (isNaN(n)) return null;
  if (n > 1) return n / 100;
  return n;
};

const addDaysToDateStr_ = (dateStr, days) => {
  let d = parseJstDateStr_(dateStr);
  d.setDate(d.getDate() + days);
  return formatJstDate_(d);
};

/** バックログ発注日 + 業者LT → 納品日（納品不可曜日・祝日は翌日以降へ繰り上げ） */
const resolveDeliveryDateStrForBacklogOrder_ = (orderDateStr, vCal, holidayCache) => {
  if (!orderDateStr) return null;
  let lt = Math.max(0, Number(vCal && vCal.leadTime) || 0);
  let deliveryStr = addDaysToDateStr_(orderDateStr, lt);
  if (!vCal) return deliveryStr;

  for (let i = 0; i < 14; i++) {
    let deliveryDate = parseJstDateStr_(deliveryStr);
    if (isVendorDeliveryAllowed(vCal, deliveryDate, holidayCache)) return deliveryStr;
    deliveryStr = addDaysToDateStr_(deliveryStr, 1);
  }
  return deliveryStr;
};

/** 業者マスタから最大リードタイム（日） */
const getMaxVendorLeadTimeFromCalendars_ = (vendorCalendars) => {
  let maxLt = 0;
  Object.keys(vendorCalendars || {}).forEach((vName) => {
    maxLt = Math.max(maxLt, Number(vendorCalendars[vName].leadTime) || 0);
  });
  return maxLt;
};

const enumerateDateKeys_ = (fromDateStr, toDateStr) => {
  let keys = [];
  let cur = parseJstDateStr_(fromDateStr);
  let end = parseJstDateStr_(toDateStr);
  if (isNaN(cur.getTime()) || isNaN(end.getTime()) || cur > end) return keys;
  while (cur <= end) {
    keys.push(formatJstDate_(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
};

/** 原材料ごとの発注ロット（最小単位）。未設定時はマスタの商品ロットを使用 */
const RAW_ORDER_LOT_MIN_UNIT_RULES_ = {
  "レモン": 40
};

/**
 * 自動発注指示のみ出さない原材料（レシピ展開・原価計算には含める）
 * 停止フラグ=1 の原材料は expandMenuToDemands 等ですべての計算から除外される。
 */
const RAW_SKIP_AUTO_ORDER_ = {
  "生ビール": true
};

/** 自動発注をスキップするか（停止フラグ・手動発注対象） */
const shouldSkipRawAutoOrder_ = (rawRow, rName) => {
  if (!rawRow) return true;
  if (Number(rawRow.stopFlag) === 1) return true;
  return !!(rName && RAW_SKIP_AUTO_ORDER_[rName]);
};

/** 発注量の切上げ単位（最小単位）を解決 */
const resolveRawOrderLotSizeMinUnit_ = (rName, rawRow) => {
  if (rName && Number(RAW_ORDER_LOT_MIN_UNIT_RULES_[rName]) > 0) {
    return Number(RAW_ORDER_LOT_MIN_UNIT_RULES_[rName]);
  }
  if (!rawRow) return 0;
  return lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
};

/** 指示書発注欄の表示変換（レモンは個数そのまま表示） */
const getRawOrderSheetDisplayRule_ = (rName) => {
  if (rName && RAW_ORDER_LOT_MIN_UNIT_RULES_[rName] > 0) {
    return { unit: "個", showMinUnit: true };
  }
  return null;
};

/** 発注AI量を指示書表示用の発注単位・数量へ変換 */
const formatOrderSheetOrderQty_ = (aiQty, rawMasterRow, rName) => {
  let minQty = Number(aiQty) || 0;
  let unit = rawMasterRow ? (rawMasterRow.orderUnit || "個") : "個";
  let displayQty = minQty;

  let rule = rName ? getRawOrderSheetDisplayRule_(rName) : null;
  if (rule && rule.showMinUnit) {
    return { qty: minQty, unit: rule.unit || "個", aiQty: minQty };
  }

  if (rawMasterRow && minQty > 0) {
    let denom = lotSizeToMinUnit(rawMasterRow.lotQty, rawMasterRow.lotUnit);
    if (denom > 0) displayQty = Math.ceil(minQty / denom);
  }
  return { qty: displayQty, unit: unit, aiQty: minQty };
};

/** シート日付セル → yyyy-MM-dd */
const formatSheetDateToKey = (val) => {
  if (!val) return "";
  if (val instanceof Date) return Utilities.formatDate(val, "JST", "yyyy-MM-dd");
  let tmp = new Date(val);
  return !isNaN(tmp.getTime()) ? Utilities.formatDate(tmp, "JST", "yyyy-MM-dd") : String(val).trim();
};

/** 見出し行だけ読む（全シート getDataRange を避ける） */
const findSheetHeaderMeta = (sheet, requiredHeaders) => {
  if (!sheet) return null;
  let lastCol = Math.max(sheet.getLastColumn(), 1);
  let scanRows = Math.min(Math.max(sheet.getLastRow(), 1), 20);
  let topRows = sheet.getRange(1, 1, scanRows, lastCol).getValues();

  for (let i = 0; i < topRows.length; i++) {
    let row = topRows[i].map((cell) => { return String(cell).trim(); });
    let matchAll = requiredHeaders.every((h) => { return row.indexOf(h) !== -1; });
    if (matchAll) {
      return {
        headerRowIdx: i,
        dataStartRow: i + 1,
        headers: row,
        numCols: row.length
      };
    }
  }
  return null;
};

/** バックログ列定義（A1 から自動作成） */
const BACKLOG_HEADERS = [
  "日付", "商材名", "分類", "数量", "—", "—", "最小単位量", "表示数量", "売上基準"
];

/** 月跨ぎ計算用に前月末付近だけ残す日数 */
const BACKLOG_MONTH_BRIDGE_DAYS_ = 7;

/** 既存見出しがあればそれを、なければ A1 に BACKLOG_HEADERS を書いて meta を返す */
const ensureBacklogSheetMeta_ = (sheet) => {
  if (!sheet) return null;

  let candidates = [
    ["日付", "商材名", "分類"],
    ["日付", "商材名", "種別"],
    ["日付", "名称", "分類"]
  ];
  for (let i = 0; i < candidates.length; i++) {
    let meta = findSheetHeaderMeta(sheet, candidates[i]);
    if (meta) return meta;
  }

  sheet.getRange(1, 1, 1, BACKLOG_HEADERS.length).setValues([BACKLOG_HEADERS]);
  return {
    headerRowIdx: 0,
    dataStartRow: 2,
    headers: BACKLOG_HEADERS.slice(),
    numCols: BACKLOG_HEADERS.length
  };
};

/** 棚卸し日以降のバックログ置換開始行（日付列のみ読取） */
const findBacklogReplaceStartRow = (sheet, meta, inventoryDateStr) => {
  if (!sheet || !meta) return meta.dataStartRow;
  let startRow = meta.dataStartRow;
  let idxDate = meta.headers.indexOf("日付");
  if (idxDate < 0 || !inventoryDateStr) return startRow;

  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return startRow;

  let dateCol = sheet.getRange(startRow, idxDate + 1, lastRow - startRow + 1, 1).getValues();
  for (let i = 0; i < dateCol.length; i++) {
    let rowDateStr = formatSheetDateToKey(dateCol[i][0]);
    if (rowDateStr && rowDateStr >= inventoryDateStr) return startRow + i;
  }
  return lastRow + 1;
};

const parseJstDateStr_ = (dateStr) => {
  return new Date(String(dateStr).trim() + "T12:00:00");
};

const startOfMonthJst_ = (date) => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const endOfMonthJst_ = (date) => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
};

/** 棚卸し表 B1 の日付（yyyy-MM-dd） */
const getInventoryDateStrFromSheet_ = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stockSheet = ss ? ss.getSheetByName(SHEET_NAMES.STOCK_TAKING) : null;
  if (!stockSheet) return "";
  let inventoryVal = stockSheet.getRange("B1").getValue();
  if (!inventoryVal || isNaN(new Date(inventoryVal).getTime())) return "";
  return formatJstDate_(inventoryVal);
};

/** 棚卸し日が指示書 B2 の前日か（前日棚卸し運用） */
const isInventoryExactlyPriorDay_ = (ctx) => {
  if (!ctx || !ctx.inventoryDateStr || !ctx.orderDate) return false;
  return ctx.inventoryDateStr === addDaysToDateStr_(formatJstDate_(ctx.orderDate), -1);
};

/** 指示書 B2 に対応する simulationResults の日インデックス */
const getOrderDayIndexInCtx_ = (ctx) => {
  if (!ctx || !ctx.orderDate) return 0;
  return clampDayIndex_(
    getOrderSheetDayIndex(ctx.orderDate, ctx.periodMode || "当日", ctx.targetDate),
    ctx.simDays
  );
};

/** 棚卸し表の数量を原材料最小単位マップへ（発注判定の在庫リセット用） */
const buildRawStockFromInventorySheet_ = (ctx) => {
  let stock = {};
  Object.keys(ctx.rawMaster).forEach((rName) => {
    let rawRow = ctx.rawMaster[rName];
    let stockEntry = ctx.stockObj[rName];
    let initialQty = stockEntry ? stockEntry.qty : 0;
    let initialUnit = stockEntry ? stockEntry.unit : (rawRow.orderUnit || rawRow.lotUnit || "個");
    stock[rName] = convertToMinUnit(initialQty, initialUnit, rawRow);
  });
  return stock;
};

/**
 * 月跨ぎ時にバックログへ残す最古日付（yyyy-MM-dd）
 * - 通常: 棚卸し月の1日以降のみ保持（それ以前は削除）
 * - 月替わり直後・シミュレーションが月をまたぐ: 前月末の7日分だけ残す
 */
const resolveBacklogHistoricalKeepFrom_ = (ctx) => {
  let bridge = BACKLOG_MONTH_BRIDGE_DAYS_;
  let invDateStr = (ctx && ctx.inventoryDateStr) || (ctx && ctx.targetDatesStr ? ctx.targetDatesStr[0] : "");
  if (!invDateStr) return "1970-01-01";

  let simDates = (ctx && ctx.targetDatesStr) || [invDateStr];
  let simStartStr = simDates[0];
  let simEndStr = simDates[simDates.length - 1];

  let invDate = parseJstDateStr_(invDateStr);
  let invMonthStart = startOfMonthJst_(invDate);
  let invMonthStartStr = formatJstDate_(invMonthStart);
  let nextMonthStart = new Date(invDate.getFullYear(), invDate.getMonth() + 1, 1);

  let simStart = parseJstDateStr_(simStartStr);
  let simEnd = parseJstDateStr_(simEndStr);

  let earlyInMonth = invDate.getDate() <= bridge;
  let simStartsInPriorMonth = simStart < invMonthStart;
  let simCrossesForward = simEnd >= nextMonthStart;

  if (!earlyInMonth && !simStartsInPriorMonth && !simCrossesForward) {
    return invMonthStartStr;
  }

  let keepFrom;
  if (simCrossesForward && !earlyInMonth && !simStartsInPriorMonth) {
    let invMonthLast = endOfMonthJst_(invDate);
    keepFrom = new Date(invMonthLast);
    keepFrom.setDate(keepFrom.getDate() - (bridge - 1));
  } else {
    let prevMonthLast = new Date(invMonthStart);
    prevMonthLast.setDate(0);
    keepFrom = new Date(prevMonthLast);
    keepFrom.setDate(keepFrom.getDate() - (bridge - 1));
  }

  return formatJstDate_(keepFrom);
};

const buildBacklogRetentionCtx_ = (referenceDateStr, inventoryDateStr) => {
  let inv = inventoryDateStr || getInventoryDateStrFromSheet_() || referenceDateStr;
  return {
    inventoryDateStr: inv,
    targetDatesStr: [referenceDateStr || inv],
    simDays: 1
  };
};

const padBacklogRow_ = (row, numCols) => {
  let out = row.slice();
  while (out.length < numCols) out.push("");
  return out.slice(0, numCols);
};

const readBacklogDataRows_ = (sheet, meta) => {
  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];

  let numCols = meta.numCols || meta.headers.length || BACKLOG_HEADERS.length;
  let numRows = lastRow - startRow + 1;
  return sheet.getRange(startRow, 1, numRows, numCols).getValues();
};

/** 保持期間外の行を除去（月跨ぎ後は前月データを自動クリア） */
const applyBacklogRetentionToRows_ = (rows, meta, ctx) => {
  let idxDate = meta.headers.indexOf("日付");
  if (idxDate < 0) return rows || [];

  let keepFrom = resolveBacklogHistoricalKeepFrom_(ctx);
  let kept = (rows || []).filter((row) => {
    let d = formatSheetDateToKey(row[idxDate]);
    return d && d >= keepFrom;
  });

  kept.sort((a, b) => {
    let da = formatSheetDateToKey(a[idxDate]) || "";
    let db = formatSheetDateToKey(b[idxDate]) || "";
    if (da !== db) return da < db ? -1 : 1;
    return String(a[1]).localeCompare(String(b[1]), "ja");
  });
  return kept;
};

/**
 * 既存バックログ（棚卸し日未満）＋今回シミュレーション分をマージ
 * 棚卸し日未満は月跨ぎルールで必要最小限のみ残す
 */
const mergeBacklogWithRetention_ = (existingRows, newRows, meta, ctx) => {
  let idxDate = meta.headers.indexOf("日付");
  let invDateStr = (ctx && ctx.inventoryDateStr) || (ctx && ctx.targetDatesStr ? ctx.targetDatesStr[0] : "");
  let keepFrom = resolveBacklogHistoricalKeepFrom_(ctx);

  let historical = (existingRows || []).filter((row) => {
    let d = formatSheetDateToKey(row[idxDate]);
    return d && d < invDateStr && d >= keepFrom;
  });

  let merged = historical.concat(newRows || []);
  merged.sort((a, b) => {
    let da = formatSheetDateToKey(a[idxDate]) || "";
    let db = formatSheetDateToKey(b[idxDate]) || "";
    if (da !== db) return da < db ? -1 : 1;
    return String(a[1]).localeCompare(String(b[1]), "ja");
  });
  return merged;
};

const writeBacklogDataRows_ = (sheet, meta, rows) => {
  let numCols = meta.numCols || meta.headers.length || BACKLOG_HEADERS.length;
  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();

  if (lastRow >= startRow) {
    sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).clearContent();
  }

  if (!rows || rows.length === 0) return 0;

  let padded = rows.map((row) => {
    return padBacklogRow_(row, numCols);
  });
  writeSheetRows(sheet, startRow, 1, padded);
  return padded.length;
};

/**
 * バックログを1回読み・1回クリア・1回書込
 * 棚卸し日より前は月跨ぎルールで必要分のみ保持、以降は今回結果で置換
 */
const writeBacklogMergedOnce = (ctx, backlogRows) => {
  if (!ctx) return;

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.BACKLOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.BACKLOG);
    Logger.log(`[バックログ] シート「${SHEET_NAMES.BACKLOG}」を新規作成`);
  }

  let meta = ensureBacklogSheetMeta_(sheet);
  if (!meta) return;

  let invDateStr = ctx.inventoryDateStr || (ctx.targetDatesStr ? ctx.targetDatesStr[0] : "");
  let keepFrom = resolveBacklogHistoricalKeepFrom_(ctx);
  let existingRows = readBacklogDataRows_(sheet, meta);
  let merged = mergeBacklogWithRetention_(existingRows, backlogRows, meta, ctx);
  let rowsWritten = writeBacklogDataRows_(sheet, meta, merged);

  if (rowsWritten <= 0) {
    Logger.log("[警告] バックログ: 書込行0");
  }

  Logger.log(`[バックログ] 書込 ${rowsWritten} 行（棚卸し=${invDateStr} 保持=${keepFrom}〜）`);
};

/** 予測出数ログ（大量行のシートI/OでタイムアウトしやすいためデフォルトOFF） */
const ENABLE_FORECAST_DEMAND_LOG_ = false;

/** 予測出数ログ列（原材料の日次予測出数・監査・デバッグ用） */
const FORECAST_DEMAND_HEADERS_ = [
  "日付", "商材名", "用途", "最小単位量", "材料費", "売上基準"
];

const ensureForecastDemandSheetMeta_ = (sheet) => {
  if (!sheet) return null;

  let meta = findSheetHeaderMeta(sheet, ["日付", "商材名", "用途"]);
  if (meta) return meta;

  sheet.getRange(1, 1, 1, FORECAST_DEMAND_HEADERS_.length).setValues([FORECAST_DEMAND_HEADERS_]);
  return {
    headerRowIdx: 0,
    dataStartRow: 2,
    headers: FORECAST_DEMAND_HEADERS_.slice(),
    numCols: FORECAST_DEMAND_HEADERS_.length
  };
};

const readForecastDemandDataRows_ = (sheet, meta) => {
  if (!sheet || !meta) return [];
  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];

  return sheet.getRange(startRow, 1, lastRow - startRow + 1, meta.numCols).getValues();
};

const buildForecastDemandLogRows_ = (ctx, demandCache) => {
  if (!ctx || !demandCache || !demandCache.days) return [];

  let rows = [];
  demandCache.days.forEach((day) => {
    if (!day || !day.date) return;
    let baseFlag = day.baseFlag || "";

    appendForecastDemandRows_(rows, day.date, day.menuRawDemand, "メニュー出数", ctx.rawMaster, baseFlag);
    appendForecastDemandRows_(rows, day.date, day.prepYieldLossRawDemand, "歩留まりロス", ctx.rawMaster, baseFlag);
    appendForecastDemandRows_(rows, day.date, day.wasteRawDemand, "廃棄", ctx.rawMaster, baseFlag);
    appendForecastDemandRows_(rows, day.date, day.rawConsumption, "在庫消費", ctx.rawMaster, baseFlag);
  });
  return rows;
};

const appendForecastDemandRows_ = (rows, dateStr, qtyMap, purpose, rawMaster, baseFlag) => {
  Object.keys(qtyMap || {}).forEach((rName) => {
    let minQty = Number(qtyMap[rName]) || 0;
    if (minQty <= 1e-9) return;

    let rawRow = rawMaster[rName];
    if (!rawRow) return;

    let orderLotMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
    let unitPrice = Number(rawRow.unitPrice) || 0;
    let materialCost = orderLotMin > 0 && unitPrice > 0
      ? (minQty / orderLotMin) * unitPrice
      : 0;

    rows.push([dateStr, rName, purpose, minQty, materialCost, baseFlag]);
  });
};

const mergeForecastDemandWithRetention_ = (existingRows, newRows, meta, ctx) => {
  let idxDate = meta.headers.indexOf("日付");
  let invDateStr = (ctx && ctx.inventoryDateStr) || (ctx && ctx.targetDatesStr ? ctx.targetDatesStr[0] : "");
  let keepFrom = resolveBacklogHistoricalKeepFrom_(ctx);

  let historical = (existingRows || []).filter((row) => {
    let d = formatSheetDateToKey(row[idxDate]);
    return d && d < invDateStr && d >= keepFrom;
  });

  let merged = historical.concat(newRows || []);
  merged.sort((a, b) => {
    let da = formatSheetDateToKey(a[idxDate]) || "";
    let db = formatSheetDateToKey(b[idxDate]) || "";
    if (da !== db) return da < db ? -1 : 1;
    if (String(a[2]) !== String(b[2])) return String(a[2]).localeCompare(String(b[2]), "ja");
    return String(a[1]).localeCompare(String(b[1]), "ja");
  });
  return merged;
};

/**
 * 予測出数ログを1回書込（棚卸し日以降を今回シミュレーション結果で置換）
 * 仕込み・発注はバックログと共有。ここは原材料の理論原価／在庫消費のみ。
 */
const writeForecastDemandLog_ = (ctx, demandCache) => {
  if (!ENABLE_FORECAST_DEMAND_LOG_) return;
  if (!ctx || !demandCache) return;

  let rows = buildForecastDemandLogRows_(ctx, demandCache);
  if (rows.length === 0) return;

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.FORECAST_DEMAND_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.FORECAST_DEMAND_LOG);
    Logger.log(`[予測出数] シート「${SHEET_NAMES.FORECAST_DEMAND_LOG}」を新規作成`);
  }

  let meta = ensureForecastDemandSheetMeta_(sheet);
  if (!meta) return;

  let invDateStr = ctx.inventoryDateStr || (ctx.targetDatesStr ? ctx.targetDatesStr[0] : "");
  let existingRows = readForecastDemandDataRows_(sheet, meta);
  let merged = mergeForecastDemandWithRetention_(existingRows, rows, meta, ctx);
  let rowsWritten = writeBacklogDataRows_(sheet, meta, merged);

  Logger.log(`[予測出数] 書込 ${rowsWritten} 行（棚卸し=${invDateStr}〜）`);
};

/** 予測出数ログのデータ行のみ削除 */
const clearForecastDemandLogData_ = (ss) => {
  let sheet = ss ? ss.getSheetByName(SHEET_NAMES.FORECAST_DEMAND_LOG) : null;
  if (!sheet) return 0;

  let meta = ensureForecastDemandSheetMeta_(sheet);
  if (!meta) return 0;

  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return 0;

  let numRows = lastRow - startRow + 1;
  sheet.getRange(startRow, 1, numRows, meta.numCols).clearContent();
  return numRows;
};

/** バックログシートのデータ行のみ削除（見出しは残す） */
const clearBacklogSheetData_ = (ss) => {
  let sheet = ss ? ss.getSheetByName(SHEET_NAMES.BACKLOG) : null;
  if (!sheet) return 0;

  let meta = ensureBacklogSheetMeta_(sheet);
  if (!meta) return 0;

  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return 0;

  let numRows = lastRow - startRow + 1;
  sheet.getRange(startRow, 1, numRows, meta.numCols).clearContent();
  return numRows;
};

/** AIスナップショット（確定コミット比較用）をすべて削除 */
const clearAiSnapshotProperties_ = () => {
  let props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  let removed = 0;
  Object.keys(all).forEach((key) => {
    if (key.indexOf(AI_SNAPSHOT_PROP_PREFIX) !== 0) return;
    props.deleteProperty(key);
    removed++;
  });
  return removed;
};

/** AI予測手動調整ログのデータ行のみ削除（見出しは残す） */
const clearManualAdjustmentLogData_ = (ss) => {
  let sheet = ss ? ss.getSheetByName(SHEET_NAMES.MANUAL_ADJUSTMENT_LOG) : null;
  if (!sheet) return 0;

  let meta = findHeaderRowAndIndices(sheet, ["日付", "商材名", "分類"]);
  if (!meta) return 0;

  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return 0;

  let numRows = lastRow - startRow + 1;
  let numCols = meta.headers.length;
  sheet.getRange(startRow, 1, numRows, numCols).clearContent();
  return numRows;
};

/** 発注日 index + LT → 納品日 index（カレンダー日数） */
const getVendorDeliveryDayIndex = (orderDayIdx, leadTime) => {
  let lt = Math.max(0, Number(leadTime) || 0);
  return orderDayIdx + lt;
};

/**
 * 発注指示日 + LT = 納品日 として、その納品日が業者カレンダー上許可されるか判定する。
 * 例: プレコ LT=2・日曜納品不可 → 金曜発注(Fri+2=Sun)は allowed=false
 */
const resolveVendorOrderDeliveryDay = (orderDayIdx, vCal, ctx, holidayCache) => {
  if (ctx && ctx._vendorDeliveryCheckCache && vCal && vCal._vendorName) {
    let cached = ctx._vendorDeliveryCheckCache[vCal._vendorName + ":" + orderDayIdx];
    if (cached) return cached;
  }

  let result = resolveVendorOrderDeliveryDayCore_(orderDayIdx, vCal, ctx, holidayCache);

  if (ctx && ctx._vendorDeliveryCheckCache && vCal && vCal._vendorName) {
    ctx._vendorDeliveryCheckCache[vCal._vendorName + ":" + orderDayIdx] = result;
  }
  return result;
};

const resolveVendorOrderDeliveryDayCore_ = (orderDayIdx, vCal, ctx, holidayCache) => {
  let lt = Math.max(0, Number(vCal && vCal.leadTime) || 0);
  let deliveryDayIdx = getVendorDeliveryDayIndex(orderDayIdx, lt);
  let orderDateStr = ctx && ctx.targetDatesStr ? ctx.targetDatesStr[orderDayIdx] : null;

  if (!ctx || !ctx.targetDatesStr || deliveryDayIdx >= ctx.targetDatesStr.length) {
    return {
      allowed: false,
      leadTime: lt,
      orderDayIdx: orderDayIdx,
      deliveryDayIdx: deliveryDayIdx,
      orderDateStr: orderDateStr,
      deliveryDateStr: null,
      deliveryWeekday: null,
      detail: "納品日がシミュレーション範囲外（LT=" + lt + "）"
    };
  }

  let deliveryDateStr = ctx.targetDatesStr[deliveryDayIdx];
  let deliveryDate = new Date(deliveryDateStr + "T12:00:00");
  let dow = getJapaneseWeekday(deliveryDate);
  let allowed = isVendorDeliveryAllowed(vCal, deliveryDate, holidayCache);

  return {
    allowed: allowed,
    leadTime: lt,
    orderDayIdx: orderDayIdx,
    deliveryDayIdx: deliveryDayIdx,
    orderDateStr: orderDateStr,
    deliveryDateStr: deliveryDateStr,
    deliveryWeekday: dow,
    detail: allowed
      ? null
      : "納品不可 " + deliveryDateStr + "(" + dow + ") ← 発注日" + orderDateStr + "+LT" + lt
  };
};

/** シミュレーション開始時に業者納品判定を全日分プリキャッシュ */
const precomputeVendorDeliveryCaches_ = (ctx, holidayCache) => {
  if (!ctx || !ctx.vendorCalendars) return;
  ctx._vendorDeliveryCheckCache = {};
  ctx._nextDeliveryDayCache = {};

  Object.keys(ctx.vendorCalendars).forEach((vName) => {
    let vCal = ctx.vendorCalendars[vName];
    vCal._vendorName = vName;
    let lt = Math.max(0, Number(vCal.leadTime) || 0);
    for (let d = 0; d < ctx.simDays; d++) {
      ctx._vendorDeliveryCheckCache[vName + ":" + d] =
        resolveVendorOrderDeliveryDayCore_(d, vCal, ctx, holidayCache);
    }
    for (let del = 0; del < ctx.simDays; del++) {
      ctx._nextDeliveryDayCache[vName + ":" + del + ":" + lt] =
        findNextVendorDeliveryDayIdxCore_(del, lt, ctx, vCal, holidayCache);
    }
  });
};

const LOT14_TARGET_KG = 14;

/** 仕入先が中野製麺か */
const NAKANO_VENDOR_NAME_ = "中野製麺";

const isNakanoVendor_ = (rawRow) => {
  return String(rawRow && rawRow.vendor || "").trim() === NAKANO_VENDOR_NAME_;
};

/**
 * 中野製麺の1発注単位あたりkg（14kg合算用）
 * つけだれ/もみだれ/塩だれ/味噌だれ/ヤンジャン=1kg、冷麺=200g、冷麺スープ=2kg
 * @return {number|null} 該当なしは null
 */
const rawKgPerOrderUnitForNakano_ = (rName) => {
  let n = String(rName || "");
  if (n.indexOf("冷麺スープ") !== -1) return 2;
  if (n.indexOf("冷麺") !== -1) return 0.2;
  if (/つけだれ|もみだれ|塩だれ|味噌だれ|ヤンジャン|ヤンニャン/.test(n)) return 1;
  return null;
};

/** 最小単位量 → kg（14kg合算の加算・集計でロットサイズとkg換算を一致させる） */
const rawMinUnitQtyToKg_ = (minUnitQty, rawRow, rName) => {
  if (!rawRow) return 0;
  let onePackMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
  if (onePackMin <= 0) return 0;
  let kgPerPack = rawKgPerOrderUnit_(rawRow, rName);
  if (kgPerPack > 0) {
    return (minUnitQty / onePackMin) * kgPerPack;
  }
  let lotU = normalizeUnitKey(rawRow.lotUnit);
  let packs = minUnitQty / onePackMin;
  if (lotU === "kg") return packs * (Number(rawRow.lotQty) || 1);
  if (lotU === "g") return packs * (Number(rawRow.lotQty) || 1) / 1000;
  return 0;
};

/** 原材料の発注量（最小単位）を kg 換算 */
const rawOrderQtyToKg = (minUnitQty, rawRow, rName) => {
  return rawMinUnitQtyToKg_(minUnitQty, rawRow, rName);
};

/** 1発注単位あたりの14kg換算重量(kg)。中野製麺は商品名ルール → マスタ列 → ロット単位 → 既定換算 */
const rawKgPerOrderUnit_ = (rawRow, rName) => {
  if (!rawRow) return 0;
  if (isNakanoVendor_(rawRow)) {
    let nakanoKg = rawKgPerOrderUnitForNakano_(rName);
    if (nakanoKg != null) return nakanoKg;
  }
  if (Number(rawRow.lot14KgPerOrderUnit) > 0) return Number(rawRow.lot14KgPerOrderUnit);
  let lotQty = Number(rawRow.lotQty) || 1;
  let lotUnitRaw = String(rawRow.lotUnit).trim();
  let lotU = normalizeUnitKey(lotUnitRaw);
  if (lotU === "kg") return lotQty;
  if (lotU === "g") return lotQty / 1000;
  if (lotUnitRaw === "玉") return lotQty * 0.16;
  let n = String(rName || "");
  if (n.indexOf("冷麺スープ") !== -1) return 2;
  if (/つけだれ|塩だれ|もみだれ|味噌だれ|ヤンジャン|ヤンニャン/.test(n)) return 4;
  return 0;
};

const isLot14Vendor_ = (vCal) => {
  return vCal && Number(vCal.lot14kg) === 1;
};

/** 14kg合算の重量換算が可能か */
const hasLot14KgWeight_ = (rawRow, rName) => {
  return rawKgPerOrderUnit_(rawRow, rName) > 0;
};

/** 発注業者マスタで14kg合算=1の業者に属する全原材料 */
const collectLot14PoolForVendor_ = (ctx, vendor) => {
  let pool = [];
  let vCal = ctx.vendorCalendars[vendor];
  if (!isLot14Vendor_(vCal)) return pool;
  Object.keys(ctx.rawMaster).forEach((rName) => {
    let rawRow = ctx.rawMaster[rName];
    if (!rawRow || rawRow.vendor !== vendor) return;
    pool.push({ rName: rName, rawRow: rawRow });
  });
  return pool;
};

const sumLot14OrderKg_ = (todayOrders, pool) => {
  let total = 0;
  pool.forEach((p) => {
    if (!hasLot14KgWeight_(p.rawRow, p.rName)) return;
    let order = todayOrders[p.rName];
    if (!order || order.aiQty <= 0) return;
    total += rawOrderQtyToKg(order.aiQty, p.rawRow, p.rName);
  });
  return total;
};

const ensureLot14OrderEntry_ = (todayOrders, rName, rawRow, orderDayIdx, ctx, holidayCache) => {
  if (todayOrders[rName]) return;
  let vCal = ctx.vendorCalendars[rawRow.vendor];
  let del = resolveVendorOrderDeliveryDay(orderDayIdx, vCal, ctx, holidayCache);
  todayOrders[rName] = {
    aiQty: 0,
    unit: rawRow.orderUnit || "箱",
    vendor: rawRow.vendor,
    reason: "14kg合算ロット調整",
    deliveryDayIdx: del.allowed ? del.deliveryDayIdx : orderDayIdx
  };
};

// ===== DEBUG_SHIODARE_START（デバッグ用・削除可） =====
const DEBUG_SHIODARE_TRACK_ENABLED_ = true;
const DEBUG_SHIODARE_RAW_NAME_ = "ジンギスカン";
const DEBUG_AWASE_SHIODARE_PREP_NAME_ = "";

/** 発注計算・14kg合算のトラック対象（原材料「ジンギスカン」のみ） */
const isDebugShiodareOrderTarget_ = (rName) => {
  return DEBUG_SHIODARE_TRACK_ENABLED_ && rName === DEBUG_SHIODARE_RAW_NAME_;
};

const isDebugShiodareTarget_ = isDebugShiodareOrderTarget_;

const formatDebugRawMinQty_ = (rName, minQty, ctx) => {
  let rawRow = ctx && ctx.rawMaster ? ctx.rawMaster[rName] : null;
  if (!rawRow) return Math.round(minQty) + "min";
  let packMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
  let g = Math.round(minQty);
  if (packMin > 0) {
    let packs = (minQty / packMin).toFixed(2);
    return g + "g(" + packs + (rawRow.orderUnit || "箱") + ")";
  }
  return g + "g";
};

const tracePrepContributionsToRaw_ = (rawName, prepDemand, inProcess, ctx) => {
  let parts = [];
  Object.keys(inProcess || {}).forEach((pName) => {
    let partial = {};
    expandPrepLotsToRaw(pName, inProcess[pName].lotCount, ctx, partial, inProcess, []);
    let amt = partial[rawName] || 0;
    if (amt > 1e-6) {
      parts.push(pName + "=" + Math.round(amt));
    }
  });
  return parts.length > 0 ? parts.join(",") : "(なし)";
};

const describePrepUsesRawPerLot_ = (prepName, rawName, ctx) => {
  let prep = ctx && ctx.preparationRecipes ? ctx.preparationRecipes[prepName] : null;
  if (!prep || !prep.ingredients) return "";
  let parts = [];
  prep.ingredients.forEach((ing) => {
    let target = routeUnifiedMaterial_(ing.name, ctx);
    if (target.name !== rawName && ing.name !== rawName) return;
    parts.push(ing.qty + (ing.unit || "") + "/仕込みロット");
  });
  return parts.join("+") || "";
};

const logDebugShiodare_ = (stage, label, fields) => {
  if (!DEBUG_SHIODARE_TRACK_ENABLED_) return;
  let parts = [`[DEBUGジンギスカン] ${stage}`, `対象=${label}`];
  Object.keys(fields || {}).forEach((k) => {
    parts.push(`${k}=${fields[k]}`);
  });
  Logger.log(parts.join(" | "));
};

const trackDebugShiodareDailyDemand_ = (ctx, payload) => {
  if (!DEBUG_SHIODARE_TRACK_ENABLED_ || !ctx) return;

  let rawName = DEBUG_SHIODARE_RAW_NAME_;
  let prepName = DEBUG_AWASE_SHIODARE_PREP_NAME_;
  let rawRow = ctx.rawMaster[rawName];

  let directMin = (payload.directRawConsumption && payload.directRawConsumption[rawName]) || 0;
  let prepMin = (payload.prepRawConsumption && payload.prepRawConsumption[rawName]) || 0;
  let totalMin = (payload.rawConsumption && payload.rawConsumption[rawName]) || 0;
  let prepContrib = tracePrepContributionsToRaw_(
    rawName, payload.prepDemand, payload.inProcess, ctx
  );

  logDebugShiodare_("日次消費", rawName, {
    日付: payload.date || "",
    売上: Math.round(payload.salesAmount || 0),
    仕込み倍率: payload.prepFactor != null ? payload.prepFactor.toFixed(3) : "",
    メニュー直接: formatDebugRawMinQty_(rawName, directMin, ctx),
    仕込み経由: formatDebugRawMinQty_(rawName, prepMin, ctx),
    合計消費: formatDebugRawMinQty_(rawName, totalMin, ctx),
    仕込み内訳: prepContrib
  });

  if (prepName) {
    let awaseDemand = (payload.prepDemand && payload.prepDemand[prepName]) || 0;
    let awaseProc = payload.inProcess ? payload.inProcess[prepName] : null;
    let awaseFields = {
      日付: payload.date || "",
      売上: Math.round(payload.salesAmount || 0),
      仕込み倍率: payload.prepFactor != null ? payload.prepFactor.toFixed(3) : "",
      需要量: Math.round(awaseDemand)
    };
    if (awaseProc) {
      awaseFields.ロット数 = awaseProc.lotCount;
      awaseFields.仕込み量 = Math.round(awaseProc.aiQty) + (awaseProc.unit || "");
    }
    let recipeNote = describePrepUsesRawPerLot_(prepName, rawName, ctx);
    if (recipeNote) awaseFields.ジンギスカンレシピ = recipeNote;
    logDebugShiodare_("日次仕込み", prepName, awaseFields);
  }
};

const trackDebugShiodareCalcStart_ = (rName, rawRow, orderDayIdx, stockAfterConsumption, ctx, orderOptions) => {
  if (!isDebugShiodareOrderTarget_(rName)) return;
  logDebugShiodare_("calc開始", rName, {
    発注日: ctx.targetDatesStr[orderDayIdx] || "",
    業者: rawRow.vendor || "",
    在庫min: Math.round(stockAfterConsumption),
    maxStock: Number(rawRow.maxStock) || 0,
    minStock: Number(rawRow.minStock) || 0,
    ロット: `${rawRow.lotQty || ""}${rawRow.lotUnit || ""}`,
    納品加算スキップ: orderOptions && orderOptions.skipDeliveryBuffered ? "yes" : "no"
  });
};

const trackDebugShiodareCalcMid_ = (rName, fields) => {
  if (!isDebugShiodareOrderTarget_(rName)) return;
  logDebugShiodare_("calc中間", rName, fields);
};

const trackDebugShiodareCalcEnd_ = (rName, rawRow, result) => {
  if (!isDebugShiodareOrderTarget_(rName)) return result;
  if (!result || result.skipped) {
    logDebugShiodare_("calc終了", rName, {
      skipped: "yes",
      detail: result ? (result.detail || "") : "null"
    });
    return result;
  }
  let display = formatOrderSheetOrderQty_(result.aiQty, rawRow, rName);
  logDebugShiodare_("calc終了", rName, {
    skipped: "no",
    aiQtyMin: Math.round(result.aiQty),
    表示: `${display.qty}${display.unit}`,
    納品日idx: result.deliveryDayIdx,
    区間消費min: Math.round(result.coverConsumption || 0),
    納品朝在庫min: Math.round(result.stockAtDeliveryForOrder || 0),
    reason: result.reason || ""
  });
  return result;
};

const trackDebugShiodareLot14_ = (rName, stage, fields) => {
  if (!isDebugShiodareOrderTarget_(rName)) return;
  logDebugShiodare_(stage, rName, fields);
};

const trackDebugShiodareFinal_ = (dateStr, rName, item, rawRow) => {
  if (!isDebugShiodareOrderTarget_(rName) || !item) return;
  let display = formatOrderSheetOrderQty_(item.aiQty, rawRow, rName);
  logDebugShiodare_("指示書確定", rName, {
    日付: dateStr,
    aiQtyMin: Math.round(item.aiQty),
    表示: `${display.qty}${display.unit}`,
    reason: item.reason || ""
  });
};
// ===== DEBUG_SHIODARE_END =====

/** 納品時点（入荷後・当日消費前）の在庫上限（最小単位）。maxStock<=0 なら null */
const maxStockMinUnitAtDelivery_ = (rawRow) => {
  let maxUnits = Number(rawRow.maxStock) || 0;
  if (maxUnits <= 0) return null;
  let packMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
  if (packMin <= 0) return null;
  return maxUnits * packMin;
};

/**
 * 納品時在庫 + 発注量が最大在庫を超えるか
 * @param {number} stockAtDeliveryMinUnit 納品朝（入荷前）の見込在庫
 * @param {number} orderMinUnitAtDelivery その納品日に入る発注量の合計（最小単位）
 */
const wouldExceedMaxStockAtDelivery_ = (rawRow, stockAtDeliveryMinUnit, orderMinUnitAtDelivery) => {
  let maxMin = maxStockMinUnitAtDelivery_(rawRow);
  if (maxMin === null) return false;
  let stock = Math.max(0, Number(stockAtDeliveryMinUnit) || 0);
  let orderQty = Math.max(0, Number(orderMinUnitAtDelivery) || 0);
  return stock + orderQty > maxMin + 1e-6;
};

/** 納品時点で最大在庫を超えないよう発注量（最小単位）を切り下げ */
const capOrderQtyByMaxStockAtDelivery_ = (rName, rawRow, stockAtDeliveryMinUnit, desiredOrderMinUnit) => {
  let maxMin = maxStockMinUnitAtDelivery_(rawRow);
  if (maxMin === null) return desiredOrderMinUnit;

  let stock = Math.max(0, Number(stockAtDeliveryMinUnit) || 0);
  let desired = Math.max(0, Number(desiredOrderMinUnit) || 0);
  let orderLotSize = resolveRawOrderLotSizeMinUnit_(rName, rawRow);
  if (orderLotSize <= 0) return desired;

  let headroom = Math.max(0, maxMin - stock);
  if (headroom <= 1e-6) return 0;

  let maxLots = Math.floor(headroom / orderLotSize);
  if (maxLots <= 0) return 0;

  let maxAllowed = maxLots * orderLotSize;
  return desired <= maxAllowed + 1e-6 ? desired : maxAllowed;
};

/** @deprecated capOrderQtyByMaxStockAtDelivery_ の headroom 算出用 */
const maxOrderQtyByMaxStockMinUnit_ = (rawRow, onePackMin, stockAtDeliveryMinUnit) => {
  let maxMin = maxStockMinUnitAtDelivery_(rawRow);
  if (maxMin === null) return null;
  let stock = Math.max(0, Number(stockAtDeliveryMinUnit) || 0);
  return Math.max(0, maxMin - stock);
};

const canAddLot14Pack_ = (
  rName, rawRow, onePackMin, orderDayIdx, todayOrders, currentStock, ctx, dailyBuffered, precomputed, holidayCache, lot14Options
) => {
  lot14Options = lot14Options || {};
  let skipDeliveryBuffered = !!lot14Options.skipDeliveryBuffered;
  let ordered = todayOrders[rName] ? todayOrders[rName].aiQty : 0;
  let stockBase = currentStock[rName] || 0;
  let vCal = ctx.vendorCalendars[rawRow.vendor];
  let del = resolveVendorOrderDeliveryDay(orderDayIdx, vCal, ctx, holidayCache);
  let stockAtDelivery = stockBase;
  if (del.allowed) {
    stockAtDelivery = projectRawStockAtDeliveryStart_(
      precomputed, dailyBuffered, rName, orderDayIdx, del.deliveryDayIdx, stockBase, skipDeliveryBuffered
    );
  }
  let nextOrderMin = ordered + onePackMin;
  return !wouldExceedMaxStockAtDelivery_(rawRow, stockAtDelivery, nextOrderMin);
}

/** 不足分を優先順位1→2→3で1発注単位ずつ追加（最大在庫超過時は次の優先へ） */
const fillLot14DeficitKg_ = (
  todayOrders, pool, deficitKg, orderDayIdx, currentStock, ctx, dailyBuffered, precomputed, holidayCache, lot14Options
) => {
  let remain = deficitKg;
  let addedLog = [];
  for (let pri = 1; pri <= 3 && remain > 0.001; pri++) {
    let fillers = pool.filter((p) => {
      return Number(p.rawRow.lot14Priority) === pri && hasLot14KgWeight_(p.rawRow, p.rName);
    });
    fillers.sort((a, b) => { return a.rName.localeCompare(b.rName, "ja"); });
    for (let fi = 0; fi < fillers.length && remain > 0.001; fi++) {
      let rName = fillers[fi].rName;
      let rawRow = fillers[fi].rawRow;
      let kgPerPack = rawKgPerOrderUnit_(rawRow, rName);
      let onePack = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
      if (kgPerPack <= 0 || onePack <= 0) continue;
      let blockedByMax = false;
      let guard = 0;
      while (remain > 0.001 && guard < 200) {
        guard++;
        let addedKg = rawMinUnitQtyToKg_(onePack, rawRow, rName);
        if (addedKg <= 1e-9) break;
        if (!canAddLot14Pack_(
          rName, rawRow, onePack, orderDayIdx, todayOrders, currentStock, ctx,
          dailyBuffered, precomputed, holidayCache, lot14Options
        )) {
          blockedByMax = true;
          break;
        }
        ensureLot14OrderEntry_(todayOrders, rName, rawRow, orderDayIdx, ctx, holidayCache);
        todayOrders[rName].aiQty += onePack;
        remain -= addedKg;
        addedLog.push(rName + "+" + (rawRow.orderUnit || "箱"));
        if (isDebugShiodareOrderTarget_(rName)) {
          trackDebugShiodareLot14_(rName, "14kg+1箱", {
            aiQtyMin: Math.round(todayOrders[rName].aiQty),
            addedKg: addedKg.toFixed(3),
            remainKg: remain.toFixed(3)
          });
        }
      }
      if (blockedByMax && remain > 0.001) {
        addedLog.push(rName + "(最大在庫上限)");
      }
    }
  }
  return { remainKg: remain, addedLog: addedLog };
}

/**
 * 14kg合算ロット（発注業者マスタ K=1）:
 * 同一業者の重量換算可能な発注の合計を14kg単位に切上げ、
 * 不足分は原材料マスタの優先順位1→2→3・最大在庫に従い追加
 */
const applyVendor14KgLotRule = (
  todayOrders, ctx, orderDayIdx, currentStock, dailyBuffered, precomputed, holidayCache, lot14Options
) => {
  lot14Options = lot14Options || {};
  if (!todayOrders || !ctx || !ctx.vendorCalendars) return;

  Object.keys(ctx.vendorCalendars).forEach((vendor) => {
    let vCal = ctx.vendorCalendars[vendor];
    if (!isLot14Vendor_(vCal)) return;

    let pool = collectLot14PoolForVendor_(ctx, vendor);
    if (pool.length === 0) return;

    let hasOrder = pool.some((p) => {
      if (!hasLot14KgWeight_(p.rawRow, p.rName)) return false;
      let o = todayOrders[p.rName];
      return o && o.aiQty > 0;
    });
    if (!hasOrder) return;

    let totalKg = sumLot14OrderKg_(todayOrders, pool);
    if (totalKg <= 0) return;

    let targetKg = Math.max(LOT14_TARGET_KG, Math.ceil(totalKg / LOT14_TARGET_KG) * LOT14_TARGET_KG);
    let deficitKg = targetKg - totalKg;
    if (deficitKg <= 0.001) return;

    pool.forEach((p) => {
      if (!isDebugShiodareOrderTarget_(p.rName)) return;
      let before = todayOrders[p.rName];
      trackDebugShiodareLot14_(p.rName, "14kg合算前", {
        aiQtyMin: before ? Math.round(before.aiQty) : 0,
        totalKg: totalKg.toFixed(1),
        targetKg: targetKg,
        deficitKg: deficitKg.toFixed(3)
      });
    });

    let fill = fillLot14DeficitKg_(
      todayOrders, pool, deficitKg, orderDayIdx, currentStock, ctx,
      dailyBuffered, precomputed, holidayCache, lot14Options
    );
    let note = " [14kg合算: " + totalKg.toFixed(1) + "kg→" + targetKg + "kg";
    if (fill.addedLog.length > 0) note += " 追加:" + fill.addedLog.join(", ");
    if (fill.remainKg > 0.001) note += " 未補填:" + fill.remainKg.toFixed(1) + "kg";
    note += "]";

    pool.forEach((p) => {
      let order = todayOrders[p.rName];
      if (order && order.aiQty > 0) order.reason = (order.reason || "") + note;
      if (isDebugShiodareTarget_(p.rName)) {
        trackDebugShiodareLot14_(p.rName, "14kg合算後", {
          aiQtyMin: order ? Math.round(order.aiQty) : 0,
          addedLog: fill.addedLog.join(",") || "(なし)",
          remainKg: fill.remainKg.toFixed(3)
        });
      }
    });
  });
}

const findHeaderRowAndIndices = (sheet, requiredHeaders) => {
  if (!sheet) return null;
  let lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  let lastCol = Math.max(sheet.getLastColumn(), 1);
  let scanRows = Math.min(lastRow, 20);
  let topRows = sheet.getRange(1, 1, scanRows, lastCol).getValues();

  for (let i = 0; i < topRows.length; i++) {
    let row = topRows[i].map((cell) => { return String(cell).trim(); });
    let matchAll = requiredHeaders.every((h) => { return row.indexOf(h) !== -1; });
    if (!matchAll) continue;

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
      headerRowIdx: i,
      dataStartRow: dataStartRow,
      headers: row,
      fullData: fullData
    };
  }
  return null;
};

/** POS純売上（税込）→ 予算・実績と同じ税抜金額 */
const convertPosSalesToExTax = (amount) => {
  let n = Number(amount) || 0;
  if (n <= 0) return 0;
  return n / (1 + SALES_TAX_RATE);
};

/** 純売上列の位置（税込見出し「純売上」/ 税抜見出し「純売上(税抜)」どちらも可） */
const findPosSalesColumnMeta_ = (headers) => {
  let idxEx = headers.indexOf(POS_SALES_HEADER_EX_TAX);
  if (idxEx !== -1) return { idx: idxEx, exTax: true };
  let idx = headers.indexOf("純売上");
  if (idx !== -1) return { idx: idx, exTax: false };
  return { idx: -1, exTax: false };
};

const getBA = (budgetActualData, dateObj) => {
  let dateStr = Utilities.formatDate(dateObj, "JST", "yyyy-MM-dd");
  return budgetActualData[dateStr] || null;
};

/**
 * 日次売上基準: 実績が入力されていれば実績、なければ予算
 * @return {{ amount: number, baseFlag: string }}
 */
const resolveDailySalesBase_ = (ba) => {
  if (!ba) return { amount: 0, baseFlag: "予算ベース" };
  if (ba.hasActual) {
    return { amount: Number(ba.actual) || 0, baseFlag: "実績ベース" };
  }
  return { amount: Number(ba.budget) || 0, baseFlag: "予算ベース" };
};

/**
 * 仕込み需要の翌日先読み分: 翌日予算の50%（翌日は未来のため常に予算列のみ。実績は混ぜない）
 * 当日分は呼び出し側が別途持っている（実績出数がある日はそれを使うため、ここでは合算しない）
 */
const resolveNextDayPrepLookaheadAmount_ = (ctx, dayIdx) => {
  if (!ctx.targetDatesStr || dayIdx + 1 >= ctx.targetDatesStr.length) return 0;
  let nextBa = ctx.budgetActualData[ctx.targetDatesStr[dayIdx + 1]];
  return nextBa ? (Number(nextBa.budget) || 0) * 0.5 : 0;
};

/**
 * 原材料最小単位マップ → 金額（円）
 * 金額 = Σ (最小単位量 ÷ 発注ロット最小単位 × 単価)
 */
const calcMaterialCostFromMinQtyMap_ = (rawMinQty, rawMaster) => {
  let total = 0;
  Object.keys(rawMinQty || {}).forEach((rName) => {
    let minQty = Number(rawMinQty[rName]) || 0;
    if (minQty <= 0) return;

    let rawRow = rawMaster[rName];
    if (!rawRow) return;

    let orderLotMin = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
    if (orderLotMin <= 0) return;

    let unitPrice = Number(rawRow.unitPrice) || 0;
    if (unitPrice <= 0) return;

    total += (minQty / orderLotMin) * unitPrice;
  });
  return total;
};

/** 日次原材料費（予測出数は既に最小単位） */
const calcDailyRawMaterialCost_ = (rawOutputDemand, rawMaster) => {
  return calcMaterialCostFromMinQtyMap_(rawOutputDemand, rawMaster);
};

/** 原材料費 ÷ 売上 → 原価率（小数） */
const calcFoodCostRatioFromAmounts_ = (materialCost, sales) => {
  let s = Number(sales) || 0;
  if (s <= 0) return null;
  return (Number(materialCost) || 0) / s;
};

/** 原価率 = (メニュー出数＋仕込み歩留まりロス＋廃棄)の原材料費 / 売上 */
const calcFoodCostRatio_ = (rawOutputDemand, rawMaster, ba) => {
  let salesBase = resolveDailySalesBase_(ba);
  return calcFoodCostRatioFromAmounts_(
    calcDailyRawMaterialCost_(rawOutputDemand, rawMaster),
    salesBase.amount
  );
};

/** 中間レシピ材料の必要量を、子仕込み品の出来上がり量（仕込み単位）へ換算 */
const prepIngredientQtyToFinishedQty_ = (qty, ingUnit, nestedPrep, nestedPrepName, ctx) => {
  let u = String(ingUnit || "").trim();
  if (!nestedPrep || qty <= 0) return qty;

  let converted = convertQtyBetweenPrepUnits_(qty, u, nestedPrep, nestedPrepName, ctx);
  if (converted != null && !isNaN(converted)) return converted;

  let prepUnit = String(nestedPrep.processUnit).trim();
  Logger.log(`[警告] 中間レシピ材料の単位換算不可: 材料=${qty}${u} / 子仕込み単位=${prepUnit}${nestedPrepName ? ` / 仕込み品=${nestedPrepName}` : ""}`);
  return qty;
};

/**
 * 仕込み品を原材料最小単位へ展開（歩留まり考慮）
 * @param {string} nestedMode "lotCount"=シミュレーション用切上げロット / "fractional"=棚卸し金額用
 */
const expandPrepToRawMinQty_ = (prepName, lotMultiplier, ctx, rawMinQty, pathStack, options) => {
  let prep = ctx.preparationRecipes[prepName];
  if (!prep || lotMultiplier <= 0) return;
  if (Number(prep.stopFlag) === 1) return;

  options = options || {};
  let nestedMode = options.nestedMode || "fractional";
  let inProcess = options.inProcess || null;

  pathStack = pathStack || [];
  if (pathStack.indexOf(prepName) !== -1) {
    Logger.log(`[警告] 中間レシピの循環参照を検出し原材料展開を中断: ${pathStack.join(" → ")} → ${prepName}`);
    return;
  }
  pathStack.push(prepName);

  prep.ingredients.forEach((ing) => {
    let qty = ing.qty * lotMultiplier;
    if (qty <= 0) return;

    let target = routeUnifiedMaterial_(ing.name, ctx);
    if (target.kind === "prep") {
      let nestedPrep = ctx.preparationRecipes[target.name];
      if (!nestedPrep || Number(nestedPrep.stopFlag) === 1) return;

      let nestedMultiplier;
      if (nestedMode === "lotCount") {
        if (inProcess && inProcess[target.name]) {
          // 別途仕込み指示がある中間品は、親展開では原材料まで落とさない（二重計上防止）
          return;
        }
        let nestedFinished = prepIngredientQtyToFinishedQty_(qty, ing.unit, nestedPrep, target.name, ctx);
        let nestedLotSize = Number(nestedPrep.finishedQty) || 1;
        nestedMultiplier = nestedFinished / nestedLotSize;
      } else {
        let nestedFinished = prepIngredientQtyToFinishedQty_(qty, ing.unit, nestedPrep, target.name, ctx);
        let nestedLotSize = Number(nestedPrep.finishedQty) || 1;
        nestedMultiplier = nestedFinished / nestedLotSize;
      }
      expandPrepToRawMinQty_(target.name, nestedMultiplier, ctx, rawMinQty, pathStack, options);
    } else if (target.kind === "raw") {
      let rawRow = ctx.rawMaster[target.name];
      let grossQty = applyYieldGrossQty_(qty, prepName, ctx, options.skipYield === true);
      let converted = convertToMinUnit(grossQty, ing.unit, rawRow);
      rawMinQty[target.name] = (rawMinQty[target.name] || 0) + converted;
    }
  });

  pathStack.pop();
};

/**
 * 仕込み展開時の歩留まりロス分のみを原材料最小単位へ蓄積（1パス・原価率用）
 */
const accumulatePrepYieldLossRaw_ = (prepName, lotMultiplier, ctx, rawMinQty, pathStack, options) => {
  let prep = ctx.preparationRecipes[prepName];
  if (!prep || lotMultiplier <= 0) return;
  if (Number(prep.stopFlag) === 1) return;

  options = options || {};
  let nestedMode = options.nestedMode || "fractional";
  let inProcess = options.inProcess || null;
  let lossRate = resolveYieldRate_(prepName, ctx);

  pathStack = pathStack || [];
  if (pathStack.indexOf(prepName) !== -1) return;
  pathStack.push(prepName);

  prep.ingredients.forEach((ing) => {
    let qty = ing.qty * lotMultiplier;
    if (qty <= 0) return;

    let target = routeUnifiedMaterial_(ing.name, ctx);
    if (target.kind === "prep") {
      let nestedPrep = ctx.preparationRecipes[target.name];
      if (!nestedPrep || Number(nestedPrep.stopFlag) === 1) return;

      let nestedMultiplier;
      if (nestedMode === "lotCount") {
        if (inProcess && inProcess[target.name]) {
          // 別途仕込み指示がある中間品は、親展開では原材料まで落とさない（二重計上防止）
          return;
        }
        let nestedFinished = prepIngredientQtyToFinishedQty_(qty, ing.unit, nestedPrep, target.name, ctx);
        let nestedLotSize = Number(nestedPrep.finishedQty) || 1;
        nestedMultiplier = nestedFinished / nestedLotSize;
      } else {
        let nestedFinished = prepIngredientQtyToFinishedQty_(qty, ing.unit, nestedPrep, target.name, ctx);
        let nestedLotSize = Number(nestedPrep.finishedQty) || 1;
        nestedMultiplier = nestedFinished / nestedLotSize;
      }
      accumulatePrepYieldLossRaw_(target.name, nestedMultiplier, ctx, rawMinQty, pathStack, options);
    } else if (target.kind === "raw") {
      if (lossRate >= 1) return;
      let lossQty = qty * (1 / lossRate - 1);
      if (lossQty <= 1e-9) return;
      let rawRow = ctx.rawMaster[target.name];
      let converted = convertToMinUnit(lossQty, ing.unit, rawRow);
      rawMinQty[target.name] = (rawMinQty[target.name] || 0) + converted;
    }
  });

  pathStack.pop();
};

/** 棚卸しスナップショット → 原材料最小単位マップ */
const stockSnapshotToRawMinQtyMap_ = (stockData, ctx) => {
  let rawMinQty = {};

  Object.keys(stockData.rawStock || {}).forEach((name) => {
    let stock = stockData.rawStock[name];
    let rawRow = ctx.rawMaster[name];
    if (!rawRow) return;
    let minQty = convertToMinUnit(stock.qty, stock.unit, rawRow);
    if (minQty > 0) rawMinQty[name] = (rawMinQty[name] || 0) + minQty;
  });

  Object.keys(stockData.prepStock || {}).forEach((pName) => {
    let stock = stockData.prepStock[pName];
    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;
    let finishedQty = convertPrepStockToProcessQty_(stock, prep, pName, ctx);
    if (finishedQty <= 0) return;
    let lotSize = Number(prep.finishedQty) || 1;
    expandPrepToRawMinQty_(pName, finishedQty / lotSize, ctx, rawMinQty, [], { nestedMode: "fractional" });
  });

  return rawMinQty;
};

/**
 * シミュレーション開始日（バックログ等の1日目）
 * - 月間: B2 の月の1日から
 * - 当日・週間: B2 から
 */
const getSimulationStartDate = (orderDate, period) => {
  let d = new Date(orderDate);
  if (isNaN(d.getTime())) return new Date();
  if (period === "月間") {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  return d;
};

/**
 * 期間モードと B2 からシミュレーション日数を決定
 * - 当日: 1日
 * - 週間: 7日（B2 から）
 * - 月間: その月の全日（1日〜末日）
 */
const resolveSimulationDays = (period, orderDate, b3Fallback) => {
  let d = new Date(orderDate);
  if (isNaN(d.getTime())) return 7;

  if (period === "当日") return 1;
  if (period === "週間") return 7;
  if (period === "月間") {
    let end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    let diff = Math.round((end.getTime() - d.getTime()) / 86400000);
    return diff < 0 ? 1 : diff + 1; // 開始日から当月末日まで
  }

  let n = Number(b3Fallback);
  return (n && n > 0) ? Math.floor(n) : 7;
};

/**
 * 指示書 B2 を必ずシミュレーション範囲に含む日数。
 * 棚卸し起点で週間7日などが短いとき、B2 が範囲外→別日を出力する不具合を防ぐ。
 */
const getMaxVendorLeadTimeDays_ = (ss) => {
  if (!ss) return 0;
  let sheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  if (!sheet) return 0;
  return getMaxVendorLeadTimeDaysFromData_(loadSTVendorCalendar(sheet));
};

const getMaxVendorLeadTimeDaysFromData_ = (vendorData) => {
  let cals = (vendorData && vendorData.calendars) || {};
  let maxLt = 0;
  Object.keys(cals).forEach((vName) => {
    maxLt = Math.max(maxLt, Number(cals[vName].leadTime) || 0);
  });
  return maxLt;
};

const resolveSimulationDaysIncludingOrderDate = (period, simStartDate, orderDate, b3Fallback, maxLeadTimeDays) => {
  let baseDays = resolveSimulationDays(period, simStartDate, b3Fallback);
  let idxForOrder = getOrderSheetDayIndex(orderDate, period, simStartDate);
  let ltBuf = Math.max(0, Number(maxLeadTimeDays) || 0);
  return Math.max(baseDays, idxForOrder + 1 + ltBuf);
};

/** 指示書に出す日の simulationResults インデックス（JST基準） */
const getOrderSheetDayIndex = (orderDate, period, simStartDate) => {
  if (orderDate == null || simStartDate == null) return 0;
  let diff = Math.round(
    (new Date(formatJstDate_(orderDate) + "T12:00:00").getTime()
      - new Date(formatJstDate_(simStartDate) + "T12:00:00").getTime()) / 86400000
  );
  return diff < 0 ? 0 : diff;
};

/** 画面右下のトースト通知（モーダルではない）。UI不可時は Logger */
const notifyUser = (message, title) => {
  let msg = String(message == null ? "" : message);
  let toastTitle = title || "発注管理";
  let timeoutSec = 10;
  try {
    let ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      ss.toast(msg, toastTitle, timeoutSec);
      return;
    }
  } catch (e) {
    // getActiveSpreadsheet 不可（エディタ単体実行など）
  }
  Logger.log(`[${toastTitle}] ${msg}`);
};

/** シートの指定行から values を書き込む（第3引数は行数） */
const writeSheetRows = (sheet, startRow, startCol, values) => {
  if (!sheet || !values || values.length === 0) return;
  let numRows = values.length;
  let numCols = values[0].length;
  sheet.getRange(startRow, startCol, numRows, numCols).setValues(values);
};

/** startRow 以降・指定列幅をクリア */
const clearSheetFromRow = (sheet, startRow, startCol, numCols) => {
  if (!sheet) return;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return;
  sheet.getRange(startRow, startCol, lastRow - startRow + 1, numCols).clearContent();
};

/** 指示書の仕込み・発注データ行の開始行 */
const ORDER_SHEET_DATA_START_ROW = 4;
const ORDER_SHEET_ALT_BG_GRAY = "#f3f3f3";
const ORDER_SHEET_ALT_BG_WHITE = "#ffffff";

const AI_SNAPSHOT_PROP_PREFIX = "AI_SNAPSHOT_";

/**
 * 指示書 手動入力エリア（O2:Q15）
 * O2=見出し / O3=原材料名 / O4-O15=手動調整項目（プルダウン含む）
 * P3=数量 / P4-P15=数量 / Q3=単位 / Q4-Q15=単位
 */
const ORDER_SHEET_MANUAL_INPUT = {
  labelRow: 2,
  headerRow: 3,
  dataStartRow: 4,
  dataEndRow: 15,
  nameCol: 15,
  qtyCol: 16,
  unitCol: 17,
  dropdownItems: ["生樽", "炭酸ガス"]
};

/** 指示書 O2:Q15 の見出しとプルダウンを整備 */
const setupOrderSheetManualInputArea = (sheet) => {
  if (!sheet || sheet.getName() !== SHEET_NAMES.ORDER_FORM) return;

  let cfg = ORDER_SHEET_MANUAL_INPUT;
  let props = PropertiesService.getScriptProperties();
  props.setProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM, "1");
  try {
    sheet.getRange("O2").setValue("手動入力");
    sheet.getRange("O3").setValue("原材料名");
    sheet.getRange("P3").setValue("数量");
    sheet.getRange("Q3").setValue("単位");

    let rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(cfg.dropdownItems, true)
      .setAllowInvalid(false)
      .build();
    // 既存運用の固定行（O4:O5）のみバリデーションを付与し、O6:O15 はユーザー設定を保持する。
    sheet.getRange(4, cfg.nameCol, 2, 1).setDataValidation(rule);

    // 生樽・炭酸ガスの固定行は初期単位を「本」に揃える。
    let unitVals = sheet.getRange(4, cfg.unitCol, 2, 1).getValues();
    let nextUnits = unitVals.map((row) => [String(row[0]).trim() || "本"]);
    sheet.getRange(4, cfg.unitCol, 2, 1).setValues(nextUnits);
  } finally {
    props.deleteProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM);
  }
};

/** 手動入力エリア（O2:Q15）のセルか */
const isOrderSheetManualInputAreaCell_ = (row, col) => {
  let cfg = ORDER_SHEET_MANUAL_INPUT;
  return row >= cfg.labelRow && row <= cfg.dataEndRow
    && col >= cfg.nameCol && col <= cfg.unitCol;
};

/** onEdit: 手動入力エリアの編集か（ここではシート書換え・チェックボックス処理をしない） */
const isOrderSheetManualInputEdit_ = (e) => {
  if (!e || !e.range) return false;
  let row = e.range.getRow();
  let col = e.range.getColumn();
  let endRow = row + e.range.getNumRows() - 1;
  let endCol = col + e.range.getNumColumns() - 1;
  for (let r = row; r <= endRow; r++) {
    for (let c = col; c <= endCol; c++) {
      if (isOrderSheetManualInputAreaCell_(r, c)) return true;
    }
  }
  return false;
};

/** 手動入力エリア O2:Q15 のスナップショット */
const snapshotOrderSheetManualInput_ = (sheet) => {
  let cfg = ORDER_SHEET_MANUAL_INPUT;
  let numRows = cfg.dataEndRow - cfg.labelRow + 1;
  return sheet.getRange(cfg.labelRow, cfg.nameCol, numRows, 3).getValues();
};

/** 手動入力エリアを復元（シミュレーション出力後） */
const restoreOrderSheetManualInput_ = (sheet, snapshot) => {
  if (!sheet || !snapshot || snapshot.length === 0) return;
  let cfg = ORDER_SHEET_MANUAL_INPUT;
  let numRows = snapshot.length;
  sheet.getRange(cfg.labelRow, cfg.nameCol, numRows, 3).setValues(snapshot);
};

/** 手動入力名から単位を解決（生樽・炭酸ガスは本固定） */
const resolveOrderSheetManualInputUnit_ = (name, rawMaster) => {
  let itemName = String(name || "").trim();
  if (!itemName) return "";
  if (itemName === "生樽" || itemName === "炭酸ガス") return "本";
  let rawRow = rawMaster && rawMaster[itemName] ? rawMaster[itemName] : null;
  return rawRow && rawRow.orderUnit ? String(rawRow.orderUnit).trim() : "";
};

/** onEdit: O列の選択内容から Q列の単位を自動入力 */
const syncOrderSheetManualInputUnits_ = (e) => {
  if (!e || !e.range) return;
  let range = e.range;
  let sheet = range.getSheet();
  if (!sheet || sheet.getName() !== SHEET_NAMES.ORDER_FORM) return;

  let cfg = ORDER_SHEET_MANUAL_INPUT;
  let editedStartCol = range.getColumn();
  let editedEndCol = editedStartCol + range.getNumColumns() - 1;
  if (editedStartCol > cfg.nameCol || editedEndCol < cfg.nameCol) return;

  let editedStartRow = range.getRow();
  let editedEndRow = editedStartRow + range.getNumRows() - 1;
  let rowStart = Math.max(cfg.dataStartRow, editedStartRow);
  let rowEnd = Math.min(cfg.dataEndRow, editedEndRow);
  if (rowEnd < rowStart) return;

  let numRows = rowEnd - rowStart + 1;
  let names = sheet.getRange(rowStart, cfg.nameCol, numRows, 1).getValues();
  let units = sheet.getRange(rowStart, cfg.unitCol, numRows, 1).getValues();
  let rawMaster = loadRawMaterialMasterCached_(sheet.getParent());
  let changed = false;

  for (let i = 0; i < numRows; i++) {
    let name = String(names[i][0] || "").trim();
    if (!name) {
      if (String(units[i][0] || "").trim() !== "") {
        units[i][0] = "";
        changed = true;
      }
      continue;
    }
    let resolvedUnit = resolveOrderSheetManualInputUnit_(name, rawMaster);
    if (!resolvedUnit) continue;
    if (String(units[i][0] || "").trim() !== resolvedUnit) {
      units[i][0] = resolvedUnit;
      changed = true;
    }
  }

  if (changed) {
    sheet.getRange(rowStart, cfg.unitCol, numRows, 1).setValues(units);
  }
};

/** シミュレーション出力対象のみクリア（仕込み A:F / 発注 H:M）。手動入力 O:Q は触らない */
const clearOrderSheetSimulationBlocks_ = (sheet) => {
  if (!sheet) return;
  let startRow = ORDER_SHEET_DATA_START_ROW;
  let lastRow = sheet.getLastRow();
  if (lastRow < startRow) return;
  let numRows = lastRow - startRow + 1;
  sheet.getRange(startRow, 1, numRows, 6).clearContent().setBackground(ORDER_SHEET_ALT_BG_WHITE);
  sheet.getRange(startRow, 8, numRows, 6).clearContent().setBackground(ORDER_SHEET_ALT_BG_WHITE);
};

/** 指示書データ行へ交互背景色（グレー/白）を適用 */
const applyOrderSheetAlternatingBackgrounds_ = (sheet, startRow, startCol, numRows, numCols) => {
  if (!sheet || numRows <= 0 || numCols <= 0) return;
  let backgrounds = [];
  for (let r = 0; r < numRows; r++) {
    let rowColor = (r % 2 === 0) ? ORDER_SHEET_ALT_BG_GRAY : ORDER_SHEET_ALT_BG_WHITE;
    let row = [];
    for (let c = 0; c < numCols; c++) row.push(rowColor);
    backgrounds.push(row);
  }
  sheet.getRange(startRow, startCol, numRows, numCols).setBackgrounds(backgrounds);
};

/** 指示書 O4:Q15 から手動発注行を読み取る */
const readOrderSheetManualEntries = (orderSheet, ctx) => {
  let cfg = ORDER_SHEET_MANUAL_INPUT;
  let entries = [];
  if (!orderSheet) return entries;

  let numRows = cfg.dataEndRow - cfg.dataStartRow + 1;
  let vals = orderSheet.getRange(cfg.dataStartRow, cfg.nameCol, numRows, 3).getValues();

  for (let i = 0; i < vals.length; i++) {
    let name = String(vals[i][0]).trim();
    let qty = Number(vals[i][1]);
    if (!name || isNaN(qty) || qty <= 0) continue;

    let unit = String(vals[i][2]).trim();
    let rawRow = ctx && ctx.rawMaster ? ctx.rawMaster[name] : null;
    if (!unit && rawRow) unit = rawRow.orderUnit || "";

    entries.push({
      name: name,
      qty: qty,
      unit: unit,
      vendor: rawRow ? (rawRow.vendor || "未設定") : "未設定",
      category: "発注",
      source: "manual"
    });
  }
  return entries;
};

/** 手動発注を発注ブロック行へ反映（同名は手動数量で上書き） */
const mergeManualEntriesIntoOrderRows_ = (rightRows, manualEntries) => {
  if (!manualEntries || manualEntries.length === 0) return rightRows;

  let byName = {};
  rightRows.forEach((row, idx) => {
    byName[String(row[0]).trim()] = idx;
  });

  manualEntries.forEach((entry) => {
    let row = [
      entry.name,
      entry.qty,
      entry.unit || "個",
      entry.vendor || "未設定",
      "手動入力",
      ""
    ];
    if (byName[entry.name] !== undefined) {
      rightRows[byName[entry.name]] = row;
    } else {
      byName[entry.name] = rightRows.length;
      rightRows.push(row);
    }
  });
  return rightRows;
};

/** 同一実行内で原材料マスタを再利用 */
const loadRawMaterialMasterCached_ = (ss) => {
  if (!ss) return {};
  if (typeof loadRawMaterialMasterCached_._cache === "undefined") {
    loadRawMaterialMasterCached_._cache = {};
  }
  let key = String(ss.getId());
  if (loadRawMaterialMasterCached_._cache[key]) {
    return loadRawMaterialMasterCached_._cache[key];
  }
  let rawSheet = ss.getSheetByName(SHEET_NAMES.RAW_MASTER);
  let map = rawSheet ? loadRawMaterialMaster(rawSheet) : {};
  loadRawMaterialMasterCached_._cache[key] = map;
  return map;
};

/** 指示書 A1=操作プルダウン / B1=実行チェックボックス */
const ORDER_SHEET_ACTION_DROPDOWN_ = { row: 1, col: 1, a1: "A1" };
const ORDER_SHEET_B1_TRIGGER_ = { row: 1, col: 2, a1: "B1", label: "実行" };

/** A1 プルダウン選択肢 → 実行関数 */
const ORDER_SHEET_ACTION_MENU_ = [
  { label: "①計算実行", action: "runSimulationPipeline" },
  { label: "②確定コミット", action: "commitOrderSheetToBacklogAndLog" },
  { label: "③データ整理", action: "formatPosRawToClean" },
  { label: "④週次原価率計算", action: "runWeeklyFoodCostRatioPipeline" }
];

/** 旧方式のチェックボックス列（E1/I1=指示書, F1=予算・実績）— 開いたときにオフへ */
const LEGACY_TRIGGER_CHECKBOX_COLS_ = {
  "指示書": [5, 9],
  "予算・実績": [6]
};

const CHECKBOX_SKIP_PROPS_ = {
  ORDER_FORM: "SKIP_ORDER_SHEET_ONEDIT",
  BUDGET_ACTUAL: "SKIP_BUDGET_ACTUAL_ONEDIT"
};

/** A1 の表示値から実行メニュー項目を解決 */
const resolveOrderSheetActionMenuItem_ = (sheet) => {
  if (!sheet) return null;
  let val = String(sheet.getRange(ORDER_SHEET_ACTION_DROPDOWN_.a1).getValue() || "").trim();
  for (let i = 0; i < ORDER_SHEET_ACTION_MENU_.length; i++) {
    if (ORDER_SHEET_ACTION_MENU_[i].label === val) {
      return ORDER_SHEET_ACTION_MENU_[i];
    }
  }
  return null;
};

/**
 * 予算・実績 D2（年月アンカー、日は無視される）: 前後数ヶ月の "yyyy年M月" 一覧をプルダウン化。
 * セルには表示用と同じテキスト（例: "2026年7月"）をそのまま入れる
 * （Date値だと選択肢一覧がSheets標準の日付表記になり読みにくいため文字列で統一）。
 * 外部APIを使わないため onOpen（シンプルトリガー）から呼んでも権限エラーにならず、
 * 開くたびに現在月基準へレンジが自動スライドする。
 */
const BUDGET_START_DATE_CELL_ = "D2";
const BUDGET_START_DATE_MONTHS_BEFORE_ = 12;
const BUDGET_START_DATE_MONTHS_AFTER_ = 3;

const formatBudgetYearMonthLabel_ = (year, month) => {
  return `${year}年${month + 1}月`;
};

const setupBudgetStartDateDropdown_ = (budgetSheet) => {
  if (!budgetSheet) return;

  let now = new Date();
  let baseYear = now.getFullYear();
  let baseMonth = now.getMonth();

  let options = [];
  for (let offset = -BUDGET_START_DATE_MONTHS_BEFORE_; offset <= BUDGET_START_DATE_MONTHS_AFTER_; offset++) {
    let d = new Date(baseYear, baseMonth + offset, 1);
    options.push(formatBudgetYearMonthLabel_(d.getFullYear(), d.getMonth()));
  }

  let props = PropertiesService.getScriptProperties();
  props.setProperty("SKIP_BUDGET_WEEKDAY_ONEDIT", "1");
  try {
    let cell = budgetSheet.getRange(BUDGET_START_DATE_CELL_);

    let rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(options, true)
      .setAllowInvalid(false)
      .build();
    cell.setDataValidation(rule);

    let current = String(cell.getValue() || "").trim();
    if (options.indexOf(current) === -1) {
      cell.setValue(formatBudgetYearMonthLabel_(baseYear, baseMonth));
    }
  } finally {
    props.deleteProperty("SKIP_BUDGET_WEEKDAY_ONEDIT");
  }
};

/** 指示書 A1 プルダウンと B1 チェックボックスを整備 */
const setupOrderSheetActionControls_ = (sheet) => {
  if (!sheet || sheet.getName() !== SHEET_NAMES.ORDER_FORM) return;

  let props = PropertiesService.getScriptProperties();
  props.setProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM, "1");
  try {
    let labels = ORDER_SHEET_ACTION_MENU_.map((item) => item.label);
    let a1 = sheet.getRange(ORDER_SHEET_ACTION_DROPDOWN_.row, ORDER_SHEET_ACTION_DROPDOWN_.col);
    let current = String(a1.getValue() || "").trim();
    let rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(labels, true)
      .setAllowInvalid(false)
      .build();
    a1.setDataValidation(rule);
    if (labels.indexOf(current) === -1) {
      a1.setValue(labels[0]);
    }

    let b1 = sheet.getRange(ORDER_SHEET_B1_TRIGGER_.row, ORDER_SHEET_B1_TRIGGER_.col);
    if (b1.getDataValidation() == null) {
      b1.insertCheckboxes();
      b1.setValue(false);
    }
  } finally {
    props.deleteProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM);
  }
};

/** 旧トリガー列のチェックボックスをオフ（移行用） */
const clearLegacySheetTriggerCheckboxes_ = (sheet) => {
  if (!sheet) return;
  let cols = LEGACY_TRIGGER_CHECKBOX_COLS_[sheet.getName()];
  if (!cols || cols.length === 0) return;

  let skipKey = sheet.getName() === SHEET_NAMES.ORDER_FORM
    ? CHECKBOX_SKIP_PROPS_.ORDER_FORM
    : CHECKBOX_SKIP_PROPS_.BUDGET_ACTUAL;
  let props = PropertiesService.getScriptProperties();
  props.setProperty(skipKey, "1");
  try {
    cols.forEach((col) => {
      uncheckRangeSafely(sheet.getRange(1, col));
    });
    SpreadsheetApp.flush();
  } finally {
    props.deleteProperty(skipKey);
  }
};

/** 範囲内のチェックボックスをすべてオフにする */
const uncheckRangeSafely = (range) => {
  if (!range) return;
  let cleared = false;
  try {
    range.uncheck();
    cleared = true;
  } catch (e) {
    // uncheck 非対応・混在範囲時は setValue(false) へ
  }
  if (range.getValue() === true) {
    range.setValue(false);
    cleared = true;
  }
  if (cleared) SpreadsheetApp.flush();
};

/** 指示書 B1 実行チェックボックスをオフにする */
const clearOrderSheetCheckboxes = (sheet) => {
  clearSheetTriggerCheckboxes_(sheet, [ORDER_SHEET_B1_TRIGGER_], CHECKBOX_SKIP_PROPS_.ORDER_FORM);
};

const clearSheetTriggerCheckboxes_ = (sheet, triggerCells, skipPropKey) => {
  if (!sheet || !triggerCells || triggerCells.length === 0) return;
  let props = PropertiesService.getScriptProperties();
  props.setProperty(skipPropKey, "1");
  try {
    triggerCells.forEach((cell) => {
      uncheckRangeSafely(sheet.getRange(cell.row, cell.col));
    });
    SpreadsheetApp.flush();
  } finally {
    props.deleteProperty(skipPropKey);
  }
};

/** 1行目の操作チェックボックス列を初期化（未設定セルのみ） */
const setupSheetTriggerCheckboxes_ = (sheet, triggerCells, skipPropKey) => {
  if (!sheet || !triggerCells) return;
  let props = PropertiesService.getScriptProperties();
  props.setProperty(skipPropKey, "1");
  try {
    triggerCells.forEach((cell) => {
      let range = sheet.getRange(cell.row, cell.col, 1, 1);
      if (range.getDataValidation() == null) {
        range.insertCheckboxes();
        range.setValue(false);
      }
    });
  } finally {
    props.deleteProperty(skipPropKey);
  }
};

/** 指示書 B1 がオン固定のまま残っているときにリセット */
const resetStuckOrderSheetCheckboxIfNeeded_ = (sheet) => {
  if (!sheet) return;
  let range = sheet.getRange(ORDER_SHEET_B1_TRIGGER_.row, ORDER_SHEET_B1_TRIGGER_.col);
  if (range.getValue() === true) {
    clearOrderSheetCheckboxes(sheet);
  }
};

/** 前回異常終了で残ったスキップフラグを除去 */
const clearStaleCheckboxSkipProps_ = () => {
  let props = PropertiesService.getScriptProperties();
  props.deleteProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM);
  props.deleteProperty(CHECKBOX_SKIP_PROPS_.BUDGET_ACTUAL);
};

/** インストール型 onEdit が無ければ作成（simple より oldValue・実行時間に有利） */
const ensureOnEditInstallableTrigger_ = (ss) => {
  let spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return;

  let triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "onEditInstallable"
      && triggers[i].getEventType() === ScriptApp.EventType.ON_EDIT) {
      return;
    }
  }

  try {
    ScriptApp.newTrigger("onEditInstallable")
      .forSpreadsheet(spreadsheet)
      .onEdit()
      .create();
    Logger.log("[トリガー] インストール型 onEdit を作成しました");
  } catch (err) {
    Logger.log(`[トリガー] インストール型 onEdit の作成をスキップ: ${err.message}`);
  }
};

/**
 * インストール型 onEdit トリガーを手動セットアップ（メニューから実行する用）
 * onOpen（シンプルトリガー）内からは ScriptApp.getProjectTriggers を呼べないため、
 * ここに切り出して権限のあるコンテキスト（メニュークリック）から実行できるようにする。
 */
const setupOnEditInstallableTrigger = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let already = ScriptApp.getProjectTriggers().some((t) => {
    return t.getHandlerFunction() === "onEditInstallable" && t.getEventType() === ScriptApp.EventType.ON_EDIT;
  });
  if (already) {
    notifyUser("インストール型 onEdit トリガーは既に設定済みです。");
    return;
  }
  ensureOnEditInstallableTrigger_(ss);
  notifyUser("インストール型 onEdit トリガーを設定しました（長時間実行・oldValue対応）。");
};

/**
 * スクリプトによるチェック解除 onEdit はスキップ。
 * ユーザーがトリガーセルをオンにしたとき、古いスキップフラグは除去して処理を続行。
 */
const isCheckboxSkipActive_ = (skipPropKey, e, triggerCells) => {
  let props = PropertiesService.getScriptProperties();
  if (props.getProperty(skipPropKey) !== "1") return false;
  if (isSheetCheckboxTriggerEdit_(e, triggerCells)) {
    props.deleteProperty(skipPropKey);
    Logger.log(`[チェックボックス] 古いスキップフラグを解除: ${skipPropKey}`);
    return false;
  }
  return true;
};

/**
 * チェックボックスが TRUE（オフ→オン）のときだけ actionFn を実行し、終了後に必ず FALSE へ戻す
 */
const runCheckboxAction_ = (sheet, triggerCell, actionFn, label, skipPropKey) => {
  try {
    actionFn();
  } catch (err) {
    Logger.log(`[${label}] エラー: ${err.message}`);
    notifyUser(`${label}でエラーが発生しました:\n${err.message}`, label);
  } finally {
    if (sheet && triggerCell) {
      clearSheetTriggerCheckboxes_(sheet, [triggerCell], skipPropKey);
    }
  }
};

/** onEdit: 1行目・トリガー列・チェックがオフ→オンになった操作のみ */
const isSheetCheckboxTriggerEdit_ = (e, triggerCells) => {
  if (!e || !e.range || !triggerCells || triggerCells.length === 0) return null;
  if (e.range.getRow() !== 1 || e.range.getNumRows() !== 1) return null;

  let col = e.range.getColumn();
  let trigger = null;
  for (let i = 0; i < triggerCells.length; i++) {
    if (triggerCells[i].col === col) {
      trigger = triggerCells[i];
      break;
    }
  }
  if (!trigger) return null;

  if (!isCheckboxTurnedOn_(e, e.range)) return null;
  return trigger;
};

/** チェックボックスがオンになった値か */
const isCheckboxCheckedValue = (val) => {
  return val === true || val === "TRUE" || val === 1 || val === "1";
};

/** チェックがオフ→オンに変わった編集か（貼り付け・解除時の再実行を防ぐ） */
const isCheckboxTurnedOn_ = (e, range) => {
  let newVal = e && e.value;
  let oldVal = e && e.oldValue;
  if (newVal === undefined && range) newVal = range.getValue();
  if (!isCheckboxCheckedValue(newVal)) return false;
  if (oldVal === undefined) return true;
  return !isCheckboxCheckedValue(oldVal);
};

/** onEdit で値が実質変わっていない編集を無視 */
const editValueUnchanged_ = (e) => {
  if (!e) return true;
  let oldV = e.oldValue;
  let newV = e.value;
  if (oldV === undefined && newV === undefined) return true;
  if (oldV === undefined || newV === undefined) return false;
  return String(oldV) === String(newV);
};

/**
 * 指示書 B2 日に載せる発注行（当日に発注指示する分のみ）
 * 発注指示日 + LT = 納品日 が業者カレンダー上許可される場合だけ載せる。
 */
const collectOrderSheetOrdersForDay_ = (ctx, simulationResults, dayIdx) => {
  let merged = {};
  let holidayCache = {};
  let day = simulationResults[dayIdx];
  if (!day || !day.orders) return merged;

  Object.keys(day.orders).forEach((rName) => {
    let rawRow = ctx.rawMaster[rName];
    if (!rawRow) return;
    let vCal = ctx.vendorCalendars[rawRow.vendor];
    let deliveryCheck = resolveVendorOrderDeliveryDay(dayIdx, vCal, ctx, holidayCache);
    if (!deliveryCheck.allowed) return;

    merged[rName] = {
      aiQty: day.orders[rName].aiQty,
      unit: day.orders[rName].unit,
      vendor: day.orders[rName].vendor,
      reason: day.orders[rName].reason
        || ("本日発注→納品" + (deliveryCheck.deliveryDateStr || "")),
      orderKind: "placement"
    };
  });
  return merged;
};

/** 指示書仕込み欄に出さない仕込み品（低温用〇〇 など） */
const isPrepHiddenOnOrderSheet_ = (prepName) => {
  return String(prepName).indexOf("低温用") === 0;
};

/** 指示書仕込み欄の表示変換（内部aiQtyは仕込み量のまま、表示のみロット換算） */
const getPrepOrderSheetDisplayRule_ = (prepName) => {
  let rules = {
    "合わせつけだれ": { unit: "本", multiplier: 1 },
    "合わせ塩だれ": { unit: "本", multiplier: 1 },
    "合わせ味噌だれ": { unit: "本", multiplier: 1 },
    "合わせユッケだれ": { unit: "本", multiplier: 1 },
    "合わせヤンジャン": { unit: "パック", multiplier: 1 },
    "仕込み牛タン": { unit: "パック", multiplier: 1 },
    "カットレバ刺し": { unit: "パック", multiplier: 1 },
    "カットタン刺し": { unit: "パック", multiplier: 1 },
    "カットハツ刺し": { unit: "パック", multiplier: 1 },
    "カットがつミノ": { unit: "パック", multiplier: 1 },
    "カットカメノコ": { unit: "パック", multiplier: 1 },
    "仕込みヤゲン軟骨": { unit: "パック", multiplier: 1 },
    "スライスすだち": { unit: "個", multiplier: 1 },
    "小松菜のナムル": { unit: "束", multiplier: 6 },
    "カットきゅうり": { unit: "本", multiplier: 1 },
    "カットなす": { unit: "本", multiplier: 1 },
    "キムチねぎ": { unit: "本", multiplier: 1 },
    "小口ネギ": { unit: "本", multiplier: 1 },
    "カットジンギスカン": { unit: "kg", ceilKg: true },
    "カットハラミ": { unit: "kg", ceilKg: true },
    "カットレバー": { tapperKg: 1.5 }
  };
  return rules[prepName] || null;
};

/** 仕込み量を kg 換算（表示用・切上げなし） */
const resolvePrepAmountAsKg_ = (prepAmount, prepMasterRow, rule) => {
  let amount = Number(prepAmount) || 0;
  if (amount <= 0) return 0;

  let prepUnit = prepMasterRow ? String(prepMasterRow.processUnit).trim() : "";
  if (normalizeUnitKey(prepUnit) === "kg") return amount;
  if (normalizeUnitKey(prepUnit) === "g") return amount / 1000;
  if (isServingLikeUnit_(prepUnit)) {
    let gramsPerServing = resolvePrepGramsPerServing_(prepMasterRow, rule);
    return (amount * gramsPerServing) / 1000;
  }

  let lotSize = prepMasterRow ? (Number(prepMasterRow.finishedQty) || 1) : 1;
  let gramsPerServing = resolvePrepGramsPerServing_(prepMasterRow, rule);
  return ((amount / lotSize) * gramsPerServing) / 1000;
};

/** 1人前あたりのグラム数（中間レシピ・原材料マスタから解決、未設定時は150g） */
const resolvePrepGramsPerServing_ = (prepMasterRow, rule, ctx) => {
  if (rule && Number(rule.gramsPerServing) > 0) return Number(rule.gramsPerServing);

  if (prepMasterRow) {
    let totalG = sumPrepBatchQtyInUnit_(prepMasterRow, null, "g", ctx, []);
    if (totalG > 0) {
      let lotSize = Number(prepMasterRow.finishedQty) || 1;
      let prepUnit = String(prepMasterRow.processUnit).trim();
      if (isServingLikeUnit_(prepUnit) || normalizeUnitKey(prepUnit) === "g") {
        return totalG / lotSize;
      }
      return totalG;
    }
  }
  return 150;
};

/** 仕込み指示表示: 人前等 → kg（1kg刻み切上げ） */
const formatPrepQtyAsCeilKg_ = (prepAmount, prepMasterRow, rule) => {
  return Math.ceil(resolvePrepAmountAsKg_(prepAmount, prepMasterRow, rule));
};

/** 仕込み品の仕入先業者（中間レシピ表の列 → なければ主原材料の業者） */
const resolvePrepVendor_ = (prepName, prepMasterRow, ctx) => {
  if (prepMasterRow && prepMasterRow.vendor) return prepMasterRow.vendor;
  if (!prepMasterRow || !prepMasterRow.ingredients || !ctx || !ctx.rawMaster) return "";
  let best = null;
  prepMasterRow.ingredients.forEach((ing) => {
    let raw = ctx.rawMaster[ing.name];
    if (!raw || !raw.vendor) return;
    let qty = Number(ing.qty) || 0;
    if (!best || qty > best.qty) best = { vendor: raw.vendor, qty: qty };
  });
  return best ? best.vendor : "";
};

const getVendorSortIndex_ = (vendor, ctx) => {
  if (!vendor) return 99999;
  let order = (ctx && ctx.vendorOrder) ? ctx.vendorOrder : [];
  let idx = order.indexOf(vendor);
  return idx === -1 ? 99998 : idx;
};

const comparePrepForOrderSheet_ = (prepA, prepB, ctx) => {
  let rowA = ctx.preparationRecipes[prepA];
  let rowB = ctx.preparationRecipes[prepB];
  let vendorA = resolvePrepVendor_(prepA, rowA, ctx) || "未設定";
  let vendorB = resolvePrepVendor_(prepB, rowB, ctx) || "未設定";
  let vIdxA = getVendorSortIndex_(vendorA === "未設定" ? "" : vendorA, ctx);
  let vIdxB = getVendorSortIndex_(vendorB === "未設定" ? "" : vendorB, ctx);
  if (vIdxA !== vIdxB) return vIdxA - vIdxB;
  if (vendorA !== vendorB) return vendorA.localeCompare(vendorB, "ja");
  let sortA = rowA ? (Number(rowA.sortOrder) || 9999) : 9999;
  let sortB = rowB ? (Number(rowB.sortOrder) || 9999) : 9999;
  if (sortA !== sortB) return sortA - sortB;
  let rowIdxA = rowA ? (Number(rowA.sheetRowIndex) || 0) : 0;
  let rowIdxB = rowB ? (Number(rowB.sheetRowIndex) || 0) : 0;
  if (rowIdxA !== rowIdxB) return rowIdxA - rowIdxB;
  return prepA.localeCompare(prepB, "ja");
};

const sortPrepNamesForOrderSheet_ = (inProcess, ctx) => {
  return Object.keys(inProcess || {}).sort((a, b) => {
    return comparePrepForOrderSheet_(a, b, ctx);
  });
};

const formatPrepOrderSheetDisplay_ = (prepName, item, prepMasterRow) => {
  if (isPrepHiddenOnOrderSheet_(prepName)) return null;

  let prepAmount = Number(item && item.aiQty) || 0;
  if (prepAmount <= 0) return null;

  let lotSize = prepMasterRow ? (Number(prepMasterRow.finishedQty) || 1) : 1;
  if (lotSize <= 0) lotSize = 1;

  let rule = getPrepOrderSheetDisplayRule_(prepName);
  if (!rule) {
    return {
      qty: prepAmount,
      unit: prepMasterRow ? prepMasterRow.processUnit : (item.unit || "回")
    };
  }

  if (rule.ceilKg) {
    return {
      qty: formatPrepQtyAsCeilKg_(prepAmount, prepMasterRow, rule),
      unit: "kg"
    };
  }

  if (rule.tapperKg) {
    let predictedKg = resolvePrepAmountAsKg_(prepAmount, prepMasterRow, rule);
    let tapperSize = Number(rule.tapperKg) || 1.5;
    let tappers = Math.ceil(predictedKg / tapperSize);
    if (tappers < 1) tappers = 1;
    return {
      qty: tappers,
      unit: "タッパー"
    };
  }

  let lotUnits = prepAmount / lotSize;
  let qty = lotUnits * (rule.multiplier || 1);
  if (Math.abs(qty - Math.round(qty)) < 1e-6) qty = Math.round(qty);
  return { qty: qty, unit: rule.unit };
};

const outputToOrderSheet = (sheet, todayResults, ctx) => {
  if (!sheet) return;

  let leftRows = [];
  let rightRows = [];
  
  sortPrepNamesForOrderSheet_(todayResults.inProcess, ctx).forEach((name) => {
    let item = todayResults.inProcess[name];
    let prepMasterRow = ctx.preparationRecipes[name];
    let display = formatPrepOrderSheetDisplay_(name, item, prepMasterRow);
    if (!display || display.qty <= 0) return;

    leftRows.push([name, display.qty, display.unit, "", "", ""]);
  });

  Object.keys(todayResults.orders).forEach((name) => {
    let item = todayResults.orders[name];
    let display = formatOrderSheetOrderQty_(item.aiQty, ctx.rawMaster[name], name);
    if (display.qty <= 0) return;
    rightRows.push([name, display.qty, display.unit, item.vendor || "未設定", "", ""]);
  });

  let manualEntries = readOrderSheetManualEntries(sheet, ctx);
  rightRows = mergeManualEntriesIntoOrderRows_(rightRows, manualEntries);

  let props = PropertiesService.getScriptProperties();
  props.setProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM, "1");
  try {
    let manualSnapshot = snapshotOrderSheetManualInput_(sheet);
    clearOrderSheetSimulationBlocks_(sheet);

    if (leftRows.length > 0) {
      writeSheetRows(sheet, ORDER_SHEET_DATA_START_ROW, 1, leftRows);
      applyOrderSheetAlternatingBackgrounds_(sheet, ORDER_SHEET_DATA_START_ROW, 1, leftRows.length, 6);
    }
    if (rightRows.length > 0) {
      writeSheetRows(sheet, ORDER_SHEET_DATA_START_ROW, 8, rightRows);
      applyOrderSheetAlternatingBackgrounds_(sheet, ORDER_SHEET_DATA_START_ROW, 8, rightRows.length, 6);
    }
    restoreOrderSheetManualInput_(sheet, manualSnapshot);
  } finally {
    props.deleteProperty(CHECKBOX_SKIP_PROPS_.ORDER_FORM);
  }
};

/** シミュレーション直後の AI 予測値を保存（I1 確定コミット時の比較用） */
const saveOrderSheetAiSnapshot_ = (orderDate, dayForSheet, ctx) => {
  if (!orderDate || !dayForSheet) return;
  let dateStr = Utilities.formatDate(new Date(orderDate), "JST", "yyyy-MM-dd");
  let snapshot = {
    date: dateStr,
    baseFlag: dayForSheet.baseFlag || "予算ベース",
    prep: {},
    order: {}
  };

  sortPrepNamesForOrderSheet_(dayForSheet.inProcess, ctx).forEach((name) => {
    let item = dayForSheet.inProcess[name];
    let prepMasterRow = ctx.preparationRecipes[name];
    let display = formatPrepOrderSheetDisplay_(name, item, prepMasterRow);
    if (!display || display.qty <= 0) return;
    snapshot.prep[name] = {
      qty: display.qty,
      unit: display.unit,
      aiQty: Number(item.aiQty) || 0
    };
  });

  Object.keys(dayForSheet.orders || {}).forEach((name) => {
    let item = dayForSheet.orders[name];
    let display = formatOrderSheetOrderQty_(item.aiQty, ctx.rawMaster[name], name);
    if (display.qty <= 0) return;
    snapshot.order[name] = { qty: display.qty, unit: display.unit, aiQty: display.aiQty };
  });

  PropertiesService.getScriptProperties().setProperty(
    AI_SNAPSHOT_PROP_PREFIX + dateStr,
    JSON.stringify(snapshot)
  );
};

/** 保存済み AI 予測スナップショットを読み込む */
const loadOrderSheetAiSnapshot_ = (dateStr) => {
  if (!dateStr) return null;
  let raw = PropertiesService.getScriptProperties().getProperty(AI_SNAPSHOT_PROP_PREFIX + dateStr);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
};

/** 指示書ブロック（仕込み=左 / 発注=右）の列メタを取得 */
const getOrderSheetBlockMeta_ = (orderSheet, category) => {
  let isPrep = category === "仕込み";
  let minCol = isPrep ? 1 : 8;
  let maxCol = isPrep ? 6 : 13;
  let maxHeaderRow = 4;
  let changeHeader = isPrep ? "仕込み変更量" : "発注変更量";
  let reasonHeader = isPrep ? "仕込み調整理由" : "発注調整理由";
  let lastCol = Math.max(orderSheet.getLastColumn(), maxCol);
  let headerRows = readOrderSheetHeaderRows_(orderSheet, maxHeaderRow, lastCol);

  let qtyCommittedCols = findHeaderColumnsInRowBlock_(headerRows, "確定量", maxHeaderRow, minCol, maxCol);
  let changeCols = findHeaderColumnsInRowBlock_(headerRows, changeHeader, maxHeaderRow, minCol, maxCol);
  let reasonCols = findHeaderColumnsInRowBlock_(headerRows, reasonHeader, maxHeaderRow, minCol, maxCol);
  let displayQtyCols = findHeaderColumnsInRowBlock_(
    headerRows, isPrep ? "表示数量" : "発注数", maxHeaderRow, minCol, maxCol
  );

  let headerRow = 3;
  [qtyCommittedCols, changeCols, reasonCols, displayQtyCols].forEach((cols) => {
    if (cols.length > 0 && cols[0].headerRow > headerRow) headerRow = cols[0].headerRow;
  });

  let nameCol = resolveNameColumnForBlock(orderSheet, headerRow, isPrep ? 3 : 10);
  if (nameCol < minCol || nameCol > maxCol) {
    nameCol = isPrep ? 1 : 8;
  }

  let displayQtyCol = displayQtyCols.length > 0 ? displayQtyCols[0].col : (isPrep ? 2 : 9);
  let unitCol = isPrep ? 3 : 10;
  let qtyCommittedCol = qtyCommittedCols.length > 0 ? qtyCommittedCols[0].col : 0;
  let changeCol = changeCols.length > 0 ? changeCols[0].col : 0;
  let reasonCol = reasonCols.length > 0 ? reasonCols[0].col : 0;

  return {
    category: category,
    minCol: minCol,
    maxCol: maxCol,
    headerRow: headerRow,
    dataStartRow: Math.max(headerRow + 1, ORDER_SHEET_DATA_START_ROW),
    nameCol: nameCol,
    displayQtyCol: displayQtyCol,
    unitCol: unitCol,
    qtyCommittedCol: qtyCommittedCol,
    changeCol: changeCol,
    reasonCol: reasonCol
  };
};

const readOrderSheetHeaderRows_ = (orderSheet, maxHeaderRow, lastCol) => {
  lastCol = lastCol || Math.max(orderSheet.getLastColumn(), 13);
  return orderSheet.getRange(1, 1, maxHeaderRow, lastCol).getValues();
};

const findHeaderColumnsInRowBlock_ = (headerRows, headerName, maxHeaderRow, minCol, maxCol) => {
  let found = [];
  let rowLimit = Math.min(headerRows.length, maxHeaderRow);
  for (let r = 0; r < rowLimit; r++) {
    let row = headerRows[r];
    for (let c = minCol - 1; c < maxCol && c < row.length; c++) {
      if (String(row[c]).trim() === headerName) {
        found.push({ headerRow: r + 1, col: c + 1 });
      }
    }
  }
  return found;
};

const findHeaderColumnsInColumnRange_ = (sheet, headerName, maxHeaderRow, minCol, maxCol) => {
  let lastCol = Math.max(sheet.getLastColumn(), maxCol);
  let headerRows = readOrderSheetHeaderRows_(sheet, maxHeaderRow, lastCol);
  return findHeaderColumnsInRowBlock_(headerRows, headerName, maxHeaderRow, minCol, maxCol);
};

/** 指示書ブロックの名称列を見出しから解決（見つからなければ既定列） */
const resolveNameColumnForBlock = (sheet, headerRow, defaultCol) => {
  if (!sheet) return defaultCol;
  let minCol = defaultCol <= 6 ? 1 : 8;
  let maxCol = defaultCol <= 6 ? 6 : 13;
  let rowVals = sheet.getRange(headerRow, minCol, 1, maxCol - minCol + 1).getValues()[0];
  let candidates = ["商材名", "原材料名", "品名", "仕込み名", "メニュー名"];

  for (let i = 0; i < rowVals.length; i++) {
    let label = String(rowVals[i] == null ? "" : rowVals[i]).trim();
    if (candidates.indexOf(label) !== -1) return minCol + i;
  }
  return defaultCol;
};

const parseSheetNumericValue_ = (val) => {
  if (val === "" || val == null) return NaN;
  return Number(val);
};

const parseSheetTextValue_ = (val) => {
  return String(val == null ? "" : val).trim();
};

const resolveCommittedQty_ = (displayQty, committedQty) => {
  let c = parseSheetNumericValue_(committedQty);
  if (!isNaN(c) && c > 0) return c;
  let d = parseSheetNumericValue_(displayQty);
  return isNaN(d) ? 0 : d;
};

/** 指示書ブロックから確定数量付きの行を読み取る */
const readOrderSheetBlockRows_ = (orderSheet, category, aiSnapshot) => {
  let meta = getOrderSheetBlockMeta_(orderSheet, category);
  let lastRow = orderSheet.getLastRow();
  if (lastRow < meta.dataStartRow) return [];

  let aiKey = category === "仕込み" ? "prep" : "order";
  let aiMap = aiSnapshot && aiSnapshot[aiKey] ? aiSnapshot[aiKey] : {};
  let numCols = Math.max(meta.maxCol, orderSheet.getLastColumn());
  let rows = orderSheet.getRange(meta.dataStartRow, 1, lastRow - meta.dataStartRow + 1, numCols).getValues();
  let entries = [];

  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    let name = parseSheetTextValue_(row[meta.nameCol - 1]);
    if (!name) continue;

    let displayQty = row[meta.displayQtyCol - 1];
    let committedRaw = meta.qtyCommittedCol > 0 ? row[meta.qtyCommittedCol - 1] : "";
    let qty = resolveCommittedQty_(displayQty, committedRaw);
    if (qty <= 0) continue;

    let unit = parseSheetTextValue_(row[meta.unitCol - 1]);
    let changeQty = meta.changeCol > 0 ? row[meta.changeCol - 1] : "";
    let reason = meta.reasonCol > 0 ? parseSheetTextValue_(row[meta.reasonCol - 1]) : "";
    let aiEntry = aiMap[name];

    entries.push({
      name: name,
      category: category,
      qty: qty,
      unit: unit,
      changeQty: changeQty,
      reason: reason,
      aiQty: aiEntry ? aiEntry.qty : null,
      aiUnit: aiEntry ? aiEntry.unit : "",
      source: "sheet"
    });
  }
  return entries;
};

/** 手動調整ログ出力対象か（AI予測と異なる / 変更量・理由あり / 手動入力） */
const shouldLogManualAdjustmentEntry_ = (entry) => {
  if (!entry) return false;
  if (entry.source === "manual") return entry.qty > 0;

  if (parseSheetTextValue_(entry.changeQty) !== "") return true;
  if (parseSheetTextValue_(entry.reason) !== "") return true;
  if (entry.aiQty === null || entry.aiQty === undefined) return entry.qty > 0;
  return Math.abs(entry.qty - entry.aiQty) > 1e-6;
};

/** 確定コミット時にバックログの指定日付行を差し替え */
const replaceBacklogRowsForDate_ = (dateStr, newRowsForDate) => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.BACKLOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.BACKLOG);
  }

  let meta = ensureBacklogSheetMeta_(sheet);
  if (!meta) return 0;

  let idxDate = meta.headers.indexOf("日付");
  let numCols = meta.numCols || meta.headers.length;
  let startRow = meta.dataStartRow + 1;
  let lastRow = sheet.getLastRow();
  let existing = [];

  if (lastRow >= startRow) {
    let numRows = lastRow - startRow + 1;
    let rows = sheet.getRange(startRow, 1, numRows, numCols).getValues();
    for (let i = 0; i < rows.length; i++) {
      let rowDateStr = formatSheetDateToKey(rows[i][idxDate]);
      if (rowDateStr !== dateStr) existing.push(rows[i]);
    }
  }

  let combined = existing.concat(newRowsForDate || []);
  let retentionCtx = buildBacklogRetentionCtx_(dateStr, getInventoryDateStrFromSheet_());
  let merged = applyBacklogRetentionToRows_(combined, meta, retentionCtx);

  if (lastRow >= startRow) {
    sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).clearContent();
  }
  if (merged.length > 0) {
    let padded = merged.map((row) => {
      return padBacklogRow_(row, numCols);
    });
    sheet.getRange(startRow, 1, padded.length, numCols).setValues(padded);
  }
  return (newRowsForDate || []).length;
};

/** 確定コミット用: バックログ最小単位量（AIスナップショットが無くても落ちない） */
const resolveBacklogMinQtyForCommit_ = (aiSnapshot, category, name, fallbackQty) => {
  let key = category === "仕込み" ? "prep" : "order";
  let bucket = aiSnapshot && aiSnapshot[key] ? aiSnapshot[key] : null;
  let aiEntry = bucket ? bucket[name] : null;
  if (aiEntry && aiEntry.aiQty != null && !isNaN(aiEntry.aiQty)) return aiEntry.aiQty;
  return fallbackQty;
};

/** 指示書の確定内容からバックログ行を組み立てる */
const buildCommittedBacklogRows_ = (dateStr, orderSheet, aiSnapshot, rawMaster) => {
  let baseFlag = aiSnapshot && aiSnapshot.baseFlag ? aiSnapshot.baseFlag : "予算ベース";
  let rows = [];

  readOrderSheetBlockRows_(orderSheet, "仕込み", aiSnapshot).forEach((entry) => {
    let aiMin = resolveBacklogMinQtyForCommit_(aiSnapshot, "仕込み", entry.name, entry.qty);
    rows.push([dateStr, entry.name, "仕込み", entry.qty, 0, 0, aiMin, entry.qty, baseFlag]);
  });

  let orderByName = {};
  readOrderSheetBlockRows_(orderSheet, "発注", aiSnapshot).forEach((entry) => {
    orderByName[entry.name] = entry;
  });

  if (!rawMaster) {
    rawMaster = loadRawMaterialMasterCached_(orderSheet.getParent());
  }
  readOrderSheetManualEntries(orderSheet, { rawMaster: rawMaster }).forEach((entry) => {
    orderByName[entry.name] = {
      name: entry.name,
      qty: entry.qty,
      unit: entry.unit,
      aiQty: aiSnapshot && aiSnapshot.order && aiSnapshot.order[entry.name]
        ? aiSnapshot.order[entry.name].qty : null,
      source: "manual"
    };
  });

  Object.keys(orderByName).forEach((name) => {
    let entry = orderByName[name];
    if (!entry || entry.qty <= 0) return;
    let aiMin = resolveBacklogMinQtyForCommit_(aiSnapshot, "発注", name, entry.qty);
    rows.push([dateStr, name, "発注", entry.qty, 0, 0, aiMin, entry.qty, baseFlag]);
  });

  return rows;
};
