function runDiagnoseMissingIngredientRecipes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  let configBlock = orderSheet.getRange("B2:F3").getValues();
  let orderDate = new Date(configBlock[0][0]);
  let averageSpend = configBlock[0][4];
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
  let inventoryDate = (inventoryVal && !isNaN(new Date(inventoryVal).getTime())) ? new Date(inventoryVal) : null;
  let simStartDate = inventoryDate || orderDate;
  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);

  let ctx = buildSimulationContext(simStartDate, 1, "当日", orderDate, {
    vendorData: vendorData,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend
  });

  // 「コーンバター」「枝豆バター」はメニュー(recipeMaster)側。停止フラグ列を追加読み込み済み
  ["コーンバター", "枝豆バター"].forEach((menuName) => {
    let recipe = ctx.recipeMaster[menuName];
    if (!recipe) {
      Logger.log(`[未登録材料診断] レシピ「${menuName}」自体がrecipeMasterに見つかりません`);
      return;
    }
    let ingText = (recipe.ingredients || []).map((ing) => `${ing.name}=${ing.qty}`).join(", ");
    Logger.log(`[未登録材料診断] レシピ「${menuName}」停止フラグ=${Number(recipe.stopFlag) || 0} 備考="${recipe.note || ""}" 原材料: ${ingText}`);
  });

  // 「仕込みうずら」は中間レシピ(preparationRecipes)側。stopFlagを直接確認できる
  let uzuraPrep = ctx.preparationRecipes["仕込みうずら"];
  if (uzuraPrep) {
    let ingText = (uzuraPrep.ingredients || []).map((ing) => `${ing.name}=${ing.qty}`).join(", ");
    Logger.log(`[未登録材料診断] 中間レシピ「仕込みうずら」停止フラグ=${Number(uzuraPrep.stopFlag) || 0} 原材料: ${ingText}`);
  } else {
    Logger.log("[未登録材料診断] 中間レシピ「仕込みうずら」自体がpreparationRecipesに見つかりません");
  }

  // 「コーン」「枝豆」「うずらの卵」自体が、別名や停止状態も含めどこかに存在しないか
  ["コーン", "枝豆", "うずらの卵"].forEach((ingName) => {
    let inRaw = ctx.rawMaster[ingName];
    let inPrep = ctx.preparationRecipes[ingName];
    Logger.log(`[未登録材料診断] 「${ingName}」 原材料マスタ=${inRaw ? "あり(停止=" + (Number(inRaw.stopFlag) || 0) + ")" : "なし"} 中間レシピ=${inPrep ? "あり(停止=" + (Number(inPrep.stopFlag) || 0) + ")" : "なし"}`);
  });
}

function runTestItemSalesBias() {
  // 1) scaleDemandMapWithItemBias_ の純粋なロジック検証
  let src = { "ご飯": 0.02, "カットジンギスカン": 0.015, "米": 0.01 };
  let itemBias = { "ご飯": 1.15, "カットジンギスカン": 0.85 }; // 米は係数なし→補正1のはず
  let scaled = scaleDemandMapWithItemBias_(src, 100000, itemBias);
  let expected = { "ご飯": 0.02 * 100000 * 1.15, "カットジンギスカン": 0.015 * 100000 * 0.85, "米": 0.01 * 100000 * 1 };
  let mathOk = true;
  Object.keys(expected).forEach((k) => {
    let ok = Math.abs(scaled[k] - expected[k]) < 0.01;
    if (!ok) mathOk = false;
    Logger.log(`[商品別バイアステスト] ${k}: 期待=${expected[k].toFixed(2)} 実際=${(scaled[k] || 0).toFixed(2)} ${ok ? "OK" : "NG"}`);
  });
  Logger.log(`[商品別バイアステスト] 係数適用ロジック判定=${mathOk ? "OK" : "NG"}`);

  // 2) 実データでの参考値（算出できた係数の一覧）
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  let configBlock = orderSheet.getRange("B2:F3").getValues();
  let orderDate = new Date(configBlock[0][0]);
  let averageSpend = configBlock[0][4];
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
  let inventoryDate = (inventoryVal && !isNaN(new Date(inventoryVal).getTime())) ? new Date(inventoryVal) : null;
  let simStartDate = inventoryDate || orderDate;
  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);

  let ctx = buildSimulationContext(simStartDate, 1, "当日", orderDate, {
    vendorData: vendorData,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend
  });

  let t0 = Date.now();
  let unit = computeUnitMenuDemands_(ctx);
  let biasResult = calcItemSalesBiasCoefficients_(ctx, unit);
  let coefficients = biasResult.coefficients;
  let detail = biasResult.detail;
  let t1 = Date.now();
  Logger.log(`[商品別バイアステスト] 算出時間=${t1 - t0}ms 算出できた品目数=${Object.keys(coefficients).length}`);

  let sortedItems = Object.keys(coefficients).sort((a, b) => {
    return Math.abs(coefficients[b] - 1) - Math.abs(coefficients[a] - 1);
  });
  Logger.log(`[商品別バイアステスト] 1からのズレが大きい上位10品目: ${sortedItems.slice(0, 10).map((k) => `${k}=${coefficients[k].toFixed(2)}`).join(", ")}`);

  // 4) 上位品目の内訳（日次の予測/実績/比率、単純移動平均との比較）
  sortedItems.slice(0, 10).forEach((item) => {
    let rows = detail[item] || [];
    let mean = rows.reduce((sum, r) => sum + r.ratio, 0) / (rows.length || 1);
    Logger.log(`[商品別バイアス内訳] ${item}: 中央値係数=${coefficients[item].toFixed(3)} 単純移動平均=${mean.toFixed(3)} サンプル数=${rows.length}`);
    let rowsText = rows.map((r) => `${r.date} 予測=${r.predicted.toFixed(1)} 実績=${r.actual.toFixed(1)} 比率=${r.ratio.toFixed(2)}`).join(" / ");
    Logger.log(`[商品別バイアス内訳] ${item} 日次明細: ${rowsText}`);
  });
}

function runDiagnoseTopBiasItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  let configBlock = orderSheet.getRange("B2:F3").getValues();
  let orderDate = new Date(configBlock[0][0]);
  let averageSpend = configBlock[0][4];
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
  let inventoryDate = (inventoryVal && !isNaN(new Date(inventoryVal).getTime())) ? new Date(inventoryVal) : null;
  let simStartDate = inventoryDate || orderDate;
  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);

  let ctx = buildSimulationContext(simStartDate, 1, "当日", orderDate, {
    vendorData: vendorData,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend
  });

  let targets = [
    "合わせ酢味噌", "千切りきゅうり", "キャベツ", "生ニンニクごま油", "合わせつけだれ",
    "冷凍レモン", "卓上唐辛子", "カットなす", "くし切りレモン", "アジシオ"
  ];

  // 1) 各品目の分類(raw/prep)とstopFlag
  targets.forEach((name) => {
    let routed = routeUnifiedMaterial_(name, ctx);
    let row = routed.kind === "raw" ? ctx.rawMaster[routed.name]
      : routed.kind === "prep" ? ctx.preparationRecipes[routed.name]
      : null;
    let stopFlag = row ? Number(row.stopFlag) || 0 : "(該当なし)";
    Logger.log(`[品目診断] ${name} → 分類=${routed.kind} 正規名=${routed.name} 停止フラグ=${stopFlag}`);
  });

  // 2) 各品目をレシピで参照しているメニュー一覧（逆引き）
  targets.forEach((name) => {
    let routed = routeUnifiedMaterial_(name, ctx);
    let refs = [];
    Object.keys(ctx.recipeMaster).forEach((menuName) => {
      let recipe = ctx.recipeMaster[menuName];
      (recipe.ingredients || []).forEach((ing) => {
        let ingRouted = routeUnifiedMaterial_(ing.name, ctx);
        if (ingRouted.name === routed.name) {
          refs.push(`${menuName}(備考=${recipe.note || ""})=${ing.qty}`);
        }
      });
    });
    Logger.log(`[品目診断] ${name} を参照しているメニュー(${refs.length}件): ${refs.join(", ") || "(なし)"}`);
  });

  // 3) 「チャージ」関連のメニュー・POS実績の有無
  let chargeMenus = Object.keys(ctx.recipeMaster).filter((n) => n.indexOf("チャージ") !== -1);
  Logger.log(`[品目診断] レシピ表上の「チャージ」関連メニュー: ${chargeMenus.join(", ") || "(なし)"}`);
  let chargePos = (ctx.posCleanData || []).filter((r) => String(r.menuName).indexOf("チャージ") !== -1);
  Logger.log(`[品目診断] POSクレンジング済データ上の「チャージ」関連行: ${chargePos.map((r) => `${r.menuName}(数量=${r.salesQty})`).join(", ") || "(なし)"}`);

  // 4) タン刺し系メニューのレシピ内訳（くし切りレモンが分解されているか）
  let tanSashiMenus = Object.keys(ctx.recipeMaster).filter((n) => n.indexOf("タン刺し") !== -1);
  tanSashiMenus.forEach((menuName) => {
    let recipe = ctx.recipeMaster[menuName];
    let ingText = (recipe.ingredients || []).map((ing) => `${ing.name}=${ing.qty}`).join(", ");
    Logger.log(`[品目診断] ${menuName}(備考=${recipe.note || ""}) の原材料: ${ingText || "(なし)"}`);
  });
}

function runTestHolidayCache() {
  // 1) 初回相当のフル取得（速度確認込み）
  let t0 = Date.now();
  let cache = refreshJapaneseHolidayCache_(HOLIDAY_CACHE_FETCH_DAYS_);
  let t1 = Date.now();
  Logger.log(`[祝日テスト] 取得範囲=${cache.rangeStart}〜${cache.rangeEnd} 件数=${cache.dates.length} 取得時間=${t1 - t0}ms`);
  Logger.log(`[祝日テスト] 先頭10件: ${cache.dates.slice(0, 10).join(", ")}`);

  // 2) キャッシュ範囲内の実データから祝日・非祝日を動的に選んで判定を検証
  //    (ハードコード日付だと範囲外に落ちてフォールバック経由になるため、実データから選ぶ)
  let allOk = true;
  if (cache.dates.length === 0) {
    Logger.log("[祝日テスト] キャッシュに祝日が1件もありません。判定検証をスキップします。");
  } else {
    let knownHoliday = cache.dates[0];
    let holidaySet = {};
    cache.dates.forEach((d) => { holidaySet[d] = true; });
    let knownNonHoliday = cache.rangeStart;
    let guard = 0;
    while (holidaySet[knownNonHoliday] && guard < 30) {
      knownNonHoliday = addDaysToDateStr_(knownNonHoliday, 1);
      guard++;
    }

    let holidayResult = isJapanesePublicHolidayCached(new Date(knownHoliday + "T12:00:00"), {});
    if (holidayResult !== true) allOk = false;
    Logger.log(`[祝日テスト] ${knownHoliday}(キャッシュ実データ) 期待=祝日 実際=${holidayResult ? "祝日" : "非祝日"} ${holidayResult ? "OK" : "NG"}`);

    let nonHolidayResult = isJapanesePublicHolidayCached(new Date(knownNonHoliday + "T12:00:00"), {});
    if (nonHolidayResult !== false) allOk = false;
    Logger.log(`[祝日テスト] ${knownNonHoliday}(キャッシュ実データ) 期待=非祝日 実際=${nonHolidayResult ? "祝日" : "非祝日"} ${!nonHolidayResult ? "OK" : "NG"}`);

    // 3) 永続キャッシュ経由の参照が高速か（範囲内の日付でPropertiesServiceの都度読込を避けられているか）
    let t2 = Date.now();
    for (let i = 0; i < 100; i++) {
      isJapanesePublicHolidayCached(new Date(knownHoliday + "T12:00:00"), {});
    }
    let t3 = Date.now();
    Logger.log(`[祝日テスト] キャッシュ範囲内の参照100回=${t3 - t2}ms（数百ms以内ならOK、数秒以上ならフォールバックを踏んでいる可能性）`);
  }

  // 4) ensureJapaneseHolidayCacheFresh_ が「範囲内なら再取得しない」ことを確認
  let t4 = Date.now();
  let cacheAgain = ensureJapaneseHolidayCacheFresh_();
  let t5 = Date.now();
  let skippedRefetch = (t5 - t4) < 50 && cacheAgain.fetchedAt === cache.fetchedAt;
  Logger.log(`[祝日テスト] 直後のensureJapaneseHolidayCacheFresh_=${t5 - t4}ms 再取得スキップ=${skippedRefetch ? "OK" : "NG(再取得された)"}`);

  Logger.log(`[祝日テスト] 総合判定=${allOk ? "OK" : "NG"}`);
}

function runDiagnoseGohanDemand() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let orderSheet = ss.getSheetByName(SHEET_NAMES.ORDER_FORM);
  let configBlock = orderSheet.getRange("B2:F3").getValues();
  let orderDate = new Date(configBlock[0][0]);
  let averageSpend = configBlock[0][4];
  let stockSheet = ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
  let inventoryVal = stockSheet ? stockSheet.getRange("B1").getValue() : null;
  let inventoryDate = (inventoryVal && !isNaN(new Date(inventoryVal).getTime())) ? new Date(inventoryVal) : null;
  let simStartDate = inventoryDate || orderDate;
  let vendorSheet = ss.getSheetByName(SHEET_NAMES.VENDOR_MASTER);
  let vendorData = loadSTVendorCalendar(vendorSheet);

  let ctx = buildSimulationContext(simStartDate, 1, "当日", orderDate, {
    vendorData: vendorData,
    inventoryDateStr: inventoryDate ? formatJstDate_(inventoryDate) : null,
    averageSpend: averageSpend
  });

  Logger.log(`[診断ご飯] レシピマスタ品目数=${Object.keys(ctx.recipeMaster).length} POS明細行数=${(ctx.posCleanData || []).length}`);

  let gohanRows = [];
  Object.keys(ctx.recipeMaster).forEach((menuName) => {
    let recipe = ctx.recipeMaster[menuName];
    (recipe.ingredients || []).forEach((ing) => {
      if (ing.name === "ご飯") {
        gohanRows.push(`${menuName}=${ing.qty}`);
      }
    });
  });
  Logger.log(`[診断ご飯] 「ご飯」を参照しているメニュー数=${gohanRows.length}`);
  Logger.log(`[診断ご飯] 内訳: ${gohanRows.join(", ") || "(なし)"}`);

  let unmatched = {};
  let unmatchedQtyTotal = 0;
  let matchedQtyTotal = 0;
  (ctx.posCleanData || []).forEach((posRow) => {
    let recipe = ctx.recipeMaster[posRow.menuName];
    let qty = Number(posRow.salesQty) || 0;
    if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) {
      unmatched[posRow.menuName] = (unmatched[posRow.menuName] || 0) + qty;
      unmatchedQtyTotal += qty;
    } else {
      matchedQtyTotal += qty;
    }
  });
  Logger.log(`[診断ご飯] レシピ未紐付けのPOS商品数=${Object.keys(unmatched).length} 合計販売数量=${unmatchedQtyTotal}（紐付け済み合計販売数量=${matchedQtyTotal}）`);
  let unmatchedSorted = Object.keys(unmatched)
    .sort((a, b) => unmatched[b] - unmatched[a])
    .slice(0, 30)
    .map((k) => `${k}=${unmatched[k]}`);
  Logger.log(`[診断ご飯] 未紐付け上位30件: ${unmatchedSorted.join(", ")}`);

  let unit = computeUnitMenuDemands_(ctx);
  Logger.log(`[診断ご飯] 売上1円あたりご飯需要=${unit.prepDemand["ご飯"] || 0}g/円`);
}

function runDiagnoseSmaregiSales() {
  diagnoseSmaregiSales_("2026-07-02", "1"); // ← 日付・店舗IDを実際の値に書き換える
}

const diagnoseSmaregiSales_ = (dateStr, storeId) => {
  let token = getSmaregiAccessToken_("pos.transactions:read");
  let fromIso = `${dateStr}T00:00:00+09:00`;
  let toIso = `${dateStr}T23:59:59+09:00`;
  let baseUrl = `${SMAREGI_CONFIG.apiBase}/${SMAREGI_CONFIG.contractId}/pos/transactions`;

  let allTransactions = [];
  let limit = 100;
  for (let page = 1; page <= 50; page++) {
    let url = baseUrl
      + `?transaction_date_time-from=${encodeURIComponent(fromIso)}`
      + `&transaction_date_time-to=${encodeURIComponent(toIso)}`
      + `&store_id=${encodeURIComponent(storeId)}`
      + `&with_details=all&limit=${limit}&page=${page}`;
    let res = UrlFetchApp.fetch(url, { method: "get", headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log(`[診断] APIエラー page=${page} status=${res.getResponseCode()} body=${res.getContentText().slice(0, 500)}`);
      break;
    }
    let transactions = extractSmaregiListFromResponse_(JSON.parse(res.getContentText() || "[]"));
    if (transactions.length === 0) break;
    allTransactions = allTransactions.concat(transactions);
    if (transactions.length < limit) break;
  }
  Logger.log(`[診断] 取得取引数(フィルタ前)=${allTransactions.length}`);

  let divisionCounts = {};
  allTransactions.forEach((t) => {
    let key = `head=${t.transactionHeadDivision} cancel=${t.cancelDivision}`;
    divisionCounts[key] = (divisionCounts[key] || 0) + 1;
  });
  Logger.log(`[診断] 取引区分の内訳: ${JSON.stringify(divisionCounts)}`);

  let validTransactions = allTransactions.filter((t) => {
    return String(t.transactionHeadDivision) === "1" && String(t.cancelDivision) !== "1";
  });
  Logger.log(`[診断] フィルタ後取引数=${validTransactions.length}`);

  let allDetails = [];
  validTransactions.forEach((t) => { (t.details || []).forEach((d) => allDetails.push(d)); });
  Logger.log(`[診断] 明細行数=${allDetails.length}`);

  let taxDivisionCounts = {};
  let rawSum = 0;
  let nonDiscountSum = 0;
  allDetails.forEach((d) => {
    let key = String(d.taxDivision);
    taxDivisionCounts[key] = (taxDivisionCounts[key] || 0) + 1;
    rawSum += Number(d.unitDiscountedSum) || 0;
    nonDiscountSum += Number(d.unitNonDiscountSum) || 0;
  });
  Logger.log(`[診断] taxDivision内訳: ${JSON.stringify(taxDivisionCounts)}`);
  Logger.log(`[診断] unitDiscountedSum合計(変換前)=${Math.round(rawSum)}`);
  Logger.log(`[診断] unitNonDiscountSum合計(値引き前)=${Math.round(nonDiscountSum)}`);
  Logger.log(`[診断] 税抜換算後合計(現状ロジック)=${Math.round(convertPosSalesToExTax(rawSum))}`);

  let rows = allDetails.map((d) => { return { rawName: d.productName, qty: d.quantity, salesIncTax: d.unitDiscountedSum }; });
  let aggregated = aggregateCleanedSalesRows_(rows);
  let aggregatedTotal = aggregated.reduce((sum, r) => sum + (Number(r.salesAmount) || 0), 0);
  Logger.log(`[診断] 集計後(クレンジング・ゼロ円除外込み)商品数=${aggregated.length} 合計=${Math.round(aggregatedTotal)}`);

  let droppedByEmptyName = allDetails.filter((d) => !cleanProductName(String(d.productName || ""))).length;
  Logger.log(`[診断] 商品名クレンジングで空文字になった明細行数=${droppedByEmptyName}`);
};

/**
 * Infomart診断1: トークン取得のみ確認（店舗別資格情報とホストの疎通確認用。まずこれを単独実行）
 * 対象店舗は、実行前にスプレッドシート側で開いていたタブの「予算・実績」D1選択に従う
 * （resolveSelectedInfomartStoreName_ と同じ解決方法。プルダウンの店舗名をそのまま使う）
 */
function runDiagnoseInfomartToken() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartToken_(storeName);
}

const diagnoseInfomartToken_ = (storeName) => {
  try {
    let token = getInfomartAccessToken_(storeName);
    Logger.log(`[診断Infomart] 店舗=${storeName} トークン取得成功: ${String(token).slice(0, 8)}...（先頭8文字のみ表示）`);
  } catch (err) {
    Logger.log(`[診断Infomart] 店舗=${storeName} トークン取得失敗: ${err.message}`);
  }
};

/**
 * Infomart診断2: 請求書検索の生レスポンス形状を確認（想定フィールド名と実データを突き合わせる）
 * 対象店舗は runDiagnoseInfomartToken と同じくアクティブなタブの D1 選択から自動解決する。
 */
function runDiagnoseInfomartInvoices() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartInvoices_("2026-07-02", storeName); // ← 日付を実際の値に書き換える
}

const diagnoseInfomartInvoices_ = (dateStr, storeName) => {
  let invoices = fetchInfomartInvoicesForDate_(dateStr, storeName);
  Logger.log(`[診断Infomart] 店舗=${storeName} 請求書件数=${invoices.length}`);
  if (invoices.length > 0) {
    Logger.log(`[診断Infomart] 先頭レコードの生JSON: ${JSON.stringify(invoices[0]).slice(0, 2000)}`);
  }
};

/**
 * Infomart診断3: 受発注データダウンロード(request→check→get)の生レスポンス形状を確認
 * この関数で target_date_set の意味・/check の「準備完了」判定フィールド・
 * /get が返す実データのフィールド名を確認し、infomart.gs 側のマッピングを見直す
 * 対象店舗は runDiagnoseInfomartToken と同じくアクティブなタブの D1 選択から自動解決する。
 */
function runDiagnoseInfomartOrderDelivery() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartOrderDelivery_("2026-07-01", "2026-07-02", storeName); // ← 日付範囲を実際の値に書き換える
}

const diagnoseInfomartOrderDelivery_ = (dateFrom, dateTo, storeName) => {
  let { requestId, batchId } = requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, 0, null, storeName);
  Logger.log(`[診断Infomart] 店舗=${storeName} request完了 request_id=${requestId} batch_id=${batchId}`);

  let status = pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
  Logger.log(`[診断Infomart] check最終状態: ${JSON.stringify(status).slice(0, 500)}`);

  let recordCount = Number(status.record_count) || 0;
  if (recordCount === 0) {
    Logger.log("[診断Infomart] record_count=0のため対象データなし（getは呼ばずに終了）");
    return;
  }
  let result = getInfomartOrderDeliveryResult_(batchId, 1, Math.min(recordCount, 1000), storeName);
  Logger.log(`[診断Infomart] get結果: ${JSON.stringify(result).slice(0, 2000)}`);
};

/**
 * Infomart診断4: 親アカウントでの運用時に「店舗ごとのデータ判別」が可能かどうかを確認する（請求書）。
 * 過去lookbackDays日ぶんの請求書（受取側API /wi/v2/buyer/invoice/search）をまとめて取得する。
 * invdata[] 要素の実際のフィールド名はまだ未確認のため、customer_company_name等を決め打ちせず、
 * ①先頭2件の生JSONをそのまま出力（フィールド名を目視確認するため）
 * ②company_name_s（支払先＝仕入先名、店舗判別には使えない想定）・burden_sec_code/burden_sec_name
 *   （負担部門コード/名、リクエストパラメータに存在＝店舗を「部門」として持っている可能性がある）
 *   など候補フィールドが存在すればその出現パターンも集計する
 * の両方をログ出力する。判定はログを見ながら人間側で行う。
 * 対象店舗（＝どの登録PFIDでログインするか）はアクティブなタブのD1選択に従う。
 */
function runDiagnoseInfomartStoreScope() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartStoreScope_(storeName, 30); // ← 必要なら日数を調整
}

const diagnoseInfomartStoreScope_ = (storeName, lookbackDays) => {
  let dateTo = formatJstDate_(new Date());
  let fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  let dateFrom = formatJstDate_(fromDate);

  let invoices = fetchInfomartInvoicesForDateRange_(dateFrom, dateTo, storeName);
  Logger.log(`[診断Infomart店舗スコープ:請求書] ログイン店舗=${storeName} 期間=${dateFrom}〜${dateTo} 合計件数=${invoices.length}`);

  if (invoices.length === 0) {
    Logger.log("[診断Infomart店舗スコープ:請求書] 判定不能: 対象期間に請求書が0件。lookbackDaysを増やすか日付範囲を見直してください。");
    return;
  }

  Logger.log(`[診断Infomart店舗スコープ:請求書] 先頭レコードのキー一覧: ${JSON.stringify(Object.keys(invoices[0]))}`);
  invoices.slice(0, 2).forEach((inv, i) => {
    Logger.log(`[診断Infomart店舗スコープ:請求書] 生JSON[${i}]: ${JSON.stringify(inv).slice(0, 2000)}`);
  });

  // company_name_s（支払先＝仕入先名。おそらく店舗判別には使えないが参考として）と
  // burden_sec_code/burden_sec_name（負担部門。店舗＝部門になっている可能性があるため要注目）を集計
  ["company_name_s", "burden_sec_code", "burden_sec_name", "acc_depart_name", "private_cust_cd_s"].forEach((field) => {
    let counts = {};
    let present = false;
    invoices.forEach((inv) => {
      if (!(field in inv)) return;
      present = true;
      let value = inv[field] == null || inv[field] === "" ? "(空)" : String(inv[field]);
      counts[value] = (counts[value] || 0) + 1;
    });
    if (!present) {
      Logger.log(`[診断Infomart店舗スコープ:請求書] フィールド「${field}」はレスポンスに存在しない`);
      return;
    }
    Logger.log(`[診断Infomart店舗スコープ:請求書] フィールド「${field}」の内訳（${Object.keys(counts).length}種類）: ${JSON.stringify(counts).slice(0, 1000)}`);
  });
};

/**
 * Infomart診断5: 受発注データについても同様に、取引先名の内訳から店舗判別可否を確認する。
 * target_date_set は [0:更新日 1:伝票日 2:発注日 3:発送予定日 4:発送日 5:納品日 6:受領日 7:送信日]
 * （ord_api_reference.htmlで確認済み）。前回0（更新日）で試して0件だったため、今回は
 * 2（発注日）で試す。フィールド名（customer_company_name）は
 * writeInfomartOrderDeliveryLogForRange_ のマッピングに基づく推測であり未検証のため、
 * 判定と合わせて生JSONも出力する。
 */
function runDiagnoseInfomartOrderStoreScope() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  // 西口店の自社会員システムコード候補（要検証）
  diagnoseInfomartOrderStoreScope_(storeName, 13, 2, ["BuTesnvS"]); // ← 受発注APIは期間14日以内の制約(from〜to両端込み)があるため13日で収める
}

/**
 * Infomart診断6: target_date_set(0〜7)を総当たりし、どの日付区分でも本当に0件なのかを確認する。
 * member_codesは指定しない（このエンドポイントでは未指定時「全て」扱いのため、絞り込みが原因では
 * ないはず）。record_countだけを見るためgetは呼ばない（request→checkのみ、8回分）。
 * アカウント自体が正しくInfomartで発注しているにも関わらず0件が続く場合の切り分け用。
 */
function runDiagnoseInfomartOrderRecordCountsByDateType() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartOrderRecordCountsByDateType_(storeName, 13);
}

const diagnoseInfomartOrderRecordCountsByDateType_ = (storeName, lookbackDays) => {
  let dateTo = formatJstDate_(new Date());
  let fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  let dateFrom = formatJstDate_(fromDate);
  let labels = ["更新日", "伝票日", "発注日", "発送予定日", "発送日", "納品日", "受領日", "送信日"];

  for (let targetDateSet = 0; targetDateSet <= 7; targetDateSet++) {
    try {
      let { batchId } = requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, null, storeName);
      let status = pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
      Logger.log(`[診断Infomart全date_set] target_date_set=${targetDateSet}(${labels[targetDateSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart全date_set] target_date_set=${targetDateSet}(${labels[targetDateSet]}) 失敗: ${err.message}`);
    }
  }
};

/**
 * Infomart診断7: status_set(伝票種別、0〜5)を総当たりし、承認待ち等のステータスが原因で
 * 除外されていないかを確認する。target_date_set=2(発注日)固定、member_codesは
 * BuTesnvS（URLの末尾から確認したコード、フォーマット的に正しいはず）で試す。
 */
function runDiagnoseInfomartOrderRecordCountsByStatusSet() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  diagnoseInfomartOrderRecordCountsByStatusSet_(storeName, 13);
}

const diagnoseInfomartOrderRecordCountsByStatusSet_ = (storeName, lookbackDays) => {
  let dateTo = formatJstDate_(new Date());
  let fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  let dateFrom = formatJstDate_(fromDate);
  let labels = ["通常＋仕入伝票", "通常伝票のみ", "仕入伝票のみ", "申請発注", "発注予定", "振替伝票"];
  let memberCodes = ["BuTesnvS"];

  for (let statusSet = 0; statusSet <= 5; statusSet++) {
    try {
      let { batchId } = requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, 2, null, storeName, memberCodes, statusSet);
      let status = pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
      Logger.log(`[診断Infomart全status_set] status_set=${statusSet}(${labels[statusSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart全status_set] status_set=${statusSet}(${labels[statusSet]}) 失敗: ${err.message}`);
    }
  }
};

/**
 * Infomart診断8: 一昨日1日だけに絞ってtarget_date_set(0〜7)を総当たりする。
 * 「dateToを今日にしているのが原因では」という疑いの切り分け用（当日はまだ確定していない
 * 可能性があるため、確実に日をまたいだ一昨日だけで確認する）。
 */
function runDiagnoseInfomartOrderRecordCountsForDayBeforeYesterday() {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedSmaregiStore_(budgetSheet).storeName;
  let target = new Date();
  target.setDate(target.getDate() - 2);
  let dateStr = formatJstDate_(target);
  let labels = ["更新日", "伝票日", "発注日", "発送予定日", "発送日", "納品日", "受領日", "送信日"];
  let memberCodes = ["BuTesnvS"];

  Logger.log(`[診断Infomart一昨日] 対象日=${dateStr}`);
  for (let targetDateSet = 0; targetDateSet <= 7; targetDateSet++) {
    try {
      let { batchId } = requestInfomartOrderDeliveryExtract_(dateStr, dateStr, targetDateSet, null, storeName, memberCodes);
      let status = pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
      Logger.log(`[診断Infomart一昨日] target_date_set=${targetDateSet}(${labels[targetDateSet]}) record_count=${status.record_count}`);
    } catch (err) {
      Logger.log(`[診断Infomart一昨日] target_date_set=${targetDateSet}(${labels[targetDateSet]}) 失敗: ${err.message}`);
    }
  }
}

const diagnoseInfomartOrderStoreScope_ = (storeName, lookbackDays, targetDateSet, memberCodes) => {
  let dateTo = formatJstDate_(new Date());
  let fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  let dateFrom = formatJstDate_(fromDate);

  let trades = fetchInfomartOrderDeliveryTrades_(dateFrom, dateTo, targetDateSet, null, storeName, memberCodes);
  Logger.log(`[診断Infomart店舗スコープ:受発注] ログイン店舗=${storeName} 期間=${dateFrom}〜${dateTo} 合計件数=${trades.length}`);

  let companyNames = {};
  trades.forEach((t) => {
    let name = t.customer_company_name || "(空)";
    companyNames[name] = (companyNames[name] || 0) + 1;
  });
  Logger.log(`[診断Infomart店舗スコープ:受発注] 取引先(customer_company_name想定)の内訳: ${JSON.stringify(companyNames)}`);
  if (trades.length > 0) {
    Logger.log(`[診断Infomart店舗スコープ:受発注] 先頭レコードの生JSON: ${JSON.stringify(trades[0]).slice(0, 2000)}`);
  }
};