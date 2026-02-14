/**
 * config.gs - 全ファイル共通の設定
 * * GASでは同じプロジェクト内のスクリプトファイル間でグローバル変数が共有されます。
 * スプレッドシートの列を挿入・削除した場合は、ここの数値を修正してください。
 */

// COLに追加したら、","を忘れない！

const COL = {
  SESSION_ID: 0,                 // A列
  TIMESTAMP_START: 1,            // B列
  LOGICAL_DATE: 2,               // C列
  USER_ID: 3,                    // D列
  THEME: 4,                      // E列
  EVAL_NOTE: 5,                  // F列
  STATUS: 6,                     // G列
  REMIND_COUNT: 7,               // H列
  NEXT_REMIND_AT: 8,             // I列
  TIMESTAMP_END: 9,              // J列
  AI_ANALYZE_EVALUATION: 10,     // K列
  BULL_COUNT: 11,                // L列
  LOWTON_COUNT: 12,              // M列
  RANGE: 13,                     // N列
  TIME_PLAYED_ON_DARTSLIVE: 14   // O列
};

// 数値入力項目の定義（順番、ラベル、列の対応）
const NUMERIC_COL_DEFINITIONS = [
  { label: 'BULL数', col: COL.BULL_COUNT },
  { label: 'LowTon数', col: COL.LOWTON_COUNT },
  { label: 'Range', col: COL.RANGE },
  { label: 'DARTSLIVEプレイ時間', col: COL.TIME_PLAYED_ON_DARTSLIVE }
];

// 入力をスキップするためのマジックワード
const SKIP_KEYWORD = '-';

// スクリプトプロパティから取得する共通設定
const PROPERTIES = PropertiesService.getScriptProperties();
const SPREADSHEET_ID = PROPERTIES.getProperty('SPREADSHEET_ID');
const ACCESS_TOKEN = PROPERTIES.getProperty('LINE_ACCESS_TOKEN');
const CHANNEL_SECRET = PROPERTIES.getProperty('LINE_CHANNEL_SECRET');
const GEMINI_API_KEY = PROPERTIES.getProperty('GEMINI_API_KEY');

// システム定数
const GEMINI_MODEL = 'gemini-flash-latest';
