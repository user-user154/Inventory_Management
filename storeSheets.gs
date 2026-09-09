/**
 * 8. storeSheets.gs: 店舗別シート（予算・実績 / 指示書 / POSデータ_生 / POSデータ_整形後 /
 * バックログ / AI予測手動調整ログ / 予測出数ログ）の命名規則・解決・作成
 *
 * 背景: 複数店舗を1つのスプレッドシート＋1つのスクリプトプロジェクトで運用するため
 * （スクリプトプロパティ POS_CLIENT_ID 等はファイルコピーでは引き継がれないため、
 * ファイル分割ではなくシート分割を採用）、店舗ごとの運用シートを
 * 「元の名前_店舗名」（例: 予算・実績_渋谷店）という命名規則で複製する。
 *
 * 元の固定名シート（例: 予算・実績）はテンプレート/ひな形として残し、削除・改名はしない
 * （既存データを壊さないため）。店舗別シート未作成の状態でも、元の固定名シートで
 * 従来どおり動作する（storeName が null のときは元の名前をそのまま使う後方互換）。
 *
 * バックログ・AI予測手動調整ログ・予測出数ログは、日付のみで行を置換するロジックのため
 * 元々は店舗共有シートのままにしていたが、複数店舗が同日に運用すると互いの行を上書きする
 * リスクがあったため、他の運用シートと同じ店舗別タブ方式に統一した。
 *
 * 対象外（分割しない・共有のまま）: レシピ表・中間レシピ表・原材料マスタ・歩留まりマスタ・
 * 名寄せマスタ・発注業者マスタ、実績出数ログ（既にstoreId列で対応済み）、
 * 確定指示ログ（コード上どこからも参照されない未使用シート）、Infomart請求書ログ・
 * Infomart受発注ログ（店舗ごとの資格情報でAPIを取得し追記するだけのログのため共有のままで十分）。
 *
 * 棚卸し表は当初「共有マスタ」として設計したが、実運用では店舗ごとに別タブ
 * （例:「棚卸し表_池袋西口店」）で棚卸しされている。ただし他の店舗別シートと違い、
 * サフィックスがスマレジ店舗名の屋号を除いた拠点名のみ（「大衆焼肉コグマヤ池袋西口店」に対し
 * 「池袋西口店」）のため、buildStoreSheetName_ の完全一致では解決できない。
 * そのため resolveStockTakingSheet_ で専用に解決する（下記）。
 */

/** 店舗別に分割するシートのベース名（constants.gs の SHEET_NAMES を参照） */
const STORE_SPLIT_SHEET_BASES_ = [
  SHEET_NAMES.BUDGET_ACTUAL,
  SHEET_NAMES.ORDER_FORM,
  SHEET_NAMES.POS_RAW,
  SHEET_NAMES.POS_CLEAN,
  SHEET_NAMES.BACKLOG,
  SHEET_NAMES.MANUAL_ADJUSTMENT_LOG,
  SHEET_NAMES.FORECAST_DEMAND_LOG
];

/** 店舗別シート名を組み立てる（例: "予算・実績" + "渋谷店" → "予算・実績_渋谷店"） */
const buildStoreSheetName_ = (baseName, storeName) => {
  return `${baseName}_${storeName}`;
};

/**
 * 対象店舗の棚卸し表シートを解決する。
 * 1. 「棚卸し表_<storeNameそのまま>」の完全一致（将来スマレジ店舗名と揃えた場合用）
 * 2. 「棚卸し表_<拠点名>」で、storeName がその拠点名を含む場合（現状の実運用はこちら。
 *    例: storeName="大衆焼肉コグマヤ池袋西口店" → シート「棚卸し表_池袋西口店」に一致）
 * 3. どちらも無ければ元の固定名「棚卸し表」（未分割・単一店舗運用時の後方互換）
 */
const resolveStockTakingSheet_ = (ss, storeName) => {
  let name = storeName ? String(storeName).trim() : "";
  if (name) {
    let exact = ss.getSheetByName(buildStoreSheetName_(SHEET_NAMES.STOCK_TAKING, name));
    if (exact) return exact;

    let prefix = SHEET_NAMES.STOCK_TAKING + "_";
    let bySuffix = ss.getSheets().find((sheet) => {
      let sheetName = sheet.getName();
      if (sheetName.indexOf(prefix) !== 0) return false;
      let suffix = sheetName.slice(prefix.length);
      return suffix.length > 0 && name.indexOf(suffix) !== -1;
    });
    if (bySuffix) return bySuffix;
  }
  return ss.getSheetByName(SHEET_NAMES.STOCK_TAKING);
};

/**
 * シート名からベース名・店舗名を解析する。
 * - 元の固定名（例: "予算・実績"）そのままなら { baseName, storeName: null }
 * - "ベース名_店舗名" 形式なら { baseName, storeName }
 * - 対象4シートのいずれにも該当しなければ null
 */
const parseStoreSheetName_ = (sheetName) => {
  let name = String(sheetName || "");
  for (let i = 0; i < STORE_SPLIT_SHEET_BASES_.length; i++) {
    let base = STORE_SPLIT_SHEET_BASES_[i];
    if (name === base) {
      return { baseName: base, storeName: null };
    }
    let prefix = base + "_";
    if (name.indexOf(prefix) === 0 && name.length > prefix.length) {
      return { baseName: base, storeName: name.slice(prefix.length) };
    }
  }
  return null;
};

/** 指示書（元シート or 店舗別シート）の名前か */
const isOrderFormSheetName_ = (sheetName) => {
  let parsed = parseStoreSheetName_(sheetName);
  return !!parsed && parsed.baseName === SHEET_NAMES.ORDER_FORM;
};

/** 予算・実績（元シート or 店舗別シート）の名前か */
const isBudgetActualSheetName_ = (sheetName) => {
  let parsed = parseStoreSheetName_(sheetName);
  return !!parsed && parsed.baseName === SHEET_NAMES.BUDGET_ACTUAL;
};

/**
 * 指定店舗名（null可＝元の固定名シートを使う後方互換モード）で
 * 店舗別運用シート一式を解決する。未作成のシートは null になる（呼び出し側で存在チェックすること）。
 */
const resolveStoreSheetsByStoreName_ = (ss, storeName) => {
  let name = storeName ? String(storeName).trim() : "";
  let suffix = name || null;
  const sheetFor = (base) => {
    let targetName = suffix ? buildStoreSheetName_(base, suffix) : base;
    return ss.getSheetByName(targetName);
  };
  return {
    storeName: suffix,
    budgetSheet: sheetFor(SHEET_NAMES.BUDGET_ACTUAL),
    orderSheet: sheetFor(SHEET_NAMES.ORDER_FORM),
    posRawSheet: sheetFor(SHEET_NAMES.POS_RAW),
    posCleanSheet: sheetFor(SHEET_NAMES.POS_CLEAN),
    backlogSheet: sheetFor(SHEET_NAMES.BACKLOG),
    manualAdjustmentLogSheet: sheetFor(SHEET_NAMES.MANUAL_ADJUSTMENT_LOG),
    forecastDemandLogSheet: sheetFor(SHEET_NAMES.FORECAST_DEMAND_LOG)
  };
};

/**
 * 特定のシートオブジェクト（onEdit の e.range.getSheet() など）から、
 * それが属する店舗の4シート一式を解決する。対象外シートなら null。
 */
const resolveStoreSheetsForSheet_ = (sheet) => {
  if (!sheet) return null;
  let parsed = parseStoreSheetName_(sheet.getName());
  if (!parsed) return null;
  return resolveStoreSheetsByStoreName_(sheet.getParent(), parsed.storeName);
};

/**
 * アクティブシート（メニュー実行時にユーザーが開いているタブ）から店舗の4シートを解決する。
 * 対象外のシート（マスタ・ログシートなど）がアクティブな場合はエラーを投げ、
 * 対象店舗のタブ（予算・実績 / 指示書 / POSデータ_生 / POSデータ_整形後 のいずれか）を
 * 開いてから実行するよう促す。
 */
const resolveStoreSheetsFromActiveSheet_ = (ss) => {
  let spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  let active = spreadsheet.getActiveSheet();
  let result = resolveStoreSheetsForSheet_(active);
  if (!result) {
    throw new Error(
      `対象店舗を判定できません。対象店舗の運用タブ（「${SHEET_NAMES.BUDGET_ACTUAL}」「${SHEET_NAMES.ORDER_FORM}」`
      + `「${SHEET_NAMES.POS_RAW}」「${SHEET_NAMES.POS_CLEAN}」「${SHEET_NAMES.BACKLOG}」`
      + `「${SHEET_NAMES.MANUAL_ADJUSTMENT_LOG}」「${SHEET_NAMES.FORECAST_DEMAND_LOG}」のいずれか）`
      + `を開いてから実行してください（現在アクティブなシート: 「${active ? active.getName() : "(不明)"}」）。`
    );
  }
  return result;
};

/**
 * 予算・実績シートの対象店舗セル（C1見出し/D1プルダウン）を、指定店舗に合わせて整備する。
 * D1の選択肢は全店舗一覧のまま（後日別店舗に付け替えたい場合のため）、値だけ対象店舗に設定する。
 * 既存値がその店舗のままなら上書きしない（手動で他店舗に変更していた場合を尊重）。
 */
const applySmaregiStoreSelectionToSheet_ = (budgetSheet, store, allStores) => {
  if (!budgetSheet || !store) return;
  let options = (allStores || [store]).map((s) => { return `${s.storeId}: ${s.storeName}`; });
  let targetValue = `${store.storeId}: ${store.storeName}`;

  let labelCell = budgetSheet.getRange(SMAREGI_STORE_LABEL_CELL_);
  let dropdownCell = budgetSheet.getRange(SMAREGI_STORE_DROPDOWN_CELL_);
  labelCell.setValue("対象店舗");

  let rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(options, true)
    .setAllowInvalid(false)
    .build();
  dropdownCell.setDataValidation(rule);

  let current = String(dropdownCell.getValue() || "").trim();
  if (current !== targetValue) {
    dropdownCell.setValue(targetValue);
  }
};

/**
 * 1店舗分の店舗別運用シート一式を作成・整備する（既存の店舗別シートがあれば作り直さない）。
 * 新規シートは元の固定名シート（テンプレート）を複製して作る（書式・見出し・入力規則を引き継ぐ）。
 * 注意: 複製時は元シートの「中身（値）」もそのままコピーされる。元シートに入力中の実データが
 * あった場合、複数店舗すべてに同じ値がコピーされるため、各店舗タブの内容は運用開始前に
 * 必ず確認・修正すること（本関数はテンプレートの値を自動では消さない＝安全側に倒した設計）。
 *
 * @param {Spreadsheet} ss
 * @param {{storeId: string, storeName: string}} store 対象店舗
 * @param {Array} allStores D1プルダウンの選択肢に使う全店舗一覧（省略時は store 単独）
 * @return {{storeName: string, createdBases: string[], missingTemplates: string[]}}
 */
const provisionStoreOperationSheets_ = (ss, store, allStores) => {
  let storeName = String((store && store.storeName) || "").trim();
  if (!storeName) {
    return { storeName: "", createdBases: [], missingTemplates: [], skippedNoName: true };
  }

  let createdBases = [];
  let missingTemplates = [];

  STORE_SPLIT_SHEET_BASES_.forEach((base) => {
    let targetName = buildStoreSheetName_(base, storeName);
    let existing = ss.getSheetByName(targetName);
    if (existing) return;

    let template = ss.getSheetByName(base);
    if (!template) {
      missingTemplates.push(base);
      return;
    }

    let newSheet = template.copyTo(ss);
    newSheet.setName(targetName);
    createdBases.push(base);
  });

  let storeSheets = resolveStoreSheetsByStoreName_(ss, storeName);

  if (storeSheets.orderSheet) {
    setupOrderSheetActionControls_(storeSheets.orderSheet);
    setupOrderSheetManualInputArea(storeSheets.orderSheet);
    resetStuckOrderSheetCheckboxIfNeeded_(storeSheets.orderSheet);
  }
  if (storeSheets.budgetSheet) {
    setupBudgetStartDateDropdown_(storeSheets.budgetSheet);
    applySmaregiStoreSelectionToSheet_(storeSheets.budgetSheet, store, allStores || [store]);
  }

  return { storeName: storeName, createdBases: createdBases, missingTemplates: missingTemplates };
};

/**
 * 店舗別運用シート一式を、スマレジの店舗一覧に合わせて全店舗分作成・整備する（メニューから手動実行）。
 * 実体は店舗ごとに `provisionStoreOperationSheets_` を呼ぶだけ。
 */
const setupPerStoreOperationSheets = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let stores = getSmaregiStores_();
  if (!stores || stores.length === 0) {
    notifyUser("スマレジに店舗が1件も見つかりませんでした。");
    return;
  }

  let summaries = [];
  let warnings = [];

  stores.forEach((store) => {
    let result = provisionStoreOperationSheets_(ss, store, stores);
    if (result.skippedNoName) {
      warnings.push(`storeId=${store.storeId} は店舗名が空のためスキップ`);
      return;
    }

    let detail = result.createdBases.length > 0
      ? `新規作成${result.createdBases.length}件(${result.createdBases.join("/")})`
      : "既存シートを整備";
    summaries.push(`${result.storeName}: ${detail}`);
    if (result.missingTemplates.length > 0) {
      warnings.push(`${result.storeName}: テンプレート「${result.missingTemplates.join("/")}」が見つからず未作成`);
    }
  });

  let message = `店舗別シートの整備完了（${stores.length}店舗）\n` + summaries.join("\n");
  if (warnings.length > 0) {
    message += `\n\n[警告]\n` + warnings.join("\n");
  }
  message += `\n\n※新規作成タブには元シートの内容（値）がそのままコピーされています。運用前に各店舗タブの中身を確認してください。`;
  notifyUser(message, "店舗別シート整備");
};

/**
 * シート名が「予算・実績」で始まるが、正式な店舗別命名（元の固定名 or "予算・実績_店舗名"）に
 * 一致しない場合、trueを返す。Googleスプレッドシートの「シートを複製」操作で生成される既定の
 * シート名（例:「予算・実績のコピー」）を検出し、D1で店舗を選んだ際に自動整備する対象を判定するため。
 */
const looksLikeUnassignedBudgetActualCopy_ = (sheetName) => {
  let name = String(sheetName || "");
  let base = SHEET_NAMES.BUDGET_ACTUAL;
  if (name.indexOf(base) !== 0) return false;
  return parseStoreSheetName_(name) === null;
};
