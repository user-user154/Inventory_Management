/**
 * 0. constants.gs: 全ファイル共通の定数（ここだけで宣言。他ファイルで再宣言しない）
 */

const SHEET_NAMES = {
  STOCK_TAKING: "棚卸し表",
  RAW_MASTER: "原材料マスタ",
  PREPARATION_RECIPE: "中間レシピ表",
  RECIPE_MASTER: "レシピ表",
  BUDGET_ACTUAL: "予算・実績",
  VENDOR_MASTER: "発注業者マスタ",
  MANUAL_LOG: "確定指示ログ",
  MANUAL_ADJUSTMENT_LOG: "AI予測手動調整ログ",
  POS_RAW: "POSデータ_生",
  POS_CLEAN: "POSデータ_整形後",
  ORDER_FORM: "指示書",
  BACKLOG: "バックログ",
  FORECAST_DEMAND_LOG: "予測出数ログ",
  NAME_UNIFY_MASTER: "名寄せマスタ",
  YIELD_MASTER: "歩留まりマスタ",
  ACTUAL_SALES_LOG: "実績出数ログ"
};

const SALES_TAX_RATE = 0.10;
const POS_SALES_HEADER_EX_TAX = "純売上(税抜)";

/** スマレジ・プラットフォームAPI 接続先（契約IDはシークレットではないためここに置く。
 *  クライアントID/シークレットはスクリプトプロパティ SMAREGI_CLIENT_ID / SMAREGI_CLIENT_SECRET） */
const SMAREGI_CONFIG = {
  contractId: "sb_skt584z8",
  idBase: "https://id.smaregi.dev",
  apiBase: "https://api.smaregi.dev"
};
