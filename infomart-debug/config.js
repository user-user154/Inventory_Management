"use strict";
/**
 * INFOMART_CONFIG（constants.gs のInfomart部分そのまま。値はシークレットではないので直書き）
 * useTestEnv だけ環境変数 INFOMART_USE_TEST_ENV=1 で上書きできるようにしてある
 * （GAS側は constants.gs を直接編集して切り替える運用のため、これはNode版だけの拡張）。
 */
const INFOMART_CONFIG = {
  authBaseProd: "https://auth.infomart.co.jp",
  authBaseTest: "http://authtest.infomart.co.jp",
  apiBase: "https://api.infomart.co.jp",
  invoiceApiBase: "https://api.infomart.co.jp",
  realm: "/api",
  useTestEnv: process.env.INFOMART_USE_TEST_ENV === "1"
};

module.exports = { INFOMART_CONFIG };
