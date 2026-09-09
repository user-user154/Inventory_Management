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
  MANUAL_ADJUSTMENT_LOG: "AI予測手動調整ログ",
  POS_RAW: "POSデータ_生",
  POS_CLEAN: "POSデータ_整形後",
  ORDER_FORM: "指示書",
  BACKLOG: "バックログ",
  FORECAST_DEMAND_LOG: "予測出数ログ",
  NAME_UNIFY_MASTER: "名寄せマスタ",
  YIELD_MASTER: "歩留まりマスタ",
  ACTUAL_SALES_LOG: "実績出数ログ",
  INFOMART_INVOICE_LOG: "Infomart請求書ログ",
  INFOMART_ORDER_DELIVERY_LOG: "Infomart受発注ログ",
  INFOMART_ITEM_MASTER: "Infomart商品マスタ"
};

const SALES_TAX_RATE = 0.10;
const POS_SALES_HEADER_EX_TAX = "純売上(税抜)";

/** スマレジ・プラットフォームAPI 接続先（本番。契約IDはシークレットではないためここに置く。
 *  クライアントID/シークレットはスクリプトプロパティ POS_CLIENT_ID / POS_CLIENT_SECRET） */
const SMAREGI_CONFIG = {
  contractId: "spy565k6",
  idBase: "https://id.smaregi.jp",
  apiBase: "https://api.smaregi.jp"
};

/** インフォマート BtoBプラットフォームAPI 接続先（契約情報はシークレットではないためここに置く。
 *  全店舗共通のクライアントID/シークレットはスクリプトプロパティ INFOMART_CLIENT_ID /
 *  INFOMART_CLIENT_SECRET。店舗ごとのPFID（ログインID・パスワード）は INFOMART_CREDENTIALS、
 *  リフレッシュトークンは INFOMART_REFRESH_TOKENS に、それぞれ店舗名をキーにしたJSONマップ
 *  として格納する（どちらもコードが自動で読み書きするため手動設定不要）。詳細はinfomart.gs参照。
 *  初回取得・リフレッシュトークン失効時は POST /api/credentials/access_token
 *  （リソースオーナー・パスワード・クレデンシャルズフロー）を使い、以後の再発行は
 *  POST /openam/oauth2/access_token（grant_type=refresh_token）で行う。 */
const INFOMART_CONFIG = {
  authBaseProd: "https://auth.infomart.co.jp",
  authBaseTest: "http://authtest.infomart.co.jp",
  apiBase: "https://api.infomart.co.jp",
  invoiceApiBase: "https://api.infomart.co.jp", // TODO: 請求書APIの実際のホストを本番疎通確認時に確認・修正する
  realm: "/api",
  useTestEnv: false // テスト環境の資格情報が入手できないため本番環境を使用（本番でのAPI呼び出しには注意）
};
