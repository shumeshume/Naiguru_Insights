/**
 * gemini.gs - (v1.5.1)
 * * AI解析（要約）およびAPI通信を専門に行うモジュールです。
 * * config.gs の定義を使用して動作します。
 */

/**
 * 練習セッションの振り返りをAIで要約し、スプレッドシートに書き込む
 * メッセージ受信後に時間主導型トリガーから非同期で呼び出される
 */
function summarizeDartsPracticeSession() {
  const logPrefix = "[AI_Analysis]";
  
  if (!SPREADSHEET_ID) {
    console.error(`${logPrefix} SPREADSHEET_ID が未設定です。`);
    return;
  }

  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  
  // 1. 解析対象の特定：
  // シートを末尾から検索し、ステータスが「CLOSED」かつ「AI要約がまだ書き込まれていない」最新の行を探す
  let targetRowIndex = -1;
  let theme = "";
  let evaluationNote = "";
  let sessionId = "";

  for (let i = data.length - 1; i >= 1; i--) {
    const status = data[i][COL.STATUS];
    const aiNote = data[i][COL.AI_ANALYZE_EVALUATION];
    
    if (status === 'CLOSED' && (!aiNote || aiNote === "")) {
      targetRowIndex = i + 1;
      sessionId = data[i][COL.SESSION_ID];
      theme = data[i][COL.THEME];
      evaluationNote = data[i][COL.EVAL_NOTE];
      break;
    }
  }

  // 解析対象がない場合はトリガーを削除して終了
  if (targetRowIndex === -1) {
    console.log(`${logPrefix} 解析対象が見つかりませんでした。`);
    deleteTriggerByHandler_('summarizeDartsPracticeSession');
    return;
  }

  try {
    // 2. プロンプト構築：
    // 入力データ（目標と振り返り）に基づき、LINEで読みやすい形式の要約を依頼
    const prompt = `
あなたはダーツの練習ログを整理する専門のアシスタントです。
提供される「目標（Theme）」と「振り返り（Evaluation_Note）」に基づき、以下の制約を厳守して要約を作成してください。

■ 制約事項
1. 忠実性：ユーザーが書いた内容のみを使用し、AI独自の推測や一般的なアドバイスは加えない。
2. 形式：以下の3項目、かつ合計80文字以内で出力する。
   【目標】目標の成否や達成感
   【発見】目標以外で気づいた技術的・心理的ポイント
   【次】次回意識すべき具体的な課題や注意点
3. 視認性：LINEのトーク画面で読みやすいよう、項目ごとに適宜改行を入れる。
4. 文体：簡潔な体言止め（〜した。〜を確認。）を用いる。

■ 入力データ
Theme: ${theme}
Evaluation_Note: ${evaluationNote}
    `.trim();

    // 3. Gemini API 実行（外部通信）
    const summary = callGeminiCore_(prompt, sessionId);

    // 4. 解析結果の書き込み
    sheet.getRange(targetRowIndex, COL.AI_ANALYZE_EVALUATION + 1).setValue(summary);
    console.log(`${logPrefix} Success: Session ${sessionId}`);

  } catch (e) {
    console.error(`${logPrefix} Error: ${e.toString()}`);
  } finally {
    // 5. 使用済みトリガーの掃除：多重実行を防ぐため、処理完了（または失敗）後に自分自身のトリガーを削除
    deleteTriggerByHandler_('summarizeDartsPracticeSession');
  }
}

/**
 * Gemini API と通信を行うコア関数
 * 指数バックオフによるリトライ処理を行い、一時的な通信エラーに対処する
 */
function callGeminiCore_(prompt, logId) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let lastError;
  // 最大5回リトライ
  for (let i = 0; i < 5; i++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const resJson = JSON.parse(response.getContentText());
      if (response.getResponseCode() === 200) {
        // 正常終了時は解析結果のテキストを返す
        return resJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      }
      lastError = response.getContentText();
    } catch (e) {
      lastError = e.toString();
    }
    // 失敗時は待機時間を増やして再試行（1, 2, 4, 8, 16秒）
    if (i < 4) Utilities.sleep(Math.pow(2, i) * 1000);
  }
  throw new Error(`Gemini API Failed: ${lastError}`);
}

/**
 * 指定した名前を持つプロジェクトトリガーをすべて削除する
 * 不要な非同期処理の残存を防ぐためのユーティリティ
 */
function deleteTriggerByHandler_(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
