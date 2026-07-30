/**
 * 7. infomart.gs: インフォマート BtoBプラットフォームAPI連携（フェーズ1: 読み取り専用）
 *
 * 目的: 請求書データ・受発注/納品データを店舗ごとに取得し、可視化用のログシートへ書き込む。
 * 発注データの送信（フェーズ2）は社内承認待ちのため本ファイルでは未実装（末尾の拡張ポイント参照）。
 *
 * 認証方式について: インフォマート公式の「OAuth2.0 認証手順」PDFで確認したところ、
 * 存在するのは①ブラウザでPFID（ログインID）・パスワードを直接入力する「認可コードフロー」と、
 * ②その結果得られるリフレッシュトークンでアクセストークンを再発行する方式の2つのみ。
 * user_id/user_passwordを直接POSTする「クレデンシャルズフロー」は存在しない（過去にそれで
 * 実装し401エラーになったため、正式な認可コードフローに作り直した経緯がある）。
 * そのため「ログインID・パスワードをこのシステムが保存する」ことは無く、店舗ごとに一度だけ
 * ブラウザで認可し、以後はリフレッシュトークン（使うたびにローテーションする）で運用する。
 *
 * 店舗ごとに異なるのはこのリフレッシュトークンのみで、client_id/client_secret はAPI利用申請時に
 * 会社単位で発行される想定のため全店舗共通。対象店舗の選択はスマレジ連携と共用で「予算・実績」
 * シート D1（SMAREGI_STORE_DROPDOWN_CELL_、smaregi.gs参照）のプルダウンをそのまま使う。
 *
 * 事前準備（このファイルのコードだけでは完結しない）:
 * 1. Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティに以下を設定（値はコードに書かない）:
 *    - INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET: 全店舗共通のクライアントID/シークレット
 *    - INFOMART_REDIRECT_URI: 下記2で発行するWebアプリのURL（.../exec）
 *    - INFOMART_REFRESH_TOKENS: 店舗ごとの認可完了後、doGet()が自動で書き込む
 *      （店舗名→リフレッシュトークンのJSONマップ。手動で用意する必要はない）
 * 2. Apps Script エディタ →「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、
 *    実行ユーザー「自分」、アクセスできるユーザー「全員」でデプロイし、発行されたURLを
 *    INFOMART_REDIRECT_URI に設定する（clasp push だけではこのURLは変わらない）。
 * 3. そのURLを、インフォマートの契約担当窓口・API申請の担当者に連絡し、
 *    コールバックURL（redirect_uri）として登録してもらう（未登録の場合は新規登録依頼が必要）。
 * 4. メニュー「発注管理」→「スマレジ店舗一覧を更新」でD1の選択肢を用意し、対象店舗を選択
 * 5. メニュー「発注管理」→「Infomart認可URLを発行」を実行し、表示されたリンクをクリックして
 *    その店舗のPFID・パスワードでログイン（店舗ごとに一度だけ必要）
 * 6. constants.gs の INFOMART_CONFIG.useTestEnv でテスト環境/本番環境を切り替える
 * 7. test.js の runDiagnoseInfomart* を Apps Script エディタから実行し、
 *    実データの形状を確認してから本番運用に入る
 *
 * 既知の未確認事項（初回の本番呼び出し前に要確認。詳細はプラン参照）:
 * - 請求書APIの実ホスト（INFOMART_CONFIG.invoiceApiBase の TODO）
 * - 受発注 /check・/get の正確なリクエスト/レスポンス形状
 * - target_date_set（0〜7）の各値が指す日付項目の意味
 * - 非同期ジョブの実際の完了時間（ポーリング間隔・上限回数の妥当性）
 * - リフレッシュトークンの有効期限は31日。使うたびに新しいものへローテーションされるため、
 *   最低でも月1回はいずれかのAPIを呼び出す運用にしておかないと知らないうちに失効しうる
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

/** タイムアウトしたバッチジョブのIDを店舗ごとに一時保存するスクリプトプロパティのプレフィックス（次回実行時の再確認用） */
const INFOMART_ORDER_LAST_BATCH_ID_PROP_PREFIX_ = "INFOMART_ORDER_LAST_BATCH_ID_";

/** OAuth2.0で要求する固定スコープ（インフォマートAPIを利用する場合は固定値） */
const INFOMART_OAUTH_SCOPE_ = "openid profile email qualified";

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

/** スクリプトプロパティから認可コールバックURル（Webアプリのデプロイ先）を読む（未設定ならエラー） */
const getInfomartRedirectUri_ = () => {
  let uri = PropertiesService.getScriptProperties().getProperty("INFOMART_REDIRECT_URI");
  if (!uri) {
    throw new Error(
      "スクリプトプロパティに INFOMART_REDIRECT_URI が設定されていません。"
      + "このプロジェクトをウェブアプリとしてデプロイし、発行されたURLを登録してください。"
    );
  }
  return uri;
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

/** 指定店舗のリフレッシュトークンを取得（未認可ならメニューでの認可を促すエラー） */
const getInfomartRefreshTokenForStore_ = (storeName) => {
  let map = getInfomartRefreshTokenMap_();
  let token = map[storeName];
  if (!token) {
    throw new Error(
      `店舗「${storeName}」はまだインフォマートAPIの認可が完了していません。`
      + "メニュー「発注管理」→「Infomart認可URLを発行」から認可を行ってください。"
    );
  }
  return token;
};

/** 指定店舗のリフレッシュトークンを保存（ローテーション対応。認可時・再発行時どちらでも呼ぶ） */
const setInfomartRefreshTokenForStore_ = (storeName, refreshToken) => {
  let map = getInfomartRefreshTokenMap_();
  map[storeName] = refreshToken;
  PropertiesService.getScriptProperties().setProperty(INFOMART_REFRESH_TOKENS_PROP_, JSON.stringify(map));
};

/**
 * 「予算・実績」D1（スマレジ店舗選択と共用、smaregi.gsのparseSmaregiStoreCellValue_で解析）から
 * 対象店舗名を解決する。D1が未選択、またはその店舗がまだ認可されていない場合はエラー。
 */
const resolveSelectedInfomartStoreName_ = (budgetSheet) => {
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  // 認可済みかどうかを先に検証しておく（未認可の店舗名でトークン取得に進んでしまうのを防ぐ）
  getInfomartRefreshTokenForStore_(store.storeName);
  return store.storeName;
};

const infomartAuthBase_ = () => {
  return INFOMART_CONFIG.useTestEnv ? INFOMART_CONFIG.authBaseTest : INFOMART_CONFIG.authBaseProd;
};

/**
 * 対象店舗の認可コードフロー開始URLを組み立てる（ブラウザでこのURLを開き、PFID・パスワードで
 * ログインすると、Webアプリ側のdoGet()にリダイレクトされ認可が完了する）
 */
const buildInfomartAuthorizationUrl_ = (storeName) => {
  let clientCred = getInfomartClientCredentials_();
  let redirectUri = getInfomartRedirectUri_();
  let params = [
    "realm=" + encodeURIComponent(INFOMART_CONFIG.realm),
    "client_id=" + encodeURIComponent(clientCred.clientId),
    "redirect_uri=" + encodeURIComponent(redirectUri),
    "response_type=code",
    "scope=" + encodeURIComponent(INFOMART_OAUTH_SCOPE_),
    "state=" + encodeURIComponent(storeName),
    "access_type=offline"
  ];
  return `${infomartAuthBase_()}/openam/oauth2/authorize?${params.join("&")}`;
};

/**
 * 「予算・実績」D1で選択中の店舗の認可URLをダイアログで表示する（メニューから実行）
 * 店舗ごとに一度だけ必要な操作。リンクをクリックしてその店舗のPFID・パスワードでログインすると、
 * doGet() が認可コードを受け取ってリフレッシュトークンを保存する。
 */
const promptInfomartAuthorizationUrl = () => {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  let url = buildInfomartAuthorizationUrl_(store.storeName);

  let html = HtmlService.createHtmlOutput(
    `<p>店舗「${store.storeName}」のインフォマート認可を行います。</p>`
    + `<p><a href="${url}" target="_blank">こちらをクリックして認可画面を開く</a></p>`
    + `<p>その店舗のPFID（ログインID）とパスワードでログインしてください。</p>`
  ).setWidth(420).setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, "Infomart認可URLを発行");
};

/**
 * OAuth2.0 認可コールバック（Webアプリとしてデプロイした場合のエントリポイント）
 * インフォマートの認可画面でログイン後、ここへ code（許可コード）・state（店舗名）付きで
 * リダイレクトされる。code を使ってアクセストークン・リフレッシュトークンを発行し、
 * リフレッシュトークンを店舗名キーで保存する。
 */
const doGet = (e) => {
  let params = (e && e.parameter) || {};
  if (params.error) {
    return HtmlService.createHtmlOutput(`<p>認可が拒否またはエラーになりました: ${params.error}</p>`);
  }
  let code = params.code;
  let storeName = params.state;
  if (!code || !storeName) {
    return HtmlService.createHtmlOutput("<p>不正なコールバックです（code/stateが不足しています）。</p>");
  }

  try {
    let clientCred = getInfomartClientCredentials_();
    let redirectUri = getInfomartRedirectUri_();
    let res = UrlFetchApp.fetch(`${infomartAuthBase_()}/openam/oauth2/access_token?realm=${encodeURIComponent(INFOMART_CONFIG.realm)}`, {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: {
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
        client_id: clientCred.clientId,
        client_secret: clientCred.clientSecret
      },
      muteHttpExceptions: true
    });

    let status = res.getResponseCode();
    if (status !== 200) {
      return HtmlService.createHtmlOutput(`<p>アクセストークン取得に失敗しました。status=${status} body=${res.getContentText().slice(0, 500)}</p>`);
    }

    let json = JSON.parse(res.getContentText());
    setInfomartRefreshTokenForStore_(storeName, json.refresh_token);
    Logger.log(`[Infomart認可] 店舗=${storeName} 認可完了`);
    return HtmlService.createHtmlOutput(`<p>店舗「${storeName}」の認可が完了しました。このタブは閉じて構いません。</p>`);
  } catch (err) {
    return HtmlService.createHtmlOutput(`<p>認可処理でエラーが発生しました: ${err.message}</p>`);
  }
};

/**
 * リフレッシュトークンを使って店舗別のアクセストークンを取得（有効期限-60秒でキャッシュ）
 * アクセストークン発行のたびにリフレッシュトークンもローテーション（新しい値に入れ替わる）
 * ため、成功時は必ず setInfomartRefreshTokenForStore_ で保存し直す。
 */
const getInfomartAccessToken_ = (storeName) => {
  let cache = CacheService.getScriptCache();
  let cacheKey = "infomart_token_" + storeName;
  let cached = cache.get(cacheKey);
  if (cached) return cached;

  let refreshToken = getInfomartRefreshTokenForStore_(storeName);
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

  let code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(
      `インフォマート アクセストークン再発行失敗 [店舗=${storeName}] status=${code} body=${res.getContentText().slice(0, 500)}\n`
      + "リフレッシュトークンが失効した可能性があります。メニューの「Infomart認可URLを発行」から再認可してください。"
    );
  }

  let json = JSON.parse(res.getContentText());
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

/** 指定店舗・指定日に送信された請求書を検索取得（ページング対応） */
const fetchInfomartInvoicesForDate_ = (dateStr, storeName) => {
  let url = `${INFOMART_CONFIG.invoiceApiBase}/wi/v2/seller/invoice/search`;
  let invoices = [];
  let getCount = 99;
  let maxPages = 50; // 安全弁（想定外の応答形式での無限ループを防ぐ）

  for (let page = 0; page < maxPages; page++) {
    let startPosition = page * getCount + 1;
    let json = infomartApiPost_(url, {
      send_date_from: dateStr,
      send_date_to: dateStr,
      start_position: startPosition,
      get_count: getCount
    }, storeName);
    let pageInvoices = Array.isArray(json.invoice_list) ? json.invoice_list : (Array.isArray(json.list) ? json.list : []);
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

/** 取引データダウンロードを依頼（非同期ジョブの開始） */
const requestInfomartOrderDeliveryExtract_ = (dateFrom, dateTo, targetDateSet, statusCodes, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/request`;
  let body = {
    target_date_set: targetDateSet,
    target_date_from: dateFrom,
    target_date_to: dateTo
  };
  if (statusCodes && statusCodes.length > 0) body.status_code = statusCodes;
  let json = infomartApiPost_(url, body, storeName);
  return { requestId: json.request_id, batchId: json.batch_id };
};

/** ジョブの状態を1回確認する */
const checkInfomartOrderDeliveryBatch_ = (batchId, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/check`;
  return infomartApiPost_(url, { batch_id: batchId }, storeName);
};

/** 完了したジョブの結果データを取得する */
const getInfomartOrderDeliveryResult_ = (batchId, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/get`;
  return infomartApiPost_(url, { batch_id: batchId }, storeName);
};

/**
 * ジョブの完了を同一関数内で短時間ポーリングする（GAS実行時間上限[約6分]に対し十分余裕を持たせる）
 * 未確認事項: 実際のジョブ完了時間・「準備完了」判定フィールド名は本番疎通確認で要検証
 * （現状は check の結果に result===0 以外、または status 系フィールドが含まれる想定でログ出力しつつ緩めに待つ）
 */
const pollInfomartOrderDeliveryUntilReady_ = (batchId, storeName) => {
  let maxAttempts = 15;
  let intervalMs = 2000;
  let deadline = Date.now() + 60 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) break;
    let status = checkInfomartOrderDeliveryBatch_(batchId, storeName);
    Logger.log(`[Infomart受発注] 店舗=${storeName} batch_id=${batchId} check#${attempt}: ${JSON.stringify(status).slice(0, 500)}`);
    if (status && String(status.result) === "0" && status.status !== "processing") {
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

/** request → poll → get のオーケストレーション */
const fetchInfomartOrderDeliveryTrades_ = (dateFrom, dateTo, targetDateSet, statusCodes, storeName) => {
  let { batchId } = requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, statusCodes, storeName);
  pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
  let result = getInfomartOrderDeliveryResult_(batchId, storeName);
  return Array.isArray(result.trade_list) ? result.trade_list : (Array.isArray(result.list) ? result.list : []);
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
  let targetDateSet = 0; // TODO: 実際に使う日付区分(0-7)を仕様確認後に見直す
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
