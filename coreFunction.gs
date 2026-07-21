/**
 * 2. core_func.gs: コア計算ロジック（仕込み確定→原材料消費→発注判定）
 */

/**
 * ロット管理＋期限廃棄対象の仕込み品（コード側で一元管理）
 * - meat_sashi: 金曜仕込みは3日間、通常は仕込み日+翌日+翌々日
 * - next_day: 仕込み日+翌日まで（曜日共通）。納品日に当日分をカット、翌日分は翌日カット
 * - same_day: 仕込み日当日限り。翌日には持ち越さず廃棄（繰越禁止）
 */
const PREP_LOT_EXPIRY_RULES_ = {
  "カットタン刺し": "meat_sashi",
  "カットハツ刺し": "meat_sashi",
  "カットレバ刺し": "meat_sashi",
  "カットレバー": "next_day",
  "ご飯": "same_day"
};

/** ロット繰越管理の対象は全仕込み品（期限ルールは PREP_LOT_EXPIRY_RULES_ 定義品のみ適用） */
const getAllPrepItemNames_ = (ctx) => {
  return Object.keys((ctx && ctx.preparationRecipes) || {});
};

/** 翌日予算50%先読みを加算しない仕込み品（当日炊飯・当日限りのご飯など） */
const PREP_LOOKAHEAD_EXCLUDED_ITEMS_ = {
  "ご飯": true
};

/** 翌日先読み分の需要マップから対象外品目を除外する */
const stripExcludedLookaheadItems_ = (demandMap) => {
  let out = Object.assign({}, demandMap);
  Object.keys(PREP_LOOKAHEAD_EXCLUDED_ITEMS_).forEach((pName) => {
    delete out[pName];
  });
  return out;
};

const isMeatSashiItem_ = (itemName) => {
  return PREP_LOT_EXPIRY_RULES_[itemName] === "meat_sashi";
};

/**
 * 仕込みロットの消費期限・自動廃棄チェック
 * （日次仕込み在庫スライド計算 precomputeDailyDemands 内で呼び出す）
 *
 * @param {string} itemName - 仕込み品名（例: "カットタン刺し" / "カットレバー"）
 * @param {string} dateOpenedStr - そのパックを開封（仕込み）した日付 (yyyy-MM-dd)
 * @param {string} currentDateStr - シミュレーション上の今日の日付 (yyyy-MM-dd)
 * @return {boolean} - 期限切れ（廃棄）なら true、まだ使えるなら false
 */
const isPrepLotExpired_ = (itemName, dateOpenedStr, currentDateStr) => {
  let ruleType = PREP_LOT_EXPIRY_RULES_[itemName];
  if (!ruleType) return false;
  if (!dateOpenedStr || !currentDateStr) return false;

  let diffDays = diffCalendarDaysJst_(dateOpenedStr, currentDateStr);

  if (ruleType === "same_day") {
    // 仕込み当日のみ使用可 → 翌日には持ち越さず廃棄
    return diffDays >= 1;
  }

  if (ruleType === "next_day") {
    // 仕込み日+翌日まで使用可 → 2日目で廃棄
    return diffDays >= 2;
  }

  let openedDay = new Date(dateOpenedStr + "T12:00:00").getDay();
  if (openedDay === 5) {
    // 金曜仕込み: 土・日・月の3日間使用可 → 4日目（火曜）で廃棄
    return diffDays >= 4;
  }
  // 通常: 翌日・翌々日の2日間 → 3日目で廃棄
  return diffDays >= 3;
};

/** @deprecated isPrepLotExpired_ の別名（肉刺し向け呼び出し互換） */
const isMeatSashiExpired = (itemName, dateOpenedStr, currentDateStr) => {
  return isPrepLotExpired_(itemName, dateOpenedStr, currentDateStr);
};

const diffCalendarDaysJst_ = (fromStr, toStr) => {
  let from = new Date(fromStr + "T12:00:00").getTime();
  let to = new Date(toStr + "T12:00:00").getTime();
  return Math.round((to - from) / 86400000);
};

/** 棚卸し・当日仕込みから仕込みロット在庫を初期化 */
const initPrepLotInventory_ = (ctx) => {
  let lots = {};
  let openDate = ctx.inventoryDateStr || ctx.targetDatesStr[0];

  getAllPrepItemNames_(ctx).forEach((pName) => {
    lots[pName] = [];
    let stock = ctx.prepStockObj && ctx.prepStockObj[pName];
    if (!stock) return;

    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;

    let stockQty = convertPrepStockToProcessQty_(stock, prep, pName, ctx);
    if (stockQty <= 0) return;

    let packSize = Number(prep.finishedQty) || 1;
    let packs = stockQty / packSize;
    if (packs <= 0) return;

    lots[pName].push({ packs: packs, dateOpened: openDate });
  });

  return lots;
};

/** 期限切れロットを廃棄し、廃棄した仕込み品量（仕込み単位）を返す */
const purgeExpiredPrepLots_ = (lots, currentDateStr, ctx) => {
  let wastePrepQty = {};
  getAllPrepItemNames_(ctx).forEach((pName) => {
    if (!lots[pName] || lots[pName].length === 0) return;

    let prep = ctx && ctx.preparationRecipes ? ctx.preparationRecipes[pName] : null;
    let packSize = prep ? (Number(prep.finishedQty) || 1) : 1;
    let before = lots[pName].reduce((sum, lot) => { return sum + lot.packs; }, 0);

    lots[pName].forEach((lot) => {
      if (!isPrepLotExpired_(pName, lot.dateOpened, currentDateStr)) return;
      let wasted = lot.packs * packSize;
      if (wasted > 1e-9) {
        wastePrepQty[pName] = (wastePrepQty[pName] || 0) + wasted;
      }
    });

    lots[pName] = lots[pName].filter((lot) => {
      return !isPrepLotExpired_(pName, lot.dateOpened, currentDateStr);
    });
    let after = lots[pName].reduce((sum, lot) => { return sum + lot.packs; }, 0);

    if (before > after + 1e-9) {
      Logger.log(`[仕込み期限廃棄] ${currentDateStr} ${pName} ${(before - after).toFixed(2)}ロット`);
    }
  });
  return wastePrepQty;
};

/** FIFOでロット在庫を消費し、仕込み需要を控除 */
const reducePrepLotDemandByLots_ = (prepDemand, lots, ctx) => {
  getAllPrepItemNames_(ctx).forEach((pName) => {
    let demand = prepDemand[pName];
    if (!demand || demand <= 0) return;

    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;

    let itemLots = lots[pName];
    if (!itemLots || itemLots.length === 0) return;

    let packSize = Number(prep.finishedQty) || 1;
    let consumed = consumePrepLotsFifo_(itemLots, demand, packSize);
    lots[pName] = itemLots.filter((lot) => { return lot.packs > 1e-9; });
    prepDemand[pName] = Math.max(0, demand - consumed);
  });
};

const consumePrepLotsFifo_ = (itemLots, qty, packSize) => {
  let remaining = qty;
  for (let i = 0; i < itemLots.length && remaining > 1e-9; i++) {
    let lot = itemLots[i];
    if (lot.packs <= 1e-9) continue;

    let lotQty = lot.packs * packSize;
    if (lotQty <= remaining + 1e-9) {
      remaining -= lotQty;
      lot.packs = 0;
    } else {
      lot.packs -= remaining / packSize;
      if (lot.packs < 1e-9) lot.packs = 0;
      remaining = 0;
    }
  }
  return qty - remaining;
};

/** 仕込み確定前のロット管理品需要残（ロット切上げ前の量）を退避 */
const snapshotPrepLotDemand_ = (prepDemand, ctx) => {
  let snap = {};
  getAllPrepItemNames_(ctx).forEach((pName) => {
    let demand = prepDemand[pName];
    if (demand && demand > 0) snap[pName] = demand;
  });
  return snap;
};

/**
 * 当日仕込みをロット在庫へ登録し、需要分だけ消費（切上げ余りは翌日繰越）
 */
const applyPrepLotsAfterFinalize_ = (lots, inProcess, remainderByItem, dateStr, ctx) => {
  getAllPrepItemNames_(ctx).forEach((pName) => {
    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;

    let item = inProcess && inProcess[pName];
    if (item && item.lotCount > 0) {
      if (!lots[pName]) lots[pName] = [];
      lots[pName].push({ packs: item.lotCount, dateOpened: dateStr });
    }

    let remainder = remainderByItem[pName];
    if (!remainder || remainder <= 0) return;

    let packSize = Number(prep.finishedQty) || 1;
    let itemLots = lots[pName];
    if (!itemLots || itemLots.length === 0) return;

    consumePrepLotsFifo_(itemLots, remainder, packSize);
    lots[pName] = itemLots.filter((lot) => { return lot.packs > 1e-9; });
  });
};

const executeCoreSimulation = (ctx) => {
  let dailyTotalBufferedAmounts = [];
  let backlogRows = [];

  for (let d = 0; d < ctx.simDays; d++) {
    dailyTotalBufferedAmounts.push({});
  }

  // --- 日次1ループ: 売上予測 → 仕込み確定 → 原材料消費 → 在庫反映 → 発注 ---
  let currentStock = {};
  Object.keys(ctx.rawMaster).forEach(rName => {
    let rawRow = ctx.rawMaster[rName];
    let stockEntry = ctx.stockObj[rName];
    let initialQty = stockEntry ? stockEntry.qty : 0;
    let initialUnit = stockEntry ? stockEntry.unit : (rawRow.orderUnit || rawRow.lotUnit || "個");
    currentStock[rName] = convertToMinUnit(initialQty, initialUnit, rawRow);
  });

  let simulationResults = [];
  let rawNames = Object.keys(ctx.rawMaster).filter((rName) => {
    return !shouldSkipRawAutoOrder_(ctx.rawMaster[rName], rName);
  });
  let holidayCache = {};
  preWarmHolidayCache_(ctx, holidayCache);
  precomputeVendorDeliveryCaches_(ctx, holidayCache);

  let simPhaseMs = Date.now();
  let demandCache = buildDemandCache_(ctx);
  let dailyDemands = demandCache.days;
  Logger.log(`[sim] 需要キャッシュ ${Date.now() - simPhaseMs}ms`);
  simPhaseMs = Date.now();
  let precomputedConsumption = dailyDemands.map((day) => { return day.rawConsumption; });
  let consumptionPrefixSums = buildConsumptionPrefixSums_(precomputedConsumption, rawNames);
  let activeRawNames = filterActiveRawNamesForOrder_(rawNames, ctx, currentStock, consumptionPrefixSums);
  let orderDayIdx = getOrderDayIndexInCtx_(ctx);
  let inventoryPriorMode = isInventoryExactlyPriorDay_(ctx);

  for (let d = 0; d < ctx.simDays; d++) {
    let dateStr = ctx.targetDatesStr[d];
    let dayDemand = dailyDemands[d];
    let baseFlag = dayDemand.baseFlag;
    let inProcess = dayDemand.inProcess;
    let todayConsumption = dayDemand.rawConsumption;
    let inventoryStockSnapshot = null;

    if (inventoryPriorMode && d === orderDayIdx) {
      currentStock = buildRawStockFromInventorySheet_(ctx);
      inventoryStockSnapshot = Object.assign({}, currentStock);
    }

    let todayResults = {
      date: dateStr,
      baseFlag: baseFlag,
      inProcess: inProcess,
      orders: {},
      foodCostRatio: dayDemand.foodCostRatio != null
        ? dayDemand.foodCostRatio
        : calcFoodCostRatio_(
          dayDemand.rawOutputDemand,
          ctx.rawMaster,
          ctx.budgetActualData[dateStr]
        )
    };

    let todayIncoming = dailyTotalBufferedAmounts[d] || {};
    let skipIncomingForInventoryPrior = inventoryPriorMode && d === orderDayIdx;
    if (!skipIncomingForInventoryPrior) {
      Object.keys(todayIncoming).forEach(rName => {
        currentStock[rName] = (currentStock[rName] || 0) + todayIncoming[rName];
      });
    }

    Object.keys(todayConsumption).forEach(rName => {
      if (ctx.rawMaster[rName]) {
        currentStock[rName] = (currentStock[rName] || 0) - todayConsumption[rName];
      }
    });

    let orderOptions = {};
    if (inventoryPriorMode && d === orderDayIdx) {
      orderOptions.skipDeliveryBuffered = true;
    }

    for (let ri = 0; ri < activeRawNames.length; ri++) {
      let rName = activeRawNames[ri];
      let rawRow = ctx.rawMaster[rName];
      let stockVal = inventoryStockSnapshot
        ? (inventoryStockSnapshot[rName] || 0)
        : Math.max(0, currentStock[rName] || 0);

      let orderPlan = calcForwardLookingOrderQty(
        rName, rawRow, d, stockVal, ctx, dailyTotalBufferedAmounts, precomputedConsumption,
        holidayCache, consumptionPrefixSums, orderOptions
      );
      if (!orderPlan || orderPlan.skipped || orderPlan.aiQty <= 0) {
        continue;
      }

      todayResults.orders[rName] = {
        aiQty: orderPlan.aiQty,
        unit: orderPlan.unit,
        vendor: orderPlan.vendor,
        reason: orderPlan.reason,
        deliveryDayIdx: orderPlan.deliveryDayIdx
      };
    }

    let lot14Options = {};
    if (inventoryPriorMode && d === orderDayIdx) {
      lot14Options.skipDeliveryBuffered = true;
    }
    applyVendor14KgLotRule(
      todayResults.orders, ctx, d, currentStock,
      dailyTotalBufferedAmounts, precomputedConsumption, holidayCache, lot14Options
    );

    if (d === orderDayIdx) {
      Object.keys(todayResults.orders).forEach((rName) => {
        if (!isDebugShiodareOrderTarget_(rName)) return;
        trackDebugShiodareFinal_(dateStr, rName, todayResults.orders[rName], ctx.rawMaster[rName]);
      });
    }

    Object.keys(todayResults.orders).forEach((rName) => {
      let item = todayResults.orders[rName];
      if (!item || item.aiQty <= 0) return;
      let deliveryDayIdx = item.deliveryDayIdx;
      if (deliveryDayIdx === d) {
        currentStock[rName] = (currentStock[rName] || 0) + item.aiQty;
      } else if (deliveryDayIdx !== undefined && deliveryDayIdx < ctx.simDays) {
        dailyTotalBufferedAmounts[deliveryDayIdx][rName] =
          (dailyTotalBufferedAmounts[deliveryDayIdx][rName] || 0) + item.aiQty;
      }
    });

    simulationResults.push(todayResults);

    Object.keys(todayResults.orders).forEach((rName) => {
      let item = todayResults.orders[rName];
      let display = formatOrderSheetOrderQty_(item.aiQty, ctx.rawMaster[rName], rName);
      backlogRows.push([dateStr, rName, "発注", display.qty, 0, 0, display.aiQty, display.qty, baseFlag]);
    });

    Object.keys(todayResults.inProcess).forEach(pName => {
      let item = todayResults.inProcess[pName];
      backlogRows.push([dateStr, pName, "仕込み", item.aiQty, 0, 0, item.aiQty, item.aiQty, baseFlag]);
    });
  }

  Logger.log(`[sim] 発注判定 ${Date.now() - simPhaseMs}ms`);
  simPhaseMs = Date.now();
  writeBacklogMergedOnce(ctx, backlogRows);
  writeForecastDemandLog_(ctx, demandCache);
  Logger.log(`[sim] 書込 ${Date.now() - simPhaseMs}ms`);

  let orderDateStr = ctx.orderDate ? formatJstDate_(ctx.orderDate) : ctx.targetDatesStr[0];
  let orderIdx = ctx.orderDate
    ? clampDayIndex_(getOrderSheetDayIndex(ctx.orderDate, ctx.periodMode || "当日", ctx.targetDate), ctx.simDays)
    : 0;
  let orderBa = getBA(ctx.budgetActualData, new Date(orderDateStr));
  let orderSalesBase = resolveDailySalesBase_(orderBa, ctx.salesBiasCoefficient);
  let orderBase = orderSalesBase.amount;
  let orderDay = simulationResults[orderIdx] || { inProcess: {} };
  Logger.log(`[sim] 期間=${ctx.periodMode || "当日"} 範囲=${ctx.targetDatesStr[0]}〜${ctx.targetDatesStr[ctx.simDays - 1]} 指示書日=${orderDateStr} 売上=${orderBase} 仕込み品数=${Object.keys(orderDay.inProcess || {}).length}`);

  return simulationResults;
};

const calcTotalRevenue = (posCleanData) => {
  return (posCleanData || []).reduce((sum, r) => {
    return sum + (Number(r.salesAmount) || 0);
  }, 0);
};

const calcTotalSalesQty = (posCleanData) => {
  return (posCleanData || []).reduce((sum, r) => {
    return sum + (Number(r.salesQty) || 0);
  }, 0);
};

/**
 * 予測販売点数 = (販売点数 ÷ 総売上) × 売上予算/実績
 * POS整形後は期間合計（例: 3ヶ月ぶんの 個×日数 / 円×日数）のため、日数で割らない。
 * 純売上・予算/実績はいずれも税抜（POS生データの税込は読込/整形時に変換済み）。
 * - 純売上あり: (販売点数 / 純売上合計) × 売上基準
 * - 純売上なし: (販売点数 / 販売点数合計) × (売上基準 ÷ 客単価)
 */
const calcPredictedMenuSales = (posRow, ctx, baseAmount) => {
  if (!baseAmount || baseAmount <= 0 || !ctx.posCleanData || ctx.posCleanData.length === 0) return 0;

  let salesQty = Number(posRow.salesQty) || 0;
  if (salesQty <= 0) return 0;

  let totalRevenue = ctx.posTotalRevenue != null ? ctx.posTotalRevenue : calcTotalRevenue(ctx.posCleanData);
  if (totalRevenue > 0) {
    return (salesQty / totalRevenue) * baseAmount;
  }

  let totalQty = ctx.posTotalSalesQty != null ? ctx.posTotalSalesQty : calcTotalSalesQty(ctx.posCleanData);
  let avgSpend = ctx.averageSpend || 4000;
  if (totalQty > 0 && avgSpend > 0) {
    return (salesQty / totalQty) * (baseAmount / avgSpend);
  }
  return 0;
};

/**
 * レシピ参照: 消費量>0 の材料を中間レシピ or 原材料マスタへ振り分け
 */
const expandMenuToDemands = (menuName, predictedQty, ctx, prepDemand, rawDemand) => {
  let recipe = ctx.recipeMaster[menuName];
  if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) return;

  recipe.ingredients.forEach((ing) => {
    let need = ing.qty * predictedQty;
    if (need <= 0) return;

    let target = routeUnifiedMaterial_(ing.name, ctx);
    if (target.kind === "prep") {
      prepDemand[target.name] = (prepDemand[target.name] || 0) + need;
    } else if (target.kind === "raw") {
      if (Number(ctx.rawMaster[target.name].stopFlag) === 1) return;
      rawDemand[target.name] = (rawDemand[target.name] || 0) + need;
    }
  });
};

/**
 * 仕込み需要量 → ロット切上げ → 仕込み量(= 仕込みロット × ロット数) を確定
 */
const finalizePrepInstructions = (prepDemand, ctx) => {
  let inProcess = {};
  Object.keys(prepDemand).forEach((pName) => {
    let demand = prepDemand[pName];
    if (demand <= 0) return;
    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;
    if (Number(prep.stopFlag) === 1) return; // 停止フラグ=1の仕込みは指示しない

    let lotSize = Number(prep.finishedQty) || 1;
    let calc = calcPrepLotAndAmount(demand, lotSize);
    if (calc.lotCount > 0) {
      inProcess[pName] = {
        aiQty: calc.prepAmount,
        lotCount: calc.lotCount,
        unit: prep.processUnit || "g",
        demand: demand
      };
    }
  });
  return inProcess;
};

/**
 * 確定済み仕込みロットからネストした仕込み品の指示を追加
 */
const MAX_NESTED_PREP_ITERATIONS = 50;

const collectNestedPrepInstructions = (inProcess, ctx) => {
  let changed = true;
  let iterations = 0;
  while (changed) {
    if (++iterations > MAX_NESTED_PREP_ITERATIONS) {
      Logger.log(`[警告] 中間レシピのネスト展開が上限(${MAX_NESTED_PREP_ITERATIONS}回)を超えました。循環参照の可能性があります。`);
      break;
    }
    changed = false;
    Object.keys(inProcess).slice().forEach((pName) => {
      let prep = ctx.preparationRecipes[pName];
      if (!prep) return;
      if (Number(prep.stopFlag) === 1) return; // 停止仕込みから先は分解しない
      let parentLots = inProcess[pName].lotCount;

      prep.ingredients.forEach((ing) => {
        let nestedPrep = ctx.preparationRecipes[ing.name];
        if (!nestedPrep) return;
        if (Number(nestedPrep.stopFlag) === 1) return; // 停止仕込みは追加しない
        let need = ing.qty * parentLots;
        if (need <= 0) return;
        // 子仕込みの単位で必要量を評価しないと、少量でも1ロット過大に切り上がる。
        let nestedNeed = prepIngredientQtyToFinishedQty_(need, ing.unit, nestedPrep, ing.name, ctx);
        if (!(nestedNeed > 0)) return;

        let lotSize = Number(nestedPrep.finishedQty) || 1;
        let calc = calcPrepLotAndAmount(nestedNeed, lotSize);
        if (calc.lotCount <= 0) return;

        if (!inProcess[ing.name] || inProcess[ing.name].lotCount < calc.lotCount) {
          inProcess[ing.name] = {
            aiQty: calc.prepAmount,
            lotCount: calc.lotCount,
            unit: nestedPrep.processUnit || "g",
            demand: nestedNeed
          };
          changed = true;
        }
      });
    });
  }
};

/**
 * メニュー起点の仕込み需要のみ原材料へ展開（inProcess 全件ループによる二重計上を避ける）
 */
const expandPrepsToRaw = (prepDemand, inProcess, ctx, rawConsumption) => {
  Object.keys(inProcess || {}).forEach((pName) => {
    expandPrepLotsToRaw(pName, inProcess[pName].lotCount, ctx, rawConsumption, inProcess, []);
  });
};

const expandPrepLotsToRaw = (pName, prepLotCount, ctx, rawConsumption, inProcess, pathStack) => {
  expandPrepToRawMinQty_(pName, prepLotCount, ctx, rawConsumption, pathStack || [], {
    nestedMode: "lotCount",
    inProcess: inProcess
  });
};

/**
 * 原価率用: 仕込み需要を理論量で原材料最小単位へ展開
 * @param {object} [options] skipYield=true … 提供品（メニュー出数）用。歩留まりロスは仕込み指示側で別計上
 */
const finalizeCostRawDemandFromScaled_ = (ctx, prepDemand, directRawDemand, options) => {
  options = options || {};
  let prepRawMinQty = {};

  Object.keys(prepDemand).forEach((pName) => {
    let demand = prepDemand[pName];
    if (demand <= 0) return;
    let prep = ctx.preparationRecipes[pName];
    if (!prep || Number(prep.stopFlag) === 1) return;

    let lotSize = Number(prep.finishedQty) || 1;
    let multiplier = demand / lotSize;
    expandPrepToRawMinQty_(pName, multiplier, ctx, prepRawMinQty, [], {
      nestedMode: "fractional",
      skipYield: options.skipYield === true
    });
  });

  let rawMinQty = Object.assign({}, directRawDemand);
  Object.keys(prepRawMinQty).forEach((rName) => {
    rawMinQty[rName] = (rawMinQty[rName] || 0) + prepRawMinQty[rName];
  });
  return rawMinQty;
};

/** 複数の原材料最小単位マップを合算 */
const mergeRawDemandMaps_ = (...maps) => {
  let out = {};
  for (let i = 0; i < maps.length; i++) {
    let map = maps[i];
    if (!map) continue;
    Object.keys(map).forEach((rName) => {
      let qty = Number(map[rName]) || 0;
      if (qty <= 0) return;
      out[rName] = (out[rName] || 0) + qty;
    });
  }
  return out;
};

/** 仕込み1ロットあたりの歩留まりロス（原材料最小単位）を事前計算 */
const precomputeUnitPrepYieldLossRaw_ = (ctx) => {
  let unit = {};
  Object.keys(ctx.preparationRecipes || {}).forEach((pName) => {
    let prep = ctx.preparationRecipes[pName];
    if (!prep || Number(prep.stopFlag) === 1) return;
    if (resolveYieldRate_(pName, ctx) >= 1) return;

    let delta = {};
    accumulatePrepYieldLossRaw_(pName, 1, ctx, delta, [], { nestedMode: "lotCount" });
    if (Object.keys(delta).length > 0) unit[pName] = delta;
  });
  return unit;
};

/** 仕込み1ロット分の廃棄原材料換算を事前計算（期限管理品のみ） */
const precomputeUnitPrepWasteRaw_ = (ctx) => {
  let unit = {};
  Object.keys(PREP_LOT_EXPIRY_RULES_).forEach((pName) => {
    let prep = ctx.preparationRecipes[pName];
    if (!prep || Number(prep.stopFlag) === 1) return;

    let raw = {};
    expandPrepToRawMinQty_(pName, 1, ctx, raw, [], { nestedMode: "fractional" });
    if (Object.keys(raw).length > 0) unit[pName] = raw;
  });
  return unit;
};

/** 廃棄仕込み量を原材料最小単位へ（単位キャッシュで倍率適用） */
const calcPrepFinishedWasteToRaw_ = (ctx, wastePrepQty, unitPrepWasteRaw) => {
  unitPrepWasteRaw = unitPrepWasteRaw || ctx._unitPrepWasteRaw || precomputeUnitPrepWasteRaw_(ctx);
  let raw = {};
  Object.keys(wastePrepQty || {}).forEach((pName) => {
    let wasted = Number(wastePrepQty[pName]) || 0;
    if (wasted <= 0) return;
    let unit = unitPrepWasteRaw[pName];
    if (!unit) return;

    let prep = ctx.preparationRecipes[pName];
    if (!prep) return;
    let lotSize = Number(prep.finishedQty) || 1;
    let factor = wasted / lotSize;
    Object.keys(unit).forEach((rName) => {
      raw[rName] = (raw[rName] || 0) + unit[rName] * factor;
    });
  });
  return raw;
};

/**
 * 当日の仕込み指示に伴う歩留まりロス（単位キャッシュ × ロット数）
 */
const calcPrepInstructionYieldLossRaw_ = (ctx, inProcess, unitYieldLoss) => {
  unitYieldLoss = unitYieldLoss || ctx._unitPrepYieldLossRaw || precomputeUnitPrepYieldLossRaw_(ctx);
  let out = {};
  Object.keys(inProcess || {}).forEach((pName) => {
    let item = inProcess[pName];
    let unit = unitYieldLoss[pName];
    if (!item || item.lotCount <= 0 || !unit) return;

    Object.keys(unit).forEach((rName) => {
      out[rName] = (out[rName] || 0) + unit[rName] * item.lotCount;
    });
  });
  return out;
};

/**
 * 1日分の需要計算（直消費 / 仕込み展開消費を分離）
 */
const scaleDemandMap_ = (src, factor) => {
  let out = {};
  if (!factor) return out;
  Object.keys(src).forEach((k) => {
    let scaled = src[k] * factor;
    if (scaled > 0) out[k] = scaled;
  });
  return out;
};

/** 売上1円あたりのメニュー需要（POS×レシピ展開）を1回だけ計算 */
const computeUnitMenuDemands_ = (ctx) => {
  let prepDemand = {};
  let directRawDemand = {};
  if (!ctx.posCleanData || ctx.posCleanData.length === 0) {
    return { prepDemand: prepDemand, directRawDemand: directRawDemand };
  }
  ctx.posCleanData.forEach((posRow) => {
    let predictedMenuSales = calcPredictedMenuSales(posRow, ctx, 1);
    if (predictedMenuSales > 0) {
      expandMenuToDemands(posRow.menuName, predictedMenuSales, ctx, prepDemand, directRawDemand);
    }
  });
  return { prepDemand: prepDemand, directRawDemand: directRawDemand };
};

/** 実績出数（当日実際の商品別販売点数）をレシピ展開。比率換算せず実数量をそのまま使う */
const expandActualDayDemands_ = (ctx, actualRows) => {
  let prepDemand = {};
  let directRawDemand = {};
  (actualRows || []).forEach((row) => {
    let qty = Number(row.salesQty) || 0;
    if (qty > 0) {
      expandMenuToDemands(row.menuName, qty, ctx, prepDemand, directRawDemand);
    }
  });
  return { prepDemand: prepDemand, directRawDemand: directRawDemand };
};

const finalizeDailyDemandsFromScaled_ = (ctx, prepDemand, directRawDemand) => {
  let inProcess = finalizePrepInstructions(prepDemand, ctx);
  collectNestedPrepInstructions(inProcess, ctx);

  let prepRawConsumption = {};
  expandPrepsToRaw(prepDemand, inProcess, ctx, prepRawConsumption);

  let rawConsumption = Object.assign({}, directRawDemand);
  Object.keys(prepRawConsumption).forEach((rName) => {
    rawConsumption[rName] = (rawConsumption[rName] || 0) + prepRawConsumption[rName];
  });

  return {
    inProcess: inProcess,
    rawConsumption: rawConsumption,
    prepRawConsumption: prepRawConsumption,
    directRawConsumption: Object.assign({}, directRawDemand)
  };
};

const computeDailyDemandsDetailed = (ctx, baseAmount, dayIdx) => {
  let prepDemand = {};
  let directRawDemand = {};

  if (baseAmount > 0 && ctx.posCleanData && ctx.posCleanData.length > 0) {
    ctx.posCleanData.forEach((posRow) => {
      let predictedMenuSales = calcPredictedMenuSales(posRow, ctx, baseAmount);
      if (predictedMenuSales > 0) {
        expandMenuToDemands(posRow.menuName, predictedMenuSales, ctx, prepDemand, directRawDemand);
      }
    });
  }

  if (dayIdx === 0) {
    reducePrepDemandByStock_(prepDemand, ctx);
  }

  let inProcess = finalizePrepInstructions(prepDemand, ctx);
  collectNestedPrepInstructions(inProcess, ctx);

  let prepRawConsumption = {};
  expandPrepsToRaw(prepDemand, inProcess, ctx, prepRawConsumption);

  let rawConsumption = Object.assign({}, directRawDemand);
  Object.keys(prepRawConsumption).forEach((rName) => {
    rawConsumption[rName] = (rawConsumption[rName] || 0) + prepRawConsumption[rName];
  });

  return {
    prepDemand: prepDemand,
    inProcess: inProcess,
    directRawConsumption: directRawDemand,
    prepRawConsumption: prepRawConsumption,
    rawConsumption: rawConsumption
  };
};

/** 発注判定が必要な原材料に絞る（消費ゼロ・在庫ゼロ・最低在庫ゼロはスキップ） */
const filterActiveRawNamesForOrder_ = (rawNames, ctx, initialStock, consumptionPrefixSums) => {
  return rawNames.filter((rName) => {
    let rawRow = ctx.rawMaster[rName];
    if ((Number(rawRow.minStock) || 0) > 0) return true;
    if ((initialStock[rName] || 0) > 1e-9) return true;
    let sums = consumptionPrefixSums[rName];
    return sums && sums[sums.length - 1] > 1e-9;
  });
};

/** 売上1円あたりの原材料最小単位需要（メニュー出数・歩留まりロス除く） */
const precomputeUnitCostRawDemand_ = (ctx, unitMenuDemands) => {
  let unit = unitMenuDemands || computeUnitMenuDemands_(ctx);
  return finalizeCostRawDemandFromScaled_(ctx, unit.prepDemand, unit.directRawDemand, { skipYield: true });
};

/**
 * 予測出数キャッシュ（1回のシミュレーション内で発注・仕込み・原価率が共有するDB）
 *
 * Layer0 unitMenuDemands … POS×レシピを売上1円分だけ展開（最重い処理・1回のみ）
 * Layer1 日次 scaled prep/direct … 売上倍率を掛けた共通上流
 * Layer2a rawOutputDemand … メニュー出数＋仕込み歩留まりロス＋廃棄（日次原価率用）
 * Layer2b rawConsumption / inProcess … ロット切上げ・在庫控除後（発注・在庫用）
 */
const buildDemandCache_ = (ctx) => {
  let unitMenuDemands = computeUnitMenuDemands_(ctx);
  let unitCostRawDemand = precomputeUnitCostRawDemand_(ctx, unitMenuDemands);
  let unitPrepYieldLossRaw = precomputeUnitPrepYieldLossRaw_(ctx);
  let unitPrepWasteRaw = precomputeUnitPrepWasteRaw_(ctx);
  ctx._unitPrepYieldLossRaw = unitPrepYieldLossRaw;
  ctx._unitPrepWasteRaw = unitPrepWasteRaw;
  let days = precomputeDailyDemands(
    ctx, unitMenuDemands, unitCostRawDemand, unitPrepYieldLossRaw, unitPrepWasteRaw
  );
  return {
    unitMenuDemands: unitMenuDemands,
    unitCostRawDemand: unitCostRawDemand,
    unitPrepYieldLossRaw: unitPrepYieldLossRaw,
    unitPrepWasteRaw: unitPrepWasteRaw,
    days: days
  };
};

/** シミュレーション全日の需要を事前計算（POS×レシピ展開は売上1円分のみ、日次は倍率適用） */
const precomputeDailyDemands = (ctx, unitMenuDemands, unitCostRawDemand, unitPrepYieldLossRaw, unitPrepWasteRaw) => {
  let unit = unitMenuDemands || computeUnitMenuDemands_(ctx);
  let unitCostRaw = unitCostRawDemand || precomputeUnitCostRawDemand_(ctx, unit);
  let yieldLossUnit = unitPrepYieldLossRaw || ctx._unitPrepYieldLossRaw || precomputeUnitPrepYieldLossRaw_(ctx);
  let wasteUnit = unitPrepWasteRaw || ctx._unitPrepWasteRaw || precomputeUnitPrepWasteRaw_(ctx);
  let byDay = [];
  let prepLots = initPrepLotInventory_(ctx);

  for (let d = 0; d < ctx.simDays; d++) {
    let dateStr = ctx.targetDatesStr[d];
    let salesBase = resolveDailySalesBase_(ctx.budgetActualData[dateStr], ctx.salesBiasCoefficient);
    let factor = salesBase.amount || 0;
    let lookaheadAmount = resolveNextDayPrepLookaheadAmount_(ctx, d);
    let actualRows = ctx.actualSalesLogData && ctx.actualSalesLogData[dateStr];
    let usedActual = actualRows && actualRows.length > 0;

    let prepDemand, directRawDemand, menuRawDemand;
    if (usedActual) {
      // 実績出数がある日（今日を含む過去日）は比率予測ではなく実際の商品別出数をそのまま展開する
      let actualExpanded = expandActualDayDemands_(ctx, actualRows);
      let lookaheadPrepDemand = stripExcludedLookaheadItems_(scaleDemandMap_(unit.prepDemand, lookaheadAmount));
      prepDemand = mergeRawDemandMaps_(actualExpanded.prepDemand, lookaheadPrepDemand);
      directRawDemand = actualExpanded.directRawDemand;
      menuRawDemand = finalizeCostRawDemandFromScaled_(
        ctx, actualExpanded.prepDemand, actualExpanded.directRawDemand, { skipYield: true }
      );
    } else {
      let lookaheadPrepDemand = stripExcludedLookaheadItems_(scaleDemandMap_(unit.prepDemand, lookaheadAmount));
      prepDemand = mergeRawDemandMaps_(scaleDemandMap_(unit.prepDemand, factor), lookaheadPrepDemand);
      directRawDemand = scaleDemandMap_(unit.directRawDemand, factor);
      menuRawDemand = factor > 0 ? scaleDemandMap_(unitCostRaw, factor) : {};
    }

    let wastePrepQty = purgeExpiredPrepLots_(prepLots, dateStr, ctx);
    reducePrepLotDemandByLots_(prepDemand, prepLots, ctx);

    let prepLotRemainder = snapshotPrepLotDemand_(prepDemand, ctx);

    let finalized = finalizeDailyDemandsFromScaled_(ctx, prepDemand, directRawDemand);
    applyPrepLotsAfterFinalize_(prepLots, finalized.inProcess, prepLotRemainder, dateStr, ctx);

    let prepYieldLossRawDemand = calcPrepInstructionYieldLossRaw_(ctx, finalized.inProcess, yieldLossUnit);
    let wasteRawDemand = calcPrepFinishedWasteToRaw_(ctx, wastePrepQty, wasteUnit);
    let rawOutputDemand = mergeRawDemandMaps_(menuRawDemand, prepYieldLossRawDemand, wasteRawDemand);
    let foodCostRatio = calcFoodCostRatioFromAmounts_(
      calcDailyRawMaterialCost_(rawOutputDemand, ctx.rawMaster),
      factor
    );

    let baseFlag = usedActual ? "実績出数ベース" : salesBase.baseFlag;

    trackDebugShiodareDailyDemand_(ctx, {
      date: dateStr,
      dayIdx: d,
      salesAmount: factor,
      salesFactor: factor,
      prepFactor: factor + lookaheadAmount,
      baseFlag: baseFlag,
      prepDemand: prepDemand,
      inProcess: finalized.inProcess,
      directRawConsumption: finalized.directRawConsumption,
      prepRawConsumption: finalized.prepRawConsumption,
      rawConsumption: finalized.rawConsumption
    });

    byDay.push({
      date: dateStr,
      baseFlag: baseFlag,
      salesAmount: factor,
      menuRawDemand: menuRawDemand,
      prepYieldLossRawDemand: prepYieldLossRawDemand,
      wasteRawDemand: wasteRawDemand,
      foodCostRatio: foodCostRatio,
      inProcess: finalized.inProcess,
      rawConsumption: finalized.rawConsumption,
      rawOutputDemand: rawOutputDemand
    });
  }
  return byDay;
};

const buildConsumptionPrefixSums_ = (precomputed, rawNames) => {
  let sums = {};
  rawNames.forEach((rName) => {
    let arr = [0];
    for (let d = 0; d < precomputed.length; d++) {
      arr.push(arr[d] + (precomputed[d][rName] || 0));
    }
    sums[rName] = arr;
  });
  return sums;
};

const preWarmHolidayCache_ = (ctx, holidayCache) => {
  try {
    ensureJapaneseHolidayCacheFresh_();
  } catch (e) {
    Logger.log(`[警告] 祝日キャッシュの更新に失敗、都度取得にフォールバック: ${e.message}`);
  }
  (ctx.targetDatesStr || []).forEach((dateStr) => {
    isJapanesePublicHolidayCached(new Date(dateStr + "T12:00:00"), holidayCache);
  });
};

/** 日次消費予測の区間合計 [fromDayIdx, toDayIdxExclusive) */
const sumRawConsumptionRange = (precomputed, rName, fromDayIdx, toDayIdxExclusive, prefixSums) => {
  if (prefixSums && prefixSums[rName]) {
    let arr = prefixSums[rName];
    let from = Math.max(0, fromDayIdx);
    let to = Math.min(toDayIdxExclusive, arr.length - 1);
    if (to <= from) return 0;
    return arr[to] - arr[from];
  }
  let total = 0;
  for (let d = fromDayIdx; d < toDayIdxExclusive && d < precomputed.length; d++) {
    total += precomputed[d][rName] || 0;
  }
  return total;
};

/**
 * 既存入荷予定を反映しつつ fromDayIdx 終了時点の在庫から toDayIdx 終了時点まで投影
 * （各日: 入荷加算 → 消費減算、シミュレーション本体と同順）
 * 帳簿マイナスは現場在庫0として扱う（過剰発注防止）
 */
const projectRawStockAtDay = (precomputed, dailyBuffered, rName, fromDayIdx, toDayIdx, startStock, skipDeliveryBuffered) => {
  let stock = Math.max(0, Number(startStock) || 0);
  for (let d = fromDayIdx + 1; d <= toDayIdx; d++) {
    if (!skipDeliveryBuffered && dailyBuffered[d] && dailyBuffered[d][rName]) {
      stock += dailyBuffered[d][rName];
    }
    stock -= precomputed[d][rName] || 0;
    if (stock < 0) stock = 0;
  }
  return stock;
};

/**
 * 納品日の朝時点の見込在庫（入荷反映後・当日消費前）。
 * カバー期間が「納品日〜翌納品前」なので、在庫は納品日の消費前で見る。
 * これにより前日発注分の入荷予定を正しく差し引き、到着前日の二重発注を防ぐ。
 */
const projectRawStockAtDeliveryStart_ = (
  precomputed, dailyBuffered, rName, fromDayIdx, deliveryDayIdx, startStock, skipDeliveryBuffered
) => {
  if (deliveryDayIdx <= fromDayIdx) {
    let stock = Math.max(0, Number(startStock) || 0);
    if (!skipDeliveryBuffered && dailyBuffered[deliveryDayIdx] && dailyBuffered[deliveryDayIdx][rName]) {
      stock += dailyBuffered[deliveryDayIdx][rName];
    }
    return stock;
  }
  let stock = projectRawStockAtDay(
    precomputed, dailyBuffered, rName, fromDayIdx, deliveryDayIdx - 1, startStock, skipDeliveryBuffered
  );
  if (!skipDeliveryBuffered && dailyBuffered[deliveryDayIdx] && dailyBuffered[deliveryDayIdx][rName]) {
    stock += dailyBuffered[deliveryDayIdx][rName];
  }
  return stock;
};

/** 今回納品日の翌回納品日インデックス（見つからなければ simDays = 期間末まで） */
const findNextVendorDeliveryDayIdx = (currentDeliveryDayIdx, lt, ctx, vCal, holidayCache) => {
  if (ctx && ctx._nextDeliveryDayCache && vCal && vCal._vendorName) {
    let key = vCal._vendorName + ":" + currentDeliveryDayIdx + ":" + lt;
    if (ctx._nextDeliveryDayCache[key] !== undefined) {
      return ctx._nextDeliveryDayCache[key];
    }
  }
  return findNextVendorDeliveryDayIdxCore_(currentDeliveryDayIdx, lt, ctx, vCal, holidayCache);
};

const findNextVendorDeliveryDayIdxCore_ = (currentDeliveryDayIdx, lt, ctx, vCal, holidayCache) => {
  // currentDeliveryDayIdx は「納品日」インデックスなので、
  // ここでは次の納品候補日を直接走査する（orderDay と混同しない）。
  for (let nextIdx = currentDeliveryDayIdx + 1; nextIdx < ctx.simDays; nextIdx++) {
    // この納品日 nextIdx が成立するには、対応する発注日 nextIdx-LT が存在する必要がある。
    let orderDay = nextIdx - lt;
    if (orderDay < 0) continue;
    let deliveryDate = new Date(ctx.targetDatesStr[nextIdx] + "T12:00:00");
    if (isVendorDeliveryAllowed(vCal, deliveryDate, holidayCache)) {
      return nextIdx;
    }
  }
  return ctx.simDays;
};

/**
 * 発注量算出: 業者判定 → LT/納品日 → 納品日〜翌納品日前の消費合算 → カバー発注
 * stockAfterConsumption: 発注判定日の消費反映後在庫
 */
const calcForwardLookingOrderQty = (
  rName, rawRow, orderDayIdx, stockAfterConsumption, ctx, dailyBuffered, precomputed, holidayCache, prefixSums, orderOptions
) => {
  orderOptions = orderOptions || {};
  let skipDeliveryBuffered = !!orderOptions.skipDeliveryBuffered;
  trackDebugShiodareCalcStart_(rName, rawRow, orderDayIdx, stockAfterConsumption, ctx, orderOptions);
  if (shouldSkipRawAutoOrder_(rawRow, rName)) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, { skipped: true, detail: Number(rawRow.stopFlag) === 1
      ? "原材料停止フラグ=1"
      : "自動発注対象外（" + rName + "）" });
  }

  let vCal = ctx.vendorCalendars[rawRow.vendor];
  if (!vCal) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, { skipped: true, detail: "業者「" + rawRow.vendor + "」未登録" });
  }
  if (Number(vCal.stopFlag) === 1) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, { skipped: true, detail: "業者停止フラグ=1（" + rawRow.vendor + "）" });
  }

  let minUnitLotSize = lotSizeToMinUnit(rawRow.lotQty, rawRow.lotUnit);
  if (minUnitLotSize <= 0) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, { skipped: true, detail: "ロットサイズ不正" });
  }

  let minSafetyMinUnit = (Number(rawRow.minStock) || 0) * minUnitLotSize;
  let deliveryCheck = resolveVendorOrderDeliveryDay(orderDayIdx, vCal, ctx, holidayCache);
  if (!deliveryCheck.allowed) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, { skipped: true, detail: deliveryCheck.detail });
  }
  let lt = deliveryCheck.leadTime;
  let deliveryDayIdx = deliveryCheck.deliveryDayIdx;

  let nextDeliveryDayIdx = findNextVendorDeliveryDayIdx(deliveryDayIdx, lt, ctx, vCal, holidayCache);
  let coverConsumption = sumRawConsumptionRange(
    precomputed, rName, deliveryDayIdx, nextDeliveryDayIdx, prefixSums
  );
  let stockAtDelivery = projectRawStockAtDeliveryStart_(
    precomputed, dailyBuffered, rName, orderDayIdx, deliveryDayIdx, stockAfterConsumption, skipDeliveryBuffered
  );
  let stockAtDeliveryForOrder = stockAtDelivery;

  let deliveryDateStr = ctx.targetDatesStr[deliveryDayIdx];
  let nextDeliveryDateStr = nextDeliveryDayIdx < ctx.simDays
    ? ctx.targetDatesStr[nextDeliveryDayIdx]
    : "期間末";

  let targetStock = coverConsumption + minSafetyMinUnit;
  let neededMinUnit = targetStock - stockAtDeliveryForOrder;

  if (isDebugShiodareOrderTarget_(rName)) {
    let dailyParts = [];
    for (let dd = deliveryDayIdx; dd < nextDeliveryDayIdx && dd < precomputed.length; dd++) {
      dailyParts.push(
        (ctx.targetDatesStr[dd] || dd) + ":" + Math.round(precomputed[dd][rName] || 0)
      );
    }
    trackDebugShiodareCalcMid_(rName, {
      納品日: deliveryDateStr,
      翌納品日: nextDeliveryDateStr,
      区間消費min: Math.round(coverConsumption),
      区間日次消費min: dailyParts.join(","),
      安全在庫min: Math.round(minSafetyMinUnit),
      納品朝在庫min: Math.round(stockAtDeliveryForOrder),
      不足min: Math.round(neededMinUnit)
    });
  }

  if (neededMinUnit <= 0) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, {
      skipped: true,
      detail: "納品" + deliveryDateStr + "〜" + nextDeliveryDateStr + "前 消費"
        + Math.round(coverConsumption) + "+安全在庫" + Math.round(minSafetyMinUnit)
        + " | 納品朝見込在庫" + Math.round(stockAtDeliveryForOrder)
        + "→発注不要"
    });
  }

  let orderLotSize = resolveRawOrderLotSizeMinUnit_(rName, rawRow);
  let orderLots = Math.ceil(neededMinUnit / orderLotSize);
  let aiQtyUncapped = orderLots * orderLotSize;
  let aiQty = aiQtyUncapped;
  let maxStockNote = "";
  let maxMin = maxStockMinUnitAtDelivery_(rawRow);
  let maxStockHeadroom = maxMin !== null
    ? Math.max(0, maxMin - Math.max(0, stockAtDeliveryForOrder))
    : null;

  let cappedQty = capOrderQtyByMaxStockAtDelivery_(
    rName, rawRow, stockAtDeliveryForOrder, aiQty
  );
  if (cappedQty <= 1e-6 && aiQty > 1e-6) {
    return trackDebugShiodareCalcEnd_(rName, rawRow, {
      skipped: true,
      detail: "納品" + deliveryDateStr + " 入荷後見込"
        + Math.round(stockAtDeliveryForOrder + aiQty)
        + ">" + (Number(rawRow.maxStock) || 0) + (rawRow.orderUnit || "箱")
        + "（最大在庫上限）→発注不可"
    });
  }
  if (cappedQty + 1e-6 < aiQty) {
    aiQty = cappedQty;
    orderLots = orderLotSize > 0 ? aiQty / orderLotSize : 0;
    maxStockNote = " 最大在庫上限" + (Number(rawRow.maxStock) || 0) + (rawRow.orderUnit || "箱");
  }

  if (isDebugShiodareOrderTarget_(rName)) {
    trackDebugShiodareCalcMid_(rName, {
      理論発注min: Math.round(aiQtyUncapped),
      最大在庫余力min: maxStockHeadroom !== null ? Math.round(maxStockHeadroom) : "なし",
      キャップ後発注min: Math.round(aiQty)
    });
  }

  let stockAfterReceipt = Math.round(stockAtDeliveryForOrder + aiQty);
  let maxStockUnits = Number(rawRow.maxStock) || 0;
  let stockNote = maxStockUnits > 0
    ? "(納品入荷後見込" + stockAfterReceipt + "/" + maxStockUnits + (rawRow.orderUnit || "箱") + "上限)→"
    : "(納品入荷後見込" + stockAfterReceipt + ")→";

  return trackDebugShiodareCalcEnd_(rName, rawRow, {
    skipped: false,
    aiQty: aiQty,
    orderLots: orderLots,
    deliveryDayIdx: deliveryDayIdx,
    nextDeliveryDayIdx: nextDeliveryDayIdx,
    coverConsumption: coverConsumption,
    stockAtDelivery: stockAtDelivery,
    stockAtDeliveryForOrder: stockAtDeliveryForOrder,
    minSafetyMinUnit: minSafetyMinUnit,
    unit: rawRow.orderUnit || "箱",
    vendor: rawRow.vendor,
    reason: "納品" + deliveryDateStr + "〜翌納品" + nextDeliveryDateStr + "前の消費"
      + Math.round(coverConsumption) + "+安全在庫" + Math.round(minSafetyMinUnit)
      + stockNote
      + orderLots + (rawRow.orderUnit || "箱") + maxStockNote,
    detail: "→発注対象 " + orderLots + (rawRow.orderUnit || "箱") + maxStockNote
      + "（納品" + deliveryDateStr + " 区間消費" + Math.round(coverConsumption) + "）"
  });
}
