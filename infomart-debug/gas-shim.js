"use strict";
/**
 * GAS互換シム: infomart.gs から使っているGASビルトインのうち、
 * Infomart連携の検証に必要な最小限（UrlFetchApp / PropertiesService / CacheService /
 * Utilities / Logger）だけをNode.jsで再現する。
 *
 * 重要な差異（GASへ移植し直す際に思い出すこと）:
 * - GASの UrlFetchApp.fetch / Utilities.sleep は同期呼び出しだが、Node側は
 *   グローバル fetch を使うため非同期にせざるを得ない。よってこのシムに依存する
 *   infomart-core.js 側の関数はすべて async / await 付きで書いてある。
 *   本家 infomart.gs に反映するときは async/await を外し、UrlFetchApp.fetch(...) /
 *   Utilities.sleep(...) をそのまま同期呼び出しに戻すだけでよい（関数名・ロジック・
 *   変数名は極力そのまま揃えてある）。
 * - PropertiesService はGASのスクリプトプロパティと同じキー名
 *   （INFOMART_CLIENT_ID / INFOMART_CLIENT_SECRET / INFOMART_CREDENTIALS /
 *   INFOMART_REFRESH_TOKENS）を使う。環境変数に同名のキーがあればそちらを優先し、
 *   無ければ .state/properties.local.json （gitignore対象）を読み書きする。
 *   本番のスクリプトプロパティの値をそのままコピペしてこのローカルファイルに
 *   入れれば、GAS側と同じ状態で検証できる。
 */

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, ".state");
const PROPERTIES_FILE = path.join(STATE_DIR, "properties.local.json");
const CACHE_FILE = path.join(STATE_DIR, "cache.local.json");

const ensureStateDir_ = () => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
};

const readJsonFile_ = (file) => {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} のJSON形式が不正です: ${err.message}`);
  }
};

const writeJsonFile_ = (file, obj) => {
  ensureStateDir_();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const Logger = {
  log: (msg) => {
    let ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
  }
};

// ---------------------------------------------------------------------------
// PropertiesService（スクリプトプロパティ相当。env var > ローカルJSONファイルの優先順）
// ---------------------------------------------------------------------------
const scriptPropertiesStore_ = {
  getProperty: (key) => {
    if (process.env[key] != null && process.env[key] !== "") return process.env[key];
    let all = readJsonFile_(PROPERTIES_FILE);
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  },
  setProperty: (key, value) => {
    let all = readJsonFile_(PROPERTIES_FILE);
    all[key] = value;
    writeJsonFile_(PROPERTIES_FILE, all);
  },
  deleteProperty: (key) => {
    let all = readJsonFile_(PROPERTIES_FILE);
    delete all[key];
    writeJsonFile_(PROPERTIES_FILE, all);
  }
};

const PropertiesService = {
  getScriptProperties: () => scriptPropertiesStore_
};

// ---------------------------------------------------------------------------
// CacheService（プロセスをまたいでも多少効くよう、ファイルにも永続化する簡易版）
// ---------------------------------------------------------------------------
const scriptCacheStore_ = {
  get: (key) => {
    let all = readJsonFile_(CACHE_FILE);
    let entry = all[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.value;
  },
  put: (key, value, ttlSeconds) => {
    let all = readJsonFile_(CACHE_FILE);
    all[key] = { value: value, expiresAt: Date.now() + ttlSeconds * 1000 };
    writeJsonFile_(CACHE_FILE, all);
  },
  remove: (key) => {
    let all = readJsonFile_(CACHE_FILE);
    delete all[key];
    writeJsonFile_(CACHE_FILE, all);
  }
};

const CacheService = {
  getScriptCache: () => scriptCacheStore_
};

// ---------------------------------------------------------------------------
// Utilities（sleepのみ。GASは同期だがNode側はPromiseを返すのでawaitして使う）
// ---------------------------------------------------------------------------
const Utilities = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

// ---------------------------------------------------------------------------
// INFOMART_DEBUG_HTTP=1 のログにシークレットをそのまま出さないためのマスク処理
// （user_password/client_secret/access_token/refresh_token/id_token を
//  form-encoded・JSONどちらの形でも伏せる。これでもログを外部に貼るときは要注意）
// ---------------------------------------------------------------------------
const SENSITIVE_KEYS_ = ["user_password", "client_secret", "access_token", "refresh_token", "id_token"];

const redactSensitive_ = (text) => {
  if (!text) return text;
  let out = text;
  SENSITIVE_KEYS_.forEach((key) => {
    out = out.replace(new RegExp(`(${key}=)[^&]*`, "g"), "$1***");
    out = out.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "g"), "$1***$2");
  });
  return out;
};

// ---------------------------------------------------------------------------
// UrlFetchApp（グローバル fetch のラッパー。GASのレスポンスAPIに合わせる）
// ---------------------------------------------------------------------------
const UrlFetchApp = {
  /** @returns {Promise<{getResponseCode: () => number, getContentText: () => string, getHeaders: () => object}>} */
  fetch: async (url, options = {}) => {
    let method = (options.method || "get").toUpperCase();
    let headers = Object.assign({}, options.headers || {});
    let body;

    if (options.payload != null) {
      if (typeof options.payload === "string") {
        body = options.payload;
      } else if (options.contentType && options.contentType.indexOf("application/json") === 0) {
        body = JSON.stringify(options.payload);
      } else {
        // GASのpayloadオブジェクト（application/x-www-form-urlencoded想定）をform encodeする
        body = new URLSearchParams(options.payload).toString();
      }
    }
    if (options.contentType) headers["Content-Type"] = options.contentType;

    if (process.env.INFOMART_DEBUG_HTTP) {
      Logger.log(`[HTTP →] ${method} ${url} body=${redactSensitive_(body) || "(none)"}`);
    }

    let res = await fetch(url, { method: method, headers: headers, body: body });
    let text = await res.text();

    if (process.env.INFOMART_DEBUG_HTTP) {
      Logger.log(`[HTTP ←] status=${res.status} body=${redactSensitive_(text).slice(0, 1000)}`);
    }

    return {
      getResponseCode: () => res.status,
      getContentText: () => text,
      getHeaders: () => Object.fromEntries(res.headers.entries())
    };
  }
};

module.exports = { Logger, PropertiesService, CacheService, Utilities, UrlFetchApp, STATE_DIR };
