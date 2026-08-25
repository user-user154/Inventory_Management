"use strict";
/**
 * infomart.gs の「Sheetに依存しない部分」（認証・API呼び出し本体）をNode.js向けに移植したもの。
 * 関数名・引数の並び・ロジックは infomart.gs (リポジトリ直下) と可能な限り一致させてあるので、
 * ここで検証が取れたら差分をそのまま infomart.gs に反映するだけでよい。
 *
 * 移植で変えた点はこの3つだけ:
 * 1. UrlFetchApp.fetch / Utilities.sleep がPromiseを返すため、全関数に async/await を追加
 * 2. Sheet書き込み系（ensure*LogSheet_, write*LogFor*_, import*_, prompt*）は対象外
 *    → GAS側に戻すときはこれらの関数は不要（infomart.gsにすでにある）
 * 3. notifyUser 呼び出しは無し（Sheet系のみで使われていたため）
 */

const { Logger, PropertiesService, CacheService, Utilities, UrlFetchApp } = require("./gas-shim");
const { INFOMART_CONFIG } = require("./config");

const INFOMART_REFRESH_TOKENS_PROP_ = "INFOMART_REFRESH_TOKENS";
const INFOMART_CREDENTIALS_PROP_ = "INFOMART_CREDENTIALS";

const formatJstDate_ = (date) => {
  let jst = new Date(date.getTime() + (date.getTimezoneOffset() + 9 * 60) * 60000);
  let y = jst.getFullYear();
  let m = String(jst.getMonth() + 1).padStart(2, "0");
  let d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getInfomartClientCredentials_ = () => {
  let props = PropertiesService.getScriptProperties();
  let clientId = props.getProperty("INFOMART_CLIENT_ID");
  let clientSecret = props.getProperty("INFOMART_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET が設定されていません。"
      + "`node cli.js set-client <clientId> <clientSecret>` か環境変数で設定してください。"
    );
  }
  return { clientId: clientId, clientSecret: clientSecret };
};

const getInfomartRefreshTokenMap_ = () => {
  let raw = PropertiesService.getScriptProperties().getProperty(INFOMART_REFRESH_TOKENS_PROP_);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${INFOMART_REFRESH_TOKENS_PROP_} のJSON形式が不正です: ${err.message}`);
  }
};

const setInfomartRefreshTokenForStore_ = (storeName, refreshToken) => {
  let map = getInfomartRefreshTokenMap_();
  map[storeName] = refreshToken;
  PropertiesService.getScriptProperties().setProperty(INFOMART_REFRESH_TOKENS_PROP_, JSON.stringify(map));
};

const getInfomartCredentialMap_ = () => {
  let raw = PropertiesService.getScriptProperties().getProperty(INFOMART_CREDENTIALS_PROP_);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${INFOMART_CREDENTIALS_PROP_} のJSON形式が不正です: ${err.message}`);
  }
};

const getInfomartCredentialForStore_ = (storeName) => {
  let map = getInfomartCredentialMap_();
  let cred = map[storeName];
  if (!cred || !cred.userId || !cred.userPassword) {
    throw new Error(
      `店舗「${storeName}」はまだPFIDが登録されていません。`
      + "`node cli.js set-credential <store> <userId> <userPassword>` で登録してください。"
    );
  }
  return cred;
};

const setInfomartCredentialForStore_ = (storeName, userId, userPassword, memberCode) => {
  let map = getInfomartCredentialMap_();
  map[storeName] = { userId: userId, userPassword: userPassword, memberCode: memberCode || "" };
  PropertiesService.getScriptProperties().setProperty(INFOMART_CREDENTIALS_PROP_, JSON.stringify(map));
};

const infomartAuthBase_ = () => {
  return INFOMART_CONFIG.useTestEnv ? INFOMART_CONFIG.authBaseTest : INFOMART_CONFIG.authBaseProd;
};

const fetchInfomartAccessTokenViaCredentials_ = async (storeName) => {
  let clientCred = getInfomartClientCredentials_();
  let cred = getInfomartCredentialForStore_(storeName);

  let res = await UrlFetchApp.fetch(`${infomartAuthBase_()}/api/credentials/access_token`, {
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
      + "登録済みのPFID・パスワードが正しいか確認してください（set-credentialで再登録可能）。"
    );
  }
  return JSON.parse(res.getContentText());
};

const refreshInfomartAccessTokenWithToken_ = async (refreshToken, storeName) => {
  let clientCred = getInfomartClientCredentials_();
  let res = await UrlFetchApp.fetch(`${infomartAuthBase_()}/openam/oauth2/access_token?realm=${encodeURIComponent(INFOMART_CONFIG.realm)}`, {
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

const getInfomartAccessToken_ = async (storeName) => {
  let cache = CacheService.getScriptCache();
  let cacheKey = "infomart_token_" + storeName;
  let cached = cache.get(cacheKey);
  if (cached) return cached;

  let refreshToken = getInfomartRefreshTokenMap_()[storeName];
  let json = refreshToken ? await refreshInfomartAccessTokenWithToken_(refreshToken, storeName) : null;
  if (!json) {
    json = await fetchInfomartAccessTokenViaCredentials_(storeName);
  }

  let accessToken = json.access_token;
  let expiresIn = Number(json.expires_in) || 300;
  setInfomartRefreshTokenForStore_(storeName, json.refresh_token);
  cache.put(cacheKey, accessToken, Math.max(60, expiresIn - 60));
  return accessToken;
};

const infomartApiPost_ = async (url, bodyParams, storeName) => {
  let token = await getInfomartAccessToken_(storeName);
  let body = Object.assign({ response_type: "json" }, bodyParams || {});

  let res = await UrlFetchApp.fetch(url, {
    method: "post",
    // Accept未指定だと請求書API(/wi/v2/buyer/invoice/search)がE700003で弾く
    // （「Acceptはapplication/jsonまたはtext/xmlを入力してください」）。
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
const fetchInfomartInvoicesForDate_ = async (dateStr, storeName) => {
  return fetchInfomartInvoicesForDateRange_(dateStr, dateStr, storeName);
};

const fetchInfomartInvoicesForDateRange_ = async (dateFrom, dateTo, storeName) => {
  let url = `${INFOMART_CONFIG.invoiceApiBase}/wi/v2/buyer/invoice/search`;
  let invoices = [];
  let getCount = 99;
  let maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    let startPosition = page * getCount + 1;
    let json = await infomartApiPost_(url, {
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

// ---------------------------------------------------------------------------
// 受発注・納品データ（読み取り、非同期ジョブ: request → check → get）
// ---------------------------------------------------------------------------
const requestInfomartOrderDeliveryExtract_ = async (dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes, statusSet) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/request`;
  let body = {
    target_date_set: targetDateSet,
    target_date_from: dateFrom,
    target_date_to: dateTo
  };
  if (statusCodes && statusCodes.length > 0) body.status_code = statusCodes;
  if (memberCodes && memberCodes.length > 0) body.member_codes = memberCodes;
  if (statusSet != null) body.status_set = statusSet;
  let json = await infomartApiPost_(url, body, storeName);
  return { requestId: json.request_id, batchId: json.batch_id };
};

const checkInfomartOrderDeliveryBatch_ = async (batchId, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/check`;
  return infomartApiPost_(url, { batch_id: batchId }, storeName);
};

const getInfomartOrderDeliveryResult_ = async (batchId, seqFrom, seqTo, storeName) => {
  let url = `${INFOMART_CONFIG.apiBase}/ordApi/order/trade/download/get`;
  return infomartApiPost_(url, { batch_id: batchId, seq_from: String(seqFrom), seq_to: String(seqTo) }, storeName);
};

const pollInfomartOrderDeliveryUntilReady_ = async (batchId, storeName) => {
  // 準備完了はbatch_flg>=3で判定（result==="0"はcheck API呼び出し自体の成否でしかなく、
  // ジョブ完了とは無関係。infomart.gs側の同名関数のコメント参照）
  let maxAttempts = 30;
  let intervalMs = 3000;
  let deadline = Date.now() + 100 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) break;
    let status = await checkInfomartOrderDeliveryBatch_(batchId, storeName);
    Logger.log(`[Infomart受発注] 店舗=${storeName} batch_id=${batchId} check#${attempt}: ${JSON.stringify(status).slice(0, 500)}`);
    if (status && Number(status.batch_flg) >= 3) {
      return status;
    }
    await Utilities.sleep(intervalMs);
  }

  throw new Error(
    `Infomart受発注データの準備が時間内に完了しませんでした（店舗=${storeName} batch_id=${batchId}）。`
    + "1分ほど待ってから再実行してください。"
  );
};

const fetchInfomartOrderDeliveryTrades_ = async (dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes) => {
  let { batchId } = await requestInfomartOrderDeliveryExtract_(dateFrom, dateTo, targetDateSet, statusCodes, storeName, memberCodes);
  let status = await pollInfomartOrderDeliveryUntilReady_(batchId, storeName);
  let recordCount = Number(status.record_count) || 0;
  if (recordCount === 0) return [];

  let pageSize = 1000;
  let trades = [];
  for (let seqFrom = 1; seqFrom <= recordCount; seqFrom += pageSize) {
    let seqTo = Math.min(seqFrom + pageSize - 1, recordCount);
    let result = await getInfomartOrderDeliveryResult_(batchId, seqFrom, seqTo, storeName);
    let pageTrades = Array.isArray(result.trade) ? result.trade : [];
    trades = trades.concat(pageTrades);
  }
  return trades;
};

module.exports = {
  formatJstDate_,
  getInfomartClientCredentials_,
  getInfomartCredentialMap_,
  getInfomartCredentialForStore_,
  setInfomartCredentialForStore_,
  getInfomartRefreshTokenMap_,
  infomartAuthBase_,
  fetchInfomartAccessTokenViaCredentials_,
  refreshInfomartAccessTokenWithToken_,
  getInfomartAccessToken_,
  infomartApiPost_,
  fetchInfomartInvoicesForDate_,
  fetchInfomartInvoicesForDateRange_,
  requestInfomartOrderDeliveryExtract_,
  checkInfomartOrderDeliveryBatch_,
  getInfomartOrderDeliveryResult_,
  pollInfomartOrderDeliveryUntilReady_,
  fetchInfomartOrderDeliveryTrades_
};
