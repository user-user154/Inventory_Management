/**
 * 7. infomart.gs: インフォマート BtoBプラットフォームAPI連携（フェーズ1: 読み取り専用）
 *
 * 目的: 請求書データ・受発注/納品データを店舗ごとに取得し、可視化用のログシートへ書き込む。
 * 発注データの送信（フェーズ2）は社内承認待ちのため本ファイルでは未実装（末尾の拡張ポイント参照）。
 *
 * 認証方式について: インフォマート公式APIリファレンス（認証・認可）に基づき、
 * 「リソースオーナー・パスワード・クレデンシャルズフロー」（POST /api/credentials/access_token、
 * grant_type不要の専用エンドポイント）を採用。ブラウザでの認可操作・コールバックURLの登録が
 * 不要になる代わりに、店舗ごとのPFID（ログインID・パスワード）をスクリプトプロパティに保存する
 * （setInfomartCredentialForStore_）。
 * 取得したアクセストークンにはリフレッシュトークンも付随し、以後は認可コードフローと共通の
 * リフレッシュ処理（POST /openam/oauth2/access_token, grant_type=refresh_token）で更新する。
 * リフレッシュトークンが失効・未取得の場合は自動的にクレデンシャルズフローへフォールバックして
 * 再取得するため、手動での再認可操作は基本的に不要（PFIDのパスワードを変更した場合を除く）。
 *
 * 店舗ごとに異なるのはPFID（ログインID・パスワード）とリフレッシュトークンのみで、
 * client_id/client_secret はAPI利用申請時に会社単位で発行される想定のため全店舗共通。
 * 対象店舗の選択はスマレジ連携と共用で「予算・実績」シート D1
 * （SMAREGI_STORE_DROPDOWN_CELL_、smaregi.gs参照）のプルダウンをそのまま使う。
 *
 * 事前準備（このファイルのコードだけでは完結しない）:
 * 1. Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティに以下を設定（値はコードに書かない）:
 *    - INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET: 全店舗共通のクライアントID/シークレット
 *    - INFOMART_REFRESH_TOKENS / INFOMART_CREDENTIALS: いずれもコードが自動で読み書きするため
 *      手動で用意する必要はない
 * 2. メニュー「発注管理」→「スマレジ店舗一覧を更新」でD1の選択肢を用意し、対象店舗を選択
 * 3. メニュー「発注管理」→「InfomartのPFIDを登録」を実行し、その店舗のPFID・パスワードを登録
 *    （店舗ごとに一度でよいが、PFIDのパスワードを変更した場合は再登録が必要）
 *    ※ ui.prompt はパスワードをマスク表示できないため、入力時は周囲の視認に注意すること
 * 4. constants.gs の INFOMART_CONFIG.useTestEnv でテスト環境/本番環境を切り替える
 * 5. test.js の runDiagnoseInfomart* を Apps Script エディタから実行し、
 *    実データの形状を確認してから本番運用に入る
 *
 * 既知の未確認事項（初回の本番呼び出し前に要確認。詳細はプラン参照）:
 * - 請求書APIの実ホスト（INFOMART_CONFIG.invoiceApiBase の TODO）
 * - 受発注 /check・/get の正確なリクエスト/レスポンス形状
 * - target_date_set（0〜7）の各値が指す日付項目の意味
 * - 非同期ジョブの実際の完了時間（ポーリング間隔・上限回数の妥当性）
 * - リフレッシュトークンの有効期限は31日。使うたびに新しいものへローテーションされるため、
 *   最低でも月1回はいずれかのAPIを呼び出す運用にしておかないと知らないうちに失効しうる
 *   （失効してもPFID・パスワードは保存済みのため、次回呼び出し時に自動でクレデンシャルズ
 *   フローから再取得される）
 *
 * インフォマートAPI共通仕様の注意点: クエリ文字列・ボディ情報中の
 * % ^ * ( ) [ ] < > ' " タブ カンマ は送信時に自動で除去される。
 * 商品名や備考にこれらの文字が含まれる場合、意図せず文字が消える可能性がある。
 */

const INFOMART_INVOICE_LOG_HEADERS_ = [
  "取得日", "店舗", "送信日", "請求書管理番号", "請求書No", "支払期日", "締日", "請求金額",
  "取引先名", "取引先電話番号", "取引先住所", "発行者名", "明細品目名", "明細金額", "明細消費税"
];

const INFOMART_ORDER_DELIVERY_LOG_HEADERS_ = [
  "取得日", "店舗", "対象範囲", "対象日", "発注番号", "商品コード", "商品名", "数量", "単価", "金額",
  "納品予定日", "取引先名", "ステータス"
];

/** 店舗ごとのリフレッシュトークンをまとめて持つスクリプトプロパティ（店舗名→リフレッシュトークン文字列） */
const INFOMART_REFRESH_TOKENS_PROP_ = "INFOMART_REFRESH_TOKENS";

/** 店舗ごとのPFID（ログインID・パスワード）をまとめて持つスクリプトプロパティ
 *  （店舗名→{userId, userPassword}のJSONマップ。クレデンシャルズフローの初回取得・再ブートストラップに使う） */
const INFOMART_CREDENTIALS_PROP_ = "INFOMART_CREDENTIALS";

/** タイムアウトしたバッチジョブのIDを店舗ごとに一時保存するスクリプトプロパティのプレフィックス（次回実行時の再確認用） */
const INFOMART_ORDER_LAST_BATCH_ID_PROP_PREFIX_ = "INFOMART_ORDER_LAST_BATCH_ID_";

/** スクリプトプロパティから全店舗共通のクライアントID/シークレットを読む（未設定ならエラー） */
const getInfomartClientCredentials_ = () => {
  let props = PropertiesService.getScriptProperties();
  let clientId = props.getProperty("INFOMART_CLIENT_ID");
  let clientSecret = props.getProperty("INFOMART_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "スクリプトプロパティに INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET が設定されていません。"
      + "プロジェクトの設定 → スクリプトプロパティ から登録してください。"
    );
  }
  return { clientId: clientId, clientSecret: clientSecret };
};

/** スクリプトプロパティから店舗別リフレッシュトークンマップを読む（未設定なら空マップ扱い） */
const getInfomartRefreshTokenMap_ = () => {
  let raw = PropertiesService.getScriptProperties().getProperty(INFOMART_REFRESH_TOKENS_PROP_);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${INFOMART_REFRESH_TOKENS_PROP_} のJSON形式が不正です: ${err.message}`);
  }
};

/** 指定店舗のリフレッシュトークンを保存（ローテーション対応。初回取得時・再発行時どちらでも呼ぶ） */
const setInfomartRefreshTokenForStore_ = (storeName, refreshToken) => {
  let map = getInfomartRefreshTokenMap_();
  map[storeName] = refreshToken;
  PropertiesService.getScriptProperties().setProperty(INFOMART_REFRESH_TOKENS_PROP_, JSON.stringify(map));
};

/** スクリプトプロパティから店舗別PFID（ログインID・パスワード）マップを読む（未設定なら空マップ扱い） */
const getInfomartCredentialMap_ = () => {
  let raw = PropertiesService.getScriptProperties().getProperty(INFOMART_CREDENTIALS_PROP_);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${INFOMART_CREDENTIALS_PROP_} のJSON形式が不正です: ${err.message}`);
  }
};

/** 指定店舗のPFID（ログインID・パスワード）を取得（未登録ならメニューでの登録を促すエラー） */
const getInfomartCredentialForStore_ = (storeName) => {
  let map = getInfomartCredentialMap_();
  let cred = map[storeName];
  if (!cred || !cred.userId || !cred.userPassword) {
    throw new Error(
      `店舗「${storeName}」はまだインフォマートのPFIDが登録されていません。`
      + "メニュー「発注管理」→「InfomartのPFIDを登録」から登録してください。"
    );
  }
  return cred;
};

/** 指定店舗のPFID（ログインID・パスワード）を保存 */
const setInfomartCredentialForStore_ = (storeName, userId, userPassword) => {
  let map = getInfomartCredentialMap_();
  map[storeName] = { userId: userId, userPassword: userPassword };
  PropertiesService.getScriptProperties().setProperty(INFOMART_CREDENTIALS_PROP_, JSON.stringify(map));
};

/**
 * 「予算・実績」D1（スマレジ店舗選択と共用、smaregi.gsのparseSmaregiStoreCellValue_で解析）から
 * 対象店舗名を解決する。D1が未選択、またはその店舗のPFIDがまだ登録されていない場合はエラー。
 */
const resolveSelectedInfomartStoreName_ = (budgetSheet) => {
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  // PFID登録済みかどうかを先に検証しておく（未登録の店舗名でトークン取得に進んでしまうのを防ぐ）
  getInfomartCredentialForStore_(store.storeName);
  return store.storeName;
};

const infomartAuthBase_ = () => {
  return INFOMART_CONFIG.useTestEnv ? INFOMART_CONFIG.authBaseTest : INFOMART_CONFIG.authBaseProd;
};

/**
 * 「予算・実績」D1で選択中の店舗のPFID（ログインID・パスワード）を登録する（メニューから実行）
 * 店舗ごとに一度でよいが、PFIDのパスワードを変更した場合は再登録が必要。
 * ui.prompt はマスク入力に対応していないため、周囲に見られない環境で入力すること。
 */
const promptInfomartCredentialRegistration = () => {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  let ui = SpreadsheetApp.getUi();

  let idRes = ui.prompt(
    "InfomartのPFIDを登録",
    `店舗「${store.storeName}」のPFID（ログインID）を入力してください。`,
    ui.ButtonSet.OK_CANCEL
  );
  if (idRes.getSelectedButton() !== ui.Button.OK) return;
  let userId = String(idRes.getResponseText() || "").trim();
  if (!userId) {
    ui.alert("PFIDが空のため登録を中止しました。");
    return;
  }

  let pwRes = ui.prompt(
    "InfomartのPFIDを登録",
    `店舗「${store.storeName}」のパスワードを入力してください。\n（入力内容はマスクされません。周囲にご注意ください）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (pwRes.getSelectedButton() !== ui.Button.OK) return;
  let userPassword = String(pwRes.getResponseText() || "").trim();
  if (!userPassword) {
    ui.alert("パスワードが空のため登録を中止しました。");
    return;
  }

  setInfomartCredentialForStore_(store.storeName, userId, userPassword);
  ui.alert(`店舗「${store.storeName}」のPFIDを登録しました。`);
};

/**
 * クレデンシャルズフローでアクセストークンを新規発行する（PFIDのuser_id/user_passwordを直接POST）
 * リフレッシュトークンが無い初回、またはリフレッシュトークンが失効した場合のフォールバックとして使う。
 */
const fetchInfomartAccessTokenViaCredentials_ = (storeName) => {
  let clientCred = getInfomartClientCredentials_();
  let cred = getInfomartCredentialForStore_(storeName);

  let res = UrlFetchApp.fetch(`${infomartAuthBase_()}/api/credentials/access_token`, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      user_id: cred.userId,
      user_password: cred.userPassword,
      client_id: clientCred.clientId,
      client_secret: clientCred.clientSecret,
      realm: INFOMART_CONFIG.realm,
      response_type: "json"
    },
    muteHttpExceptions: true
  });

  let code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(
      `インフォマート クレデンシャルズフローでのアクセストークン取得失敗 [店舗=${storeName}] `
      + `status=${code} body=${res.getContentText().slice(0, 500)}\n`
      + "登録済みのPFID・パスワードが正しいか確認してください（メニュー「InfomartのPFIDを登録」で再登録可能）。"
    );
  }
  return JSON.parse(res.getContentText());
};

/**
 * リフレッシュトークンを使ってアクセストークンを再発行する（失敗時はnullを返し、
 * 呼び出し元でクレデンシャルズフローへのフォールバックを行わせる）
 */
const refreshInfomartAccessTokenWithToken_ = (refreshToken, storeName) => {
  let clientCred = getInfomartClientCredentials_();
  let res = UrlFetchApp.fetch(`${infomartAuthBase_()}/openam/oauth2/access_token?realm=${encodeURIComponent(INFOMART_CONFIG.realm)}`, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientCred.clientId,
      client_secret: clientCred.clientSecret,
      response_type: "json"
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log(`[Infomart] 店舗=${storeName} リフレッシュトークンでの再発行に失敗。クレデンシャルズフローへフォールバックします。status=${res.getResponseCode()} body=${res.getContentText().slice(0, 300)}`);
    return null;
  }
  return JSON.parse(res.getContentText());
};

/**
 * 店舗別のアクセストークンを取得（有効期限-60秒でキャッシュ）
 * 既にリフレッシュトークンがあればそれで再発行し、無い（または失効して再発行に失敗した）場合は
 * 登録済みのPFID・パスワードを使ったクレデンシャルズフローで新規取得する。
 * どちらの経路でも、取得のたびにリフレッシュトークンがローテーションされるため必ず保存し直す。
 */
const getInfomartAccessToken_ = (storeName) => {
  let cache = CacheService.getScriptCache();
  let cacheKey = "infomart_token_" + storeName;
  let cached = cache.get(cacheKey);
  if (cached) return cached;

  let refreshToken = getInfomartRefreshTokenMap_()[storeName];
  let json = refreshToken ? refreshInfomartAccessTokenWithToken_(refreshToken, storeName) : null;
  if (!json) {
    json = fetchInfomartAccessTokenViaCredentials_(storeName);
  }

  let accessToken = json.access_token;
  let expiresIn = Number(json.expires_in) || 300;
  setInfomartRefreshTokenForStore_(storeName, json.refresh_token); // ローテーションされた新しいリフレッシュトークンを保存
  cache.put(cacheKey, accessToken, Math.max(60, expiresIn - 60));
  rememberApiTokenCacheKey_(cacheKey);
  return accessToken;
};

/**
 * インフォマート各APIへの共通POSTヘルパー（店舗別トークンを使用）
 * response_type はボディに強制付与し、非200 or error_list に要素がある場合は例外を投げる
 */
const infomartApiPost_ = (url, bodyParams, storeName) => {
  let token = getInfomartAccessToken_(storeName);
  let body = Object.assign({ response_type: "json" }, bodyParams || {});

  let res = UrlFetchApp.fetch(url, {
    method: "post",
    headers: { Authorization: `Bearer ${token}` },
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  let code = res.getResponseCode();
  let text = res.getContentText();
  if (code !== 200) {
    throw new Error(`インフォマートAPI失敗 [${url} 店舗=${storeName}] status=${code} body=${text.slice(0, 500)}`);
  }

  let json = text ? JSON.parse(text) : {};
  if (Array.isArray(json.error_list) && json.error_list.length > 0) {
    throw new Error(`インフォマートAPIエラー [${url} 店舗=${storeName}] ${JSON.stringify(json.error_list).slice(0, 500)}`);
  }
  return json;
};

// ---------------------------------------------------------------------------
// 請求書（読み取り）
// ---------------------------------------------------------------------------

/** 指定店舗・指定日に受け取った請求書を検索取得（ページング対応） */
const fetchInfomartInvoicesForDate_ = (dateStr, storeName) => {
  return fetchInfomartInvoicesForDateRange_(dateStr, dateStr, storeName);
};

/**
 * 指定店舗・指定期間（reception_date_from〜reception_date_to、受取日基準）に受け取った
 * 請求書を検索取得（ページング対応）。fetchInfomartInvoicesForDate_ の日付範囲版。
 * 親アカウント運用時に複数店舗ぶんのデータが混在して返ってきていないかをまとめて確認する
 * 診断用途（diagnoseInfomartStoreScope_）でも使う。
 *
 * 注意: 以前は /wi/v2/seller/invoice/search（発行請求書＝自社が発行する側、有料の発行プランが
 * 必要）を呼んでいたが、"本機能は発行有料企業のみ利用可能です"(403/E100001)で失敗した。
 * 当店は仕入先から請求書を受け取る側（買い手）なので、正しくは受取請求書側の
 * POST /wi/v2/buyer/invoice/search（「請求データ取得」API）を使う。パラメータ名・
 * レスポンスの配列キー（invoice_list→invdata）も発行側とは異なる。
 */
const fetchInfomartInvoicesForDateRange_ = (dateFrom, dateTo, storeName) => {
  let url = `${INFOMART_CONFIG.invoiceApiBase}/wi/v2/buyer/invoice/search`;
  let invoices = [];
  let getCount = 99;
  let maxPages = 50; // 安全弁（想定外の応答形式での無限ループを防ぐ）

  for (let page = 0; page < maxPages; page++) {
    let startPosition = page * getCount + 1;
    let json = infomartApiPost_(url, {
      reception_date_from: dateFrom,
      reception_date_to: dateTo,
      start_position: startPosition,
      get_count: getCount
    }, storeName);
    let pageInvoices = Array.isArray(json.invdata) ? json.invdata : [];
    if (pageInvoices.length === 0) break;
    invoices = invoices.concat(pageInvoices);
    if (pageInvoices.length < getCount) break;
  }
  return invoices;
};

/** Infomart請求書ログの見出しを用意（無ければ新規シート作成、ズレていれば書き直す） */
const ensureInfomartInvoiceLogSheet_ = (ss) => {
  let sheet = ss.getSheetByName(SHEET_NAMES.INFOMART_INVOICE_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.INFOMART_INVOICE_LOG);
    Logger.log(`[Infomart] シート「${SHEET_NAMES.INFOMART_INVOICE_LOG}」を新規作成`);
  }
  let currentHeaders = sheet.getRange(1, 1, 1, INFOMART_INVOICE_LOG_HEADERS_.length).getValues()[0]
    .map((v) => { return String(v == null ? "" : v).trim(); });
  let matches = INFOMART_INVOICE_LOG_HEADERS_.every((h, i) => { return currentHeaders[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, INFOMART_INVOICE_LOG_HEADERS_.length).setValues([INFOMART_INVOICE_LOG_HEADERS_]);
    Logger.log(`[Infomart] 「${SHEET_NAMES.INFOMART_INVOICE_LOG}」の見出し行を更新しました`);
  }
  return sheet;
};

/** 指定店舗・送信日の既存行を削除し、取得済み行に置き換える（同店舗同日の再取得は上書き。他は保持） */
const writeInfomartInvoiceLogForDate_ = (sheet, dateStr, storeName, rows) => {
  let lastRow = sheet.getLastRow();
  let keptRows = [];
  if (lastRow >= 2) {
    let existing = sheet.getRange(2, 1, lastRow - 1, INFOMART_INVOICE_LOG_HEADERS_.length).getValues();
    keptRows = existing.filter((row) => {
      return !(formatSheetDateToKey(row[2]) === dateStr && String(row[1]) === String(storeName));
    });
  }

  let today = formatJstDate_(new Date());
  let newRows = rows.map((r) => {
    return [
      today, storeName, dateStr, r.invoice_mng_num, r.inv_no, r.pay_due_date, r.close_date, r.inv_amount,
      r.customer_company_name, r.customer_phone, r.customer_address, r.publisher_company_name,
      r.item_name, r.item_amount, r.item_tax
    ];
  });
  let allRows = keptRows.concat(newRows);

  let clearRows = Math.max(lastRow - 1, allRows.length);
  if (clearRows > 0) {
    sheet.getRange(2, 1, clearRows, INFOMART_INVOICE_LOG_HEADERS_.length).clearContent();
  }
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, INFOMART_INVOICE_LOG_HEADERS_.length).setValues(allRows);
  }
};

/** 請求書1件を「明細1行=1行」に展開する（明細が無い請求書は明細列を空欄にして1行にする） */
/**
 * 未検証・要修正: この関数は旧・発行側API（/wi/v2/seller/invoice/search）のレスポンス形状
 * （invoice.customer / invoice.publisher オブジェクト）を前提にしたマッピングのままで、
 * 現在使っている受取側API（/wi/v2/buyer/invoice/search）の "invdata[]" 要素の実際の形状は
 * まだ確認できていない（request_type一覧に company_name_s / burden_sec_code 等が見えるのみで
 * response側のフィールド名は未公開）。runDiagnoseInfomartInvoices・
 * runDiagnoseInfomartStoreScope で生JSONを確認してから、このマッピングを実データに合わせて
 * 書き直すこと。現状のままだと本番取込（importInfomartInvoicesForDate_）は空欄だらけの行を
 * 書き込む可能性が高い。
 */
const flattenInfomartInvoiceToRows_ = (invoice) => {
  let customer = invoice.customer || {};
  let publisher = invoice.publisher || {};
  let base = {
    invoice_mng_num: invoice.invoice_mng_num,
    inv_no: invoice.inv_no,
    pay_due_date: invoice.pay_due_date,
    close_date: invoice.close_date,
    inv_amount: invoice.inv_amount,
    customer_company_name: customer.customer_company_name,
    customer_phone: customer.customer_phone,
    customer_address: [customer.customer_address1, customer.customer_address2].filter(Boolean).join(" "),
    publisher_company_name: publisher.publisher_company_name
  };
  let details = Array.isArray(invoice.details) ? invoice.details : [];
  if (details.length === 0) {
    return [Object.assign({ item_name: "", item_amount: "", item_tax: "" }, base)];
  }
  return details.map((d) => {
    return Object.assign({ item_name: d.item_name, item_amount: d.item_amount, item_tax: d.item_tax }, base);
  });
};

/** 指定店舗・指定日の請求書を取得してログシートへ書込み（フェーズ1のメイン導線） */
const importInfomartInvoicesForDate_ = (dateStr, storeName) => {
  let invoices = fetchInfomartInvoicesForDate_(dateStr, storeName);
  let rows = [];
  invoices.forEach((invoice) => { rows = rows.concat(flattenInfomartInvoiceToRows_(invoice)); });

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ensureInfomartInvoiceLogSheet_(ss);
  writeInfomartInvoiceLogForDate_(sheet, dateStr, storeName, rows);

  notifyUser(`Infomart請求書取込完了 [${storeName} / ${dateStr}]: 請求書${invoices.length}件 / 明細${rows.length}行`);
  return { dateStr: dateStr, storeName: storeName, invoiceCount: invoices.length, rowCount: rows.length };
};

/** 当日分を取得（メニューからの手動実行用。対象店舗は予算・実績 D1 の選択に従う） */
const runInfomartInvoiceImportToday = () => {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let storeName = resolveSelectedInfomartStoreName_(budgetSheet);
  importInfomartInvoicesForDate_(formatJstDate_(new Date()), storeName);
};

/** 日付を指定して手動取得（空欄なら本日、対象店舗は予算・実績 D1 の選択に従う） */
const promptAndImportInfomartInvoices = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let storeName = resolveSelectedInfomartStoreName_(budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());
  let res = ui.prompt(
    "Infomart請求書取得",
    `対象店舗: ${storeName}\n対象日を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let input = String(res.getResponseText() || "").trim();
  let dateStr = input || today;
  if (isNaN(new Date(`${dateStr}T12:00:00`).getTime())) {
    ui.alert(`日付の形式が正しくありません: ${input}`);
    return;
  }
  importInfomartInvoicesForDate_(dateStr, storeName);
};

// ---------------------------------------------------------------------------
// 受発注・納品データ（読み取り、非同期ジョブ: request → check → get）
// ---------------------------------------------------------------------------

/**
 * 取引データダウンロードを依頼（非同期ジョブの開始）
 * memberCodes: 「自社会員システムコード」(member_codes、半角8桁)。このAPIでは未指定時「全て」扱いの
 * はずだが、実際に日次発注しているアカウントでも0件が続いたため切り分け用に明示指定できるようにした。
 * statusSet: 「伝票種別」(status_set)。未指定時は「0:通常＋仕入伝票」扱いになり、承認待ちの
 * 「3:申請発注」「4:発注予定」等は対象外になる。record_countが0件続きの切り分け用に追加。
 */
const requestInfomartOrderDeliveryExtract_ = (dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes, statusSet) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/request`;
  let body = {
    target_date_set: targetDateSet,
    target_date_from: dateFrom,
    target_date_to: dateTo
  };
  if (statusCodes && statusCodes.length > 0) body.status_code = statusCodes;
  if (memberCodes && memberCodes.length > 0) body.member_codes = memberCodes;
  if (statusSet != null) body.status_set = statusSet;
  let json = infomartApiPost_(url, body, storeName);
  return { requestId: json.request_id, batchId: json.batch_id };
};

/** ジョブの状態を1回確認する（成功時のレスポンスは request_id/result/error_list/batch_flg/record_count） */
const checkInfomartOrderDeliveryBatch_ = (batchId, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/check`;
  return infomartApiPost_(url, { batch_id: batchId }, storeName);
};

/**
 * 完了したジョブの結果データを取得する（連番範囲 seq_from/seq_to は必須。1回の取得件数に上限が
 * ある前提でページングする想定のため、この関数は1ページぶんだけを返す）
 */
const getInfomartOrderDeliveryResult_ = (batchId, seqFrom, seqTo, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/get`;
  return infomartApiPost_(
    url,
    { response_type: "json", batch_id: batchId, seq_from: String(seqFrom), seq_to: String(seqTo) },
    storeName
  );
};

/**
 * ジョブの完了を同一関数内で短時間ポーリングする（GAS実行時間上限[約6分]に対し十分余裕を持たせる）
 * 「準備完了」判定は check レスポンスの result==="0"（かつ status系フィールドは存在しないため
 * その他の判定条件は付けない）で行う。record_count（対象件数）もここで取得できる。
 */
const pollInfomartOrderDeliveryUntilReady_ = (batchId, storeName) => {
  let maxAttempts = 15;
  let intervalMs = 2000;
  let deadline = Date.now() + 60 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) break;
    let status = checkInfomartOrderDeliveryBatch_(batchId, storeName);
    Logger.log(`[Infomart受発注] 店舗=${storeName} batch_id=${batchId} check#${attempt}: ${JSON.stringify(status).slice(0, 500)}`);
    if (status && String(status.result) === "0") {
      return status;
    }
    Utilities.sleep(intervalMs);
  }

  let props = PropertiesService.getScriptProperties();
  props.setProperty(INFOMART_ORDER_LAST_BATCH_ID_PROP_PREFIX_ + storeName, batchId);
  throw new Error(
    `Infomart受発注データの準備が時間内に完了しませんでした（店舗=${storeName} batch_id=${batchId}）。`
    + "1分ほど待ってから再実行してください。"
  );
};

/**
 * request → poll(record_count取得) → get(seq_from/seq_toで連番指定・ページング) のオーケストレーション
 * 未検証: 1回のget呼び出しで取得できる最大件数（他の受発注系API「取引不可日設定取得」の
 * 記載に1000件上限とあったため、同じ上限を仮定してページングしている）
 */
const fetchInfomartOrderDeliveryTrades_ = (dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes) => {
  let { batchId } = requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes);
  let status = pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
  let recordCount = Number(status.record_count) || 0;
  if (recordCount === 0) return [];

  let pageSize = 1000; // 仮定値（要検証。他の受発注系get APIの上限記載に準拠）
  let trades = [];
  for (let seqFrom = 1; seqFrom <= recordCount; seqFrom += pageSize) {
    let seqTo = Math.min(seqFrom + pageSize - 1, recordCount);
    let result = getInfomartOrderDeliveryResult_(batchId, seqFrom, seqTo, storeName);
    let pageTrades = Array.isArray(result.trade) ? result.trade : [];
    trades = trades.concat(pageTrades);
  }
  return trades;
};

/** Infomart受発注ログの見出しを用意（無ければ新規シート作成、ズレていれば書き直す） */
const ensureInfomartOrderDeliveryLogSheet_ = (ss) => {
  let sheet = ss.getSheetByName(SHEET_NAMES.INFOMART_ORDER_DELIVERY_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.INFOMART_ORDER_DELIVERY_LOG);
    Logger.log(`[Infomart] シート「${SHEET_NAMES.INFOMART_ORDER_DELIVERY_LOG}」を新規作成`);
  }
  let currentHeaders = sheet.getRange(1, 1, 1, INFOMART_ORDER_DELIVERY_LOG_HEADERS_.length).getValues()[0]
    .map((v) => { return String(v == null ? "" : v).trim(); });
  let matches = INFOMART_ORDER_DELIVERY_LOG_HEADERS_.every((h, i) => { return currentHeaders[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, INFOMART_ORDER_DELIVERY_LOG_HEADERS_.length).setValues([INFOMART_ORDER_DELIVERY_LOG_HEADERS_]);
    Logger.log(`[Infomart] 「${SHEET_NAMES.INFOMART_ORDER_DELIVERY_LOG}」の見出し行を更新しました`);
  }
  return sheet;
};

/** 指定店舗・範囲キーの既存行を削除し、取得済み行に置き換える（同店舗同一範囲の再取得は上書き。他は保持） */
const writeInfomartOrderDeliveryLogForRange_ = (sheet, rangeKey, storeName, rows) => {
  let lastRow = sheet.getLastRow();
  let keptRows = [];
  if (lastRow >= 2) {
    let existing = sheet.getRange(2, 1, lastRow - 1, INFOMART_ORDER_DELIVERY_LOG_HEADERS_.length).getValues();
    keptRows = existing.filter((row) => {
      return !(String(row[2]) === rangeKey && String(row[1]) === String(storeName));
    });
  }

  let today = formatJstDate_(new Date());
  let newRows = rows.map((r) => {
    return [
      today, storeName, rangeKey, r.target_date, r.order_no, r.item_code, r.item_name, r.quantity, r.unit_price,
      r.amount, r.delivery_scheduled_date, r.customer_company_name, r.status
    ];
  });
  let allRows = keptRows.concat(newRows);

  let clearRows = Math.max(lastRow - 1, allRows.length);
  if (clearRows > 0) {
    sheet.getRange(2, 1, clearRows, INFOMART_ORDER_DELIVERY_LOG_HEADERS_.length).clearContent();
  }
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, INFOMART_ORDER_DELIVERY_LOG_HEADERS_.length).setValues(allRows);
  }
};

/** 指定範囲の受発注・納品データを取得してログシートへ書込み（フェーズ1のメイン導線） */
const importInfomartOrderDeliveryForDateRange_ = (dateFrom, dateTo, storeName) => {
  // target_date_set: [0:更新日 1:伝票日 2:発注日 3:発送予定日 4:発送日 5:納品日 6:受領日 7:送信日]（ord_api_reference.htmlで確認済み）
  // TODO: 「受発注・納品データ」として何を主軸に取り込みたいか（発注日ベースか納品日ベースか）は
  // 運用側の意図次第のため、実データ確認後に業務要件に合わせて選び直すこと。現状は暫定で0のまま。
  let targetDateSet = 0;
  let trades = fetchInfomartOrderDeliveryTrades_(dateFrom, dateTo, targetDateSet, null, storeName);

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ensureInfomartOrderDeliveryLogSheet_(ss);
  let rangeKey = `${dateFrom}〜${dateTo}`;
  writeInfomartOrderDeliveryLogForRange_(sheet, rangeKey, storeName, trades);

  notifyUser(`Infomart受発注データ取込完了 [${storeName} / ${rangeKey}]: ${trades.length}行`);
  return { rangeKey: rangeKey, storeName: storeName, rowCount: trades.length };
};

/** 日付範囲を指定して手動取得（対象店舗は予算・実績 D1 の選択に従う） */
const promptAndImportInfomartOrderDelivery = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let storeName = resolveSelectedInfomartStoreName_(budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());
  let res = ui.prompt(
    "Infomart受発注データ取得",
    `対象店舗: ${storeName}\n対象範囲を "yyyy-MM-dd,yyyy-MM-dd"（開始日,終了日）で入力してください（空欄なら本日 ${today} 1日分）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let input = String(res.getResponseText() || "").trim();
  let dateFrom = today;
  let dateTo = today;
  if (input) {
    let parts = input.split(",").map((s) => { return s.trim(); });
    if (parts.length !== 2 || isNaN(new Date(`${parts[0]}T12:00:00`).getTime()) || isNaN(new Date(`${parts[1]}T12:00:00`).getTime())) {
      ui.alert(`日付範囲の形式が正しくありません: ${input}`);
      return;
    }
    dateFrom = parts[0];
    dateTo = parts[1];
  }
  importInfomartOrderDeliveryForDateRange_(dateFrom, dateTo, storeName);
};

/* 拡張ポイント（未実装・社内承認待ち）:
 * 発注データをインフォマートへ送信する sendInfomartPurchaseOrder_(...) をここに追加する。
 * 2021/6/7追加とされる「発注データアップロードAPI」の詳細仕様を別途確認してから着手すること。
 */
