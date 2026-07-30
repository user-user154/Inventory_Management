/**
 * 8. storeSheets.gs: 店舗別シート（予算・実績 / 指示書 / POSデータ_生 / POSデータ_整形後）の
 * 命名規則・解決・作成
 *
 * 背景: 複数店舗を1つのスプレッドシート＋1つのスクリプトプロジェクトで運用するため
 * （スクリプトプロパティ POS_CLIENT_ID 等はファイルコピーでは引き継がれないため、
 * ファイル分割ではなくシート分割を採用）、店舗ごとの運用4シートを
 * 「元の名前_店舗名」（例: 予算・実績_渋谷店）という命名規則で複製する。
 *
 * 元の固定名シート（例: 予算・実績）はテンプレート/ひな形として残し、削除・改名はしない
 * （既存データを壊さないため）。店舗別シート未作成の状態でも、元の固定名シートで
 * 従来どおり動作する（storeName が null のときは元の名前をそのまま使う後方互換）。
 *
 * 対象外（分割しない・共有のまま）: レシピ表・中間レシピ表・原材料マスタ・歩留まりマスタ・
 * 名寄せマスタ・発注業者マスタ・棚卸し表（マスタ系）、実績出数ログ（既にstoreId列で対応済み）、
 * 確定指示ログ・AI予測手動調整ログ・バックログ・予測出数ログ・Infomart請求書ログ・
 * Infomart受発注ログ（ログ系。店舗単位で分けるべきという意見もあるが、今回のスコープでは
 * 変更しない。日付のみで行を置換するロジックのため、複数店舗が同日に運用すると
 * 互いの行を上書きする可能性がある点は要注意 — 詳細はコミットメッセージ・引継ぎ資料参照）。
 */

/** 店舗別に分割する4シートのベース名（constants.gs の SHEET_NAMES を参照） */
const STORE_SPLIT_SHEET_BASES_ = [
  SHEET_NAMES.BUDGET_ACTUAL,
  SHEET_NAMES.ORDER_FORM,
  SHEET_NAMES.POS_RAW,
  SHEET_NAMES.POS_CLEAN
];

/** 店舗別シート名を組み立てる（例: "予算・実績" + "渋谷店" → "予算・実績_渋谷店"） */
const buildStoreSheetName_ = (baseName, storeName) => {
  return `${baseName}_${storeName}`;
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
 * 4シートを解決する。未作成のシートは null になる（呼び出し側で存在チェックすること）。
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
    posCleanSheet: sheetFor(SHEET_NAMES.POS_CLEAN)
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
      `対象店舗を判定できません。対象店舗の「${SHEET_NAMES.BUDGET_ACTUAL}」「${SHEET_NAMES.ORDER_FORM}」`
      + `「${SHEET_NAMES.POS_RAW}」「${SHEET_NAMES.POS_CLEAN}」いずれかのタブを開いてから実行してください`
      + `（現在アクティブなシート: 「${active ? active.getName() : "(不明)"}」）。`
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
 * 店舗別運用シート（予算・実績 / 指示書 / POSデータ_生 / POSデータ_整形後）を
 * スマレジの店舗一覧に合わせて作成・整備する（メニューから手動実行）。
 *
 * 既存の店舗別シートがあれば作り直さない（データを消さない）。
 * 新規シートは元の固定名シート（テンプレート）を複製して作る（書式・見出し・入力規則を引き継ぐ）。
 * 注意: 複製時は元シートの「中身（値）」もそのままコピーされる。元シートに入力中の実データが
 * あった場合、複数店舗すべてに同じ値がコピーされるため、各店舗タブの内容は運用開始前に
 * 必ず確認・修正すること（本関数はテンプレートの値を自動では消さない＝安全側に倒した設計）。
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
    let storeName = String(store.storeName || "").trim();
    if (!storeName) {
      warnings.push(`storeId=${store.storeId} は店舗名が空のためスキップ`);
      return;
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
      clearLegacySheetTriggerCheckboxes_(storeSheets.orderSheet);
    }
    if (storeSheets.budgetSheet) {
      clearLegacySheetTriggerCheckboxes_(storeSheets.budgetSheet);
      setupBudgetStartDateDropdown_(storeSheets.budgetSheet);
      applySmaregiStoreSelectionToSheet_(storeSheets.budgetSheet, store, stores);
    }

    let detail = createdBases.length > 0 ? `新規作成${createdBases.length}件(${createdBases.join("/")})` : "既存シートを整備";
    summaries.push(`${storeName}: ${detail}`);
    if (missingTemplates.length > 0) {
      warnings.push(`${storeName}: テンプレート「${missingTemplates.join("/")}」が見つからず未作成`);
    }
  });

  let message = `店舗別シートの整備完了（${stores.length}店舗）\n` + summaries.join("\n");
  if (warnings.length > 0) {
    message += `\n\n[警告]\n` + warnings.join("\n");
  }
  message += `\n\n※新規作成タブには元シートの内容（値）がそのままコピーされています。運用前に各店舗タブの中身を確認してください。`;
  notifyUser(message, "店舗別シート整備");
};
