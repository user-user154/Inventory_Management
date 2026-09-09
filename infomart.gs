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

/**
 * 発注バックログの取得元切替フラグのスクリプトプロパティキー（"infomart"(既定) | "manual"）。
 * 2026-08-25、指示書での発注ブロック手動確定コミットをInfomart実データ取込に置き換えるにあたり、
 * 問題があった場合に即座に旧方式へ戻せるよう1フラグで両経路を切替できるようにした。
 */
const INFOMART_ORDER_BACKLOG_SOURCE_PROP_ = "INFOMART_ORDER_BACKLOG_SOURCE";

/** 現在の発注バックログ取得元を返す（未設定時は既定の"infomart"） */
const getInfomartOrderBacklogSource_ = () => {
  let v = PropertiesService.getScriptProperties().getProperty(INFOMART_ORDER_BACKLOG_SOURCE_PROP_);
  return v === "manual" ? "manual" : "infomart";
};

/**
 * 発注バックログの取得元を切り替える（メニューから実行）。
 * "infomart": 発注はInfomart実データから自動反映（既定）。仕込みは従来通り手動確定コミット。
 * "manual": 従来通り、仕込み・発注とも指示書の確定コミットから反映（ロールバック用）。
 */
const toggleInfomartOrderBacklogSource = () => {
  let ui = SpreadsheetApp.getUi();
  let current = getInfomartOrderBacklogSource_();
  let next = current === "infomart" ? "manual" : "infomart";
  let res = ui.alert(
    "発注バックログ取得元の切替",
    `現在の設定: ${current}\n切替後: ${next}\n\n`
    + (next === "manual"
      ? "Infomart連携を使わず、指示書の発注ブロックを手動確定コミットする従来方式に戻します。"
      : "発注バックログをInfomart実データから自動反映する方式に切り替えます（仕込みは引き続き手動確定）。")
    + "\n\nよろしいですか？",
    ui.ButtonSet.YES_NO
  );
  if (res !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().setProperty(INFOMART_ORDER_BACKLOG_SOURCE_PROP_, next);
  ui.alert(`発注バックログ取得元を「${next}」に切り替えました。`);
};

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

/** 指定店舗のPFID（ログインID・パスワード・任意でmemberCode）を取得（未登録ならメニューでの登録を促すエラー） */
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

/**
 * 指定店舗のPFID（ログインID・パスワード）を保存
 * memberCode（自社会員システムコード、半角8桁想定・英数混在あり）は任意。
 * 2026-08-25の実機検証で判明した通り、登録するPFIDが親アカウント（グループ会社共通ログイン）の
 * 場合、受発注データ取得APIはmember_codesで絞り込まないとグループ内の他店舗の伝票まで
 * 一緒に返ってくる。そのため店舗ごとに正しいmemberCodeを登録しておくことが重要
 * （fetchInfomartOrderDeliveryTrades_呼び出し側でmember_codesフィルタとして使う）。
 */
const setInfomartCredentialForStore_ = (storeName, userId, userPassword, memberCode) => {
  let map = getInfomartCredentialMap_();
  map[storeName] = { userId: userId, userPassword: userPassword, memberCode: memberCode || "" };
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
 * 「予算・実績」D1で選択中の店舗のPFID（ログインID・パスワード・自社会員システムコード）を登録する
 * （メニューから実行）。店舗ごとに一度でよいが、PFIDのパスワードを変更した場合は再登録が必要。
 * ui.prompt はマスク入力に対応していないため、周囲に見られない環境で入力すること。
 *
 * 自社会員システムコード（member_code）は空欄でも登録できるが、2026-08-25の実機検証で判明した通り
 * 空欄のまま受発注データを取得すると、登録したPFIDが親アカウント（グループ会社共通ログイン）の
 * 場合にグループ内の他店舗の伝票まで一緒に取得されてしまう。可能な限り入力すること
 * （店舗ごとに異なるPFIDを個別登録する運用なら空欄のままでも問題ない）。
 * 既存店舗のmemberCodeだけ後から追加・修正したい場合は promptInfomartMemberCodeRegistration を使う。
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

  let memberRes = ui.prompt(
    "InfomartのPFIDを登録",
    `店舗「${store.storeName}」の自社会員システムコードを入力してください（任意・空欄可）。\n`
    + "このPFIDが複数店舗を横断できる親アカウントの場合、受発注データをこの店舗だけに絞り込むために使います。"
    + "不明な場合は空欄のままOKしてください。",
    ui.ButtonSet.OK_CANCEL
  );
  if (memberRes.getSelectedButton() !== ui.Button.OK) return;
  let memberCode = String(memberRes.getResponseText() || "").trim();

  setInfomartCredentialForStore_(store.storeName, userId, userPassword, memberCode);
  ui.alert(`店舗「${store.storeName}」のPFIDを登録しました。${memberCode ? `（会員コード: ${memberCode}）` : "（会員コードは未設定）"}`);
};

/**
 * 既に登録済みのPFIDはそのまま、自社会員システムコードだけ後から登録・修正する（メニューから実行）
 * PFIDが未登録の店舗ではエラーになる（先にInfomartのPFIDを登録すること）。
 */
const promptInfomartMemberCodeRegistration = () => {
  let budgetSheet = resolveStoreSheetsFromActiveSheet_().budgetSheet;
  let store = resolveSelectedSmaregiStore_(budgetSheet);
  let ui = SpreadsheetApp.getUi();
  let cred = getInfomartCredentialForStore_(store.storeName); // 未登録ならここで例外→メニュー実行時にダイアログ表示される

  let res = ui.prompt(
    "Infomart自社会員システムコードを登録",
    `店舗「${store.storeName}」の自社会員システムコードを入力してください`
    + `（現在の設定: ${cred.memberCode || "未設定"}）。`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  let memberCode = String(res.getResponseText() || "").trim();

  setInfomartCredentialForStore_(store.storeName, cred.userId, cred.userPassword, memberCode);
  ui.alert(`店舗「${store.storeName}」の自社会員システムコードを「${memberCode || "未設定"}」に更新しました。`);
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
    // Accept未指定だと請求書API(/wi/v2/buyer/invoice/search)がE700003で弾かれる
    // （「Acceptはapplication/jsonまたはtext/xmlを入力してください」。infomart-debugで確認済み）。
    // 受発注API側は無くても通っていたが、害はないので共通ヘルパーに常時付与しておく。
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
  return infomartApiPost_(url, { batch_id: batchId, seq_from: String(seqFrom), seq_to: String(seqTo) }, storeName);
};

/**
 * Infomartの非同期ダウンロード系API（受発注・マスタ共通）のジョブ完了をポーリングする
 * （GAS実行時間上限[約6分]に対し十分余裕を持たせる）。
 *
 * batch_flgの意味は2026-08-25にマスタダウンロードAPIのリファレンスで正式に確認済み:
 *   1=処理待ち 2=処理中 3=処理終了(成功) 4=処理中止 5=エラー終了
 *   0=入力情報が不正、または結果データなし
 * 受発注ダウンロードAPIは同じ非同期基盤を使っており、実機検証で同じ遷移
 * （1→2→3でrecord_countが埋まる、確認時は約10〜60秒後）を確認済みのため同じ判定を適用する。
 * 旧実装は result==="0"（check API呼び出し自体の成功可否でしかない）を「準備完了」としていたため、
 * 実際にはジョブがbatch_flg=1〜2の処理中段階なのにrecord_count=0を「対象データなし」と誤認していた
 * （親アカウントの取引一覧では存在が確認できる伝票が0件と表示され続けたバグの原因）。
 * さらにその後の`>=3`判定は4(処理中止)・5(エラー終了)も「完了」と誤判定する抜けがあったため、
 * 3と0のみ成功、4と5は明示的にエラーとして扱うよう修正した。
 * @param {() => object} checkFn checkInfomartOrderDeliveryBatch_ 等、引数無しで呼べる形にした関数
 */
const pollInfomartBatchUntilReady_ = (checkFn, storeName, batchId, logLabel) => {
  let maxAttempts = 30;
  let intervalMs = 3000;
  let deadline = Date.now() + 100 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) break;
    let status = checkFn();
    Logger.log(`[${logLabel}] 店舗=${storeName} batch_id=${batchId} check#${attempt}: ${JSON.stringify(status).slice(0, 500)}`);
    let flg = status ? Number(status.batch_flg) : NaN;
    if (flg === 3 || flg === 0) return status;
    if (flg === 4) {
      throw new Error(`[${logLabel}] 店舗=${storeName} batch_id=${batchId} ジョブが処理中止されました（batch_flg=4）。`);
    }
    if (flg === 5) {
      throw new Error(`[${logLabel}] 店舗=${storeName} batch_id=${batchId} ジョブがエラー終了しました（batch_flg=5）: ${JSON.stringify((status && status.error_list) || [])}`);
    }
    Utilities.sleep(intervalMs);
  }

  let props = PropertiesService.getScriptProperties();
  props.setProperty(INFOMART_ORDER_LAST_BATCH_ID_PROP_PREFIX_ + storeName, batchId);
  throw new Error(
    `[${logLabel}] 店舗=${storeName} batch_id=${batchId} 準備が時間内に完了しませんでした。`
    + "1分ほど待ってから再実行してください。"
  );
};

const pollInfomartOrderDeliveryUntilReady_ = (batchId, storeName) => {
  return pollInfomartBatchUntilReady_(
    () => checkInfomartOrderDeliveryBatch_(batchId, storeName), storeName, batchId, "Infomart受発注"
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

// ---------------------------------------------------------------------------
// マスタ（自社管理商品・カタログ）データ（読み取り、非同期ジョブ: request → check → get）
// 2026-08-25、ユーザー提供のリファレンスで存在を確認して追加。受発注ダウンロードと違い日付範囲
// 指定が必須ではなく、発注履歴の有無に関係なく取引先の全商品カタログを一括取得できる
// （名寄せマスタ整備用の商品一覧としてこちらを使う）。
// ---------------------------------------------------------------------------

/** マスタダウンロードを依頼（非同期ジョブの開始）。paramsはリファレンス記載の各絞り込み項目 */
const requestInfomartMasterDownload_ = (storeName, params) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/master/download/buy/request`;
  let json = infomartApiPost_(url, params || {}, storeName);
  return { requestId: json.request_id, batchId: json.batch_id };
};

const checkInfomartMasterDownloadBatch_ = (batchId, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/master/download/buy/check`;
  return infomartApiPost_(url, { batch_id: batchId }, storeName);
};

const getInfomartMasterDownloadResult_ = (batchId, seqFrom, seqTo, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/master/download/buy/get`;
  return infomartApiPost_(url, { batch_id: batchId, seq_from: String(seqFrom), seq_to: String(seqTo) }, storeName);
};

/**
 * request → poll → get(seq_from/seq_toで連番指定、5000件単位ページング) のオーケストレーション
 * @param {object} [params] member_code_list未指定時は「本部のみ」扱い（リファレンス記載）。
 *   店舗を絞り込みたい場合は params.member_code_list に自社会員システムコードを渡す。
 */
const fetchInfomartMasterCatalog_ = (storeName, params) => {
  let { batchId } = requestInfomartMasterDownload_(storeName, params);
  let status = pollInfomartBatchUntilReady_(
    () => checkInfomartMasterDownloadBatch_(batchId, storeName), storeName, batchId, "Infomartマスタ"
  );
  let recordCount = Number(status.record_count) || 0;
  if (recordCount === 0) return [];

  let pageSize = 5000; // リファレンス記載の上限
  let items = [];
  for (let seqFrom = 1; seqFrom <= recordCount; seqFrom += pageSize) {
    let seqTo = Math.min(seqFrom + pageSize - 1, recordCount);
    let result = getInfomartMasterDownloadResult_(batchId, seqFrom, seqTo, storeName);
    let pageItems = Array.isArray(result.master) ? result.master : [];
    items = items.concat(pageItems);
  }
  return items;
};

const INFOMART_ITEM_MASTER_HEADERS_ = [
  "取得日", "仕入先", "商品ID", "商品名", "規格", "単位", "単価",
  "大分類", "中分類", "小分類", "自社管理コード", "表示状態コード", "販売中止状態コード"
];

/** Infomart商品マスタシートの見出しを用意（無ければ新規シート作成、ズレていれば書き直す） */
const ensureInfomartItemMasterSheet_ = (ss) => {
  let sheet = ss.getSheetByName(SHEET_NAMES.INFOMART_ITEM_MASTER);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.INFOMART_ITEM_MASTER);
    Logger.log(`[Infomart] シート「${SHEET_NAMES.INFOMART_ITEM_MASTER}」を新規作成`);
  }
  let currentHeaders = sheet.getRange(1, 1, 1, INFOMART_ITEM_MASTER_HEADERS_.length).getValues()[0]
    .map((v) => { return String(v == null ? "" : v).trim(); });
  let matches = INFOMART_ITEM_MASTER_HEADERS_.every((h, i) => { return currentHeaders[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, INFOMART_ITEM_MASTER_HEADERS_.length).setValues([INFOMART_ITEM_MASTER_HEADERS_]);
    Logger.log(`[Infomart] 「${SHEET_NAMES.INFOMART_ITEM_MASTER}」の見出し行を更新しました`);
  }
  return sheet;
};

/**
 * 商品マスタを取得してシートへ全件洗い替えする（名寄せマスタ整備用。取得日ぶんの差分保持は
 * 行わない＝毎回カタログ全体をスナップショットとして置き換える、他のInfomartログとは異なる運用）。
 * catalog（カタログ情報）を主に使う。buyとcatalogでitem_idが食い違うケースが実データで確認できて
 * おり原因未確認のため、名寄せ照合にはcatalog側のitem_idを使う（catalog側にのみ単価・カテゴリ・
 * 表示/廃止状態が揃っているため）。
 */
const importInfomartItemMaster_ = (storeName, memberCodes) => {
  let params = {};
  if (memberCodes && memberCodes.length > 0) params.member_code_list = memberCodes;
  let items = fetchInfomartMasterCatalog_(storeName, params);

  let today = formatJstDate_(new Date());
  let rows = items.map((i) => {
    let c = i.catalog || {};
    return [
      today, i.member_name_partner || "", c.item_id || "", c.item_name || "", c.item_spec || "",
      c.item_unit_name || c.prod_unit_name || "", c.prod_lot_price != null ? c.prod_lot_price : "",
      c.food_cat_large_name || "", c.food_cat_middle_name || "", c.food_cat_small_name || "",
      c.private_item_code || "", c.view_active_code != null ? c.view_active_code : "",
      c.sell_stop_active_code != null ? c.sell_stop_active_code : ""
    ];
  });

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ensureInfomartItemMasterSheet_(ss);
  let lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, INFOMART_ITEM_MASTER_HEADERS_.length).clearContent();
  }
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, INFOMART_ITEM_MASTER_HEADERS_.length).setValues(rows);
  }

  notifyUser(`Infomart商品マスタ取込完了 [${storeName}]: ${rows.length}件（シート「${SHEET_NAMES.INFOMART_ITEM_MASTER}」を全件洗い替え）`);
  return { storeName: storeName, itemCount: rows.length };
};

/** 商品マスタを手動取得（メニューから実行。対象店舗は予算・実績 D1 の選択に従う） */
const promptAndImportInfomartItemMaster = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let storeName = resolveSelectedInfomartStoreName_(budgetSheet);
  let memberCode = getInfomartCredentialForStore_(storeName).memberCode;

  let ui = SpreadsheetApp.getUi();
  let res = ui.alert(
    "Infomart商品マスタを取得",
    `対象店舗: ${storeName}\nこのPFIDで見える商品カタログ全件を取得します`
    + `（${memberCode ? `会員コード${memberCode}を指定` : "会員コード未設定のため「本部のみ」扱い"}）。`
    + "件数が多いと数分かかります。よろしいですか？",
    ui.ButtonSet.YES_NO
  );
  if (res !== ui.Button.YES) return;

  importInfomartItemMaster_(storeName, memberCode ? [memberCode] : null);
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

/**
 * 取引1件（trade、伝票1枚に相当）を「明細1行=1行」に展開する（請求書側のflattenInfomartInvoiceToRows_と対）
 * フィールド名は2026-08-25に実データ（大衆焼肉コグマヤ池袋西口店、target_date_set=2、93件・明細334行）で
 * 確認済み。数量は item_number ではなく prod_lot_qty（＝order_prod_lot_qty、常に同値）を使うこと。
 * item_number は空欄になる明細も多く、prod_lot_qty×prod_lot_price=prod_lot_total の関係が常に成立する
 * ことを実データで確認して切り分けた（item_numberは数量ではなく別の意味の項目と判断）。
 * 商品コードは item_id（Infomartのプラットフォーム共通商品ID）を使用。取引先固有の商品コードが別途
 * 必要になった場合は my_catalog_id（自社カタログID）や small_code も明細に含まれているので差し替え可能。
 * ステータス列（status_code、伝票状態コード）の意味:
 *   40=受領済（出荷完了。売り手が発注内容を確認し受注確定/出荷手続き完了）
 *   60=検収済（買い手が届いた商品を確認し検収完了。受発注データが確定した段階）
 *   80=確定済（締処理済。月次等の締め日を迎え金額が完全にロックされた状態）
 * 他のコード値（更新日時点で40未満の受注直後段階等）が存在するかは今回のサンプルでは未確認。
 */
const flattenInfomartOrderDeliveryTradeToRows_ = (trade) => {
  let base = {
    target_date: trade.order_day,
    order_no: trade.trade_id,
    delivery_scheduled_date: trade.delivery_date || trade.hope_delivery_date,
    customer_company_name: trade.member_name_partner,
    status: trade.status_code
  };
  let details = Array.isArray(trade.detail_list) ? trade.detail_list : [];
  if (details.length === 0) {
    return [Object.assign({ item_code: "", item_name: "", quantity: "", unit_price: "", amount: "", unit: "" }, base)];
  }
  return details.map((d) => {
    return Object.assign({
      item_code: d.item_id, item_name: d.item_name, quantity: d.prod_lot_qty,
      unit_price: d.prod_lot_price, amount: d.prod_lot_total, unit: d.item_unit_name
    }, base);
  });
};

/** 指定範囲の受発注・納品データを取得してログシートへ書込み（フェーズ1のメイン導線） */
const importInfomartOrderDeliveryForDateRange_ = (dateFrom, dateTo, storeName) => {
  // target_date_set: [0:更新日 1:伝票日 2:発注日 3:発送予定日 4:発送日 5:納品日 6:受領日 7:送信日]
  // 「発注管理」ツールの主目的に合わせ発注日(2)を採用（2026-08-25に実データで動作確認済み）。
  let targetDateSet = 2;
  // member_codesで対象店舗に絞り込む。2026-08-25の実機検証で、登録PFIDが親アカウント（グループ会社
  // 共通ログイン）だと絞り込みなしではグループ内の他店舗の伝票まで一緒に返ってくることを確認済み
  // （例: このPFIDで8/25発注日ぶんを無指定取得すると3店舗分22件が混在して返ってきた）。
  let memberCode = getInfomartCredentialForStore_(storeName).memberCode;
  let memberCodes = memberCode ? [memberCode] : null;
  if (!memberCodes) {
    Logger.log(`[Infomart受発注] 店舗=${storeName} 自社会員システムコード未設定のため絞り込み無しで取得します。`
      + "PFIDが複数店舗を横断できる場合、他店舗の伝票が混在する可能性があります"
      + "（メニュー「発注管理」→「Infomart自社会員システムコードを登録」で設定可能）。");
  }
  let trades = fetchInfomartOrderDeliveryTrades_(dateFrom, dateTo, targetDateSet, null, storeName, memberCodes);
  let rows = [];
  trades.forEach((trade) => { rows = rows.concat(flattenInfomartOrderDeliveryTradeToRows_(trade)); });

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ensureInfomartOrderDeliveryLogSheet_(ss);
  let rangeKey = `${dateFrom}〜${dateTo}`;
  writeInfomartOrderDeliveryLogForRange_(sheet, rangeKey, storeName, rows);

  notifyUser(`Infomart受発注データ取込完了 [${storeName} / ${rangeKey}]: 伝票${trades.length}件 / 明細${rows.length}行`);
  return { rangeKey: rangeKey, storeName: storeName, tradeCount: trades.length, rowCount: rows.length };
};

// ---------------------------------------------------------------------------
// 発注バックログのInfomart化（確定コミットの発注ブロックの代替。getInfomartOrderBacklogSource_で切替）
// ---------------------------------------------------------------------------

/**
 * Infomartの発注日ベース実データ（target_date_set=2）を取得し、バックログへ「発注」区分として
 * 書き込む（確定コミットの発注ブロックの代替）。
 * PFID未登録・バックログシート未作成の店舗は何もせずnullを返す（夜間バッチが他店舗の処理を
 * 継続できるよう、ここでは例外を投げない）。
 * 名寄せマスタで解決できない商品名・単位換算できない単位は書き込まず、まとめて警告する
 * （誤った理論在庫を作らないためのガード。名寄せマスタ・原材料マスタへの追加を促す）。
 * 同日・同商材で複数明細/複数伝票があれば合算するが、納品予定日が異なるものは別行のまま残す
 * （将来の理論在庫連携で納品予定日ごとに入荷計上するため）。
 */
const importInfomartOrderBacklogForDate_ = (dateStr, storeName) => {
  let cred = getInfomartCredentialMap_()[storeName];
  if (!cred || !cred.userId || !cred.userPassword) {
    Logger.log(`[Infomart発注バックログ] 店舗=${storeName} PFID未登録のためスキップ`);
    return null;
  }

  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let storeSheets = resolveStoreSheetsByStoreName_(ss, storeName);
  if (!storeSheets.backlogSheet) {
    Logger.log(`[Infomart発注バックログ] 店舗=${storeName} バックログシート未作成のためスキップ`);
    return null;
  }

  let memberCodes = cred.memberCode ? [cred.memberCode] : null;
  let trades = fetchInfomartOrderDeliveryTrades_(dateStr, dateStr, 2, null, storeName, memberCodes);

  let rawMaster = loadRawMaterialMasterCached_(ss);
  let nameUnifyMap = loadNameUnifyMaster(ss.getSheetByName(SHEET_NAMES.NAME_UNIFY_MASTER));

  let aggregated = {}; // key=canonicalName|deliveryDateStr
  let unresolvedNames = {};
  let unconvertibleUnits = [];

  trades.forEach((trade) => {
    flattenInfomartOrderDeliveryTradeToRows_(trade).forEach((r) => {
      let itemName = String(r.item_name || "").trim();
      if (!itemName) return;
      let qty = Number(r.quantity) || 0;
      if (qty <= 0) return;

      let canonicalName = resolveCanonicalName_(itemName, nameUnifyMap);
      let rawRow = rawMaster[canonicalName];
      if (!rawRow) {
        unresolvedNames[itemName] = true;
        return;
      }
      if (!isConvertibleToMinUnit_(r.unit, rawRow)) {
        unconvertibleUnits.push(`${itemName}(${r.unit || "単位不明"})`);
        return;
      }

      let minQty = convertToMinUnit(qty, r.unit, rawRow);
      let deliveryDateStr = r.delivery_scheduled_date || dateStr;
      let key = canonicalName + "|" + deliveryDateStr;
      if (!aggregated[key]) {
        aggregated[key] = { name: canonicalName, deliveryDateStr: deliveryDateStr, qty: 0, minQty: 0 };
      }
      aggregated[key].qty += qty;
      aggregated[key].minQty += minQty;
    });
  });

  let rows = Object.keys(aggregated).map((key) => {
    let a = aggregated[key];
    return [dateStr, a.name, "発注", a.qty, a.deliveryDateStr, 0, a.minQty, a.qty, "Infomart"];
  });

  let backlogCount = replaceBacklogRowsForDate_(storeSheets.backlogSheet, dateStr, rows, storeName, "発注");

  let warnings = [];
  let unresolvedList = Object.keys(unresolvedNames);
  if (unresolvedList.length > 0) {
    warnings.push(`名寄せ未対応 ${unresolvedList.length}件: ${unresolvedList.slice(0, 10).join(", ")}${unresolvedList.length > 10 ? " ..." : ""}`);
  }
  if (unconvertibleUnits.length > 0) {
    warnings.push(`単位換算不可でスキップ ${unconvertibleUnits.length}件: ${unconvertibleUnits.slice(0, 10).join(", ")}${unconvertibleUnits.length > 10 ? " ..." : ""}`);
  }
  if (warnings.length > 0) {
    Logger.log(`[Infomart発注バックログ] 店舗=${storeName} ${dateStr}: ${warnings.join(" / ")}`);
    notifyUser(`Infomart発注バックログ取込 [${storeName} / ${dateStr}]: ${backlogCount}件反映。要確認: ${warnings.join(" / ")}`);
  } else {
    Logger.log(`[Infomart発注バックログ] 店舗=${storeName} ${dateStr}: ${backlogCount}件反映（伝票${trades.length}件）`);
  }

  return {
    dateStr: dateStr, storeName: storeName, backlogCount: backlogCount, tradeCount: trades.length,
    unresolvedCount: unresolvedList.length, unconvertibleCount: unconvertibleUnits.length
  };
};

/** 発注バックログをInfomartから手動取得（メニューから実行。対象店舗は予算・実績 D1 の選択に従う） */
const promptAndImportInfomartOrderBacklog = () => {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  let budgetSheet = resolveStoreSheetsFromActiveSheet_(ss).budgetSheet;
  let storeName = resolveSelectedInfomartStoreName_(budgetSheet);

  let ui = SpreadsheetApp.getUi();
  let today = formatJstDate_(new Date());
  let res = ui.prompt(
    "Infomart発注バックログ取得",
    `対象店舗: ${storeName}\n対象日（発注日）を yyyy-MM-dd で入力してください（空欄なら本日 ${today}）`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let input = String(res.getResponseText() || "").trim();
  let dateStr = input || today;
  if (isNaN(new Date(`${dateStr}T12:00:00`).getTime())) {
    ui.alert(`日付の形式が正しくありません: ${input}`);
    return;
  }
  let result = importInfomartOrderBacklogForDate_(dateStr, storeName);
  if (!result) {
    ui.alert("実行できませんでした（PFID未登録、またはバックログシート未作成の可能性があります。ログを確認してください）。");
  }
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
