/**
 * main.gs - Naiguru Insights (v1.5.2)
 * * 変更点:
 * 1. v1.4a からリマインド機能 (checkAndSendReminders) を復元し、COL定数に対応
 * 2. ロギング機能の追加
 * 3. プッシュメッセージ送信関数の追加
 */

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    const events = contents.events;
    
    for (const event of events) {
      const userId = event.source.userId;
      // ログ：受信イベントの記録
      console.log(`[Webhook] Event: ${event.type}, User: ${userId}`);

      if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();
        const currentSession = getUserStatus(userId);

        if (userText.toUpperCase() === '練習開始RENSHU') {
          handleStartEvent(event);
        } else if (userText.toUpperCase() === '振り返り開始FURIKAERI') {
          handleReviewStartEvent(event, currentSession);
        } else if (currentSession) {
          handleNaiguruMessage(event, currentSession, userText);
        }
      }
    }
  } catch (e) {
    console.error(`[Critical Error] ${e.toString()}`);
  }
}

/**
 * 練習開始処理
 */
function handleStartEvent(event) {
  const userId = event.source.userId;
  console.log(`[Start] Handling start event for User: ${userId}`);
  const logicalDate = getLogicalDate(new Date());
  
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  
  for (let i = data.length - 1; i >= 1; i--) {
    const status = data[i][COL.STATUS];
    if (data[i][COL.USER_ID] === userId && 
        (status === 'OPEN' || status === 'ACTIVE' || status === 'REVIEW_READY')) {
      replyLineMessage(event.replyToken, "既に練習は開始されています。目標を入力するか、振り返りを行ってください。");
      return;
    }
  }

  const sessionId = userId + "_" + new Date().getTime();
  const rowSize = Object.keys(COL).length;
  const newRow = new Array(rowSize).fill("");
  
  newRow[COL.SESSION_ID] = sessionId;
  newRow[COL.TIMESTAMP_START] = new Date();
  newRow[COL.LOGICAL_DATE] = logicalDate;
  newRow[COL.USER_ID] = userId;
  newRow[COL.STATUS] = "OPEN";
  newRow[COL.REMIND_COUNT] = 0;
  
  sheet.appendRow(newRow);
  console.log(`[Start] Created session: ${sessionId} at Row: ${sheet.getLastRow()}`);

  const pastEval = getPastEvaluation(userId);
  const welcomeMsg = `練習を開始しました！\n前回の振り返りの内容です\n\n${pastEval}\n\n今日の目標を入力してください。`;
  
  replyLineMessage(event.replyToken, welcomeMsg);
}

/**
 * 過去の振り返り取得 (AI要約優先)
 */
function getPastEvaluation(userId) {
  console.log(`[PastEval] Getting past evaluation for User: ${userId}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][COL.USER_ID] === userId && data[i][COL.STATUS] === 'CLOSED') {
      const AI_ANALYZE_EVALUATION = data[i][COL.AI_ANALYZE_EVALUATION];
      if (AI_ANALYZE_EVALUATION && AI_ANALYZE_EVALUATION !== "") {
        console.log(`[PastEval] AI Summary found for User: ${userId}`);
        return AI_ANALYZE_EVALUATION;
      } else {
        console.log(`[PastEval] AI Summary NOT found, using default for User: ${userId}`);
        return "前回はナイス練習でした！今日も目標を持って頑張りましょう。";
      }
    }
  }
  return "今日から新しい記録の始まりです！";
}

/**
 * メッセージ受信による状態遷移
 */
function handleNaiguruMessage(event, session, userText) {
  console.log(`[Message] Handling message from User: ${session.userId || event.source.userId}, Status: ${session.status}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const rowIndex = session.rowIndex;

  if (session.status === 'OPEN') {
    sheet.getRange(rowIndex, COL.THEME + 1).setValue(userText);
    sheet.getRange(rowIndex, COL.STATUS + 1).setValue('ACTIVE');
    
    // リマインド予定：3時間後
    const nextRemind = new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
    sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(nextRemind);
    
    console.log(`[Message] Target set for Row: ${rowIndex}. Status -> ACTIVE`);
    replyLineMessage(event.replyToken, `目標「${userText}」を受け付けました。\n練習が終わったら「振り返り開始FURIKAERI」と送ってください。`);

  } else if (session.status === 'REVIEW_READY') {
    sheet.getRange(rowIndex, COL.EVAL_NOTE + 1).setValue(userText);
    sheet.getRange(rowIndex, COL.STATUS + 1).setValue('CLOSED');
    sheet.getRange(rowIndex, COL.TIMESTAMP_END + 1).setValue(new Date());
    sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(""); 

    console.log(`[Message] Review completed for Row: ${rowIndex}. Status -> CLOSED`);
    console.log(`[Trigger] Scheduling AI analysis: summarizeDartsPracticeSession for Row: ${rowIndex}...`);
    
    ScriptApp.newTrigger('summarizeDartsPracticeSession')
      .timeBased()
      .after(60 * 1000)
      .create();

    replyLineMessage(event.replyToken, "練習お疲れ様でした！振り返りを記録しました。");
  }
}

/**
 * リマインド・自動終了バッチ
 * ※ 1時間おき等の時間主導型トリガーで実行
 */
function checkAndSendReminders() {
  const logPrefix = "[RemindBatch]";
  console.log(`${logPrefix} Starting reminder batch process...`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  
  for (let i = 1; i < data.length; i++) {
    const status = data[i][COL.STATUS];
    const nextRemindAt = data[i][COL.NEXT_REMIND_AT];
    const userId = data[i][COL.USER_ID];
    const remindCount = parseInt(data[i][COL.REMIND_COUNT] || 0);
    const rowIndex = i + 1;

    if ((status === 'ACTIVE' || status === 'REVIEW_READY') && nextRemindAt && new Date(nextRemindAt) <= now) {
      if (remindCount < 4) {
        // リマインド送信
        pushLineMessage(userId, "練習の調子はいかがですか？🎯\n終わったら「振り返り開始」から記録を付けましょう！");
        console.log(`${logPrefix} Sent reminder to User: ${userId} (Count: ${remindCount + 1})`);
        
        const nextTime = new Date();
        nextTime.setHours(nextTime.getHours() + 3);
        sheet.getRange(rowIndex, COL.REMIND_COUNT + 1).setValue(remindCount + 1);
        sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(nextTime);
      } else {
        // 自動終了
        pushLineMessage(userId, "長時間反応がなかったため、セッションを自動終了しました。お疲れ様でした。");
        console.log(`${logPrefix} Auto-closed session for User: ${userId} (Max reminders reached)`);
        
        sheet.getRange(rowIndex, COL.STATUS + 1).setValue('CLOSED_EXPIRED');
        sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue("");
        sheet.getRange(rowIndex, COL.TIMESTAMP_END + 1).setValue(new Date());
      }
    }
  }
}

/**
 * 振り返り開始イベント
 */
function handleReviewStartEvent(event, session) {
  console.log(`[ReviewStart] Handling review start for User: ${event.source.userId}`);
  if (!session || (session.status !== 'OPEN' && session.status !== 'ACTIVE')) {
    replyLineMessage(event.replyToken, "練習が開始されていないか、既に振り返り待ちです。");
    return;
  }
  
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  sheet.getRange(session.rowIndex, COL.STATUS + 1).setValue('REVIEW_READY');
  
  replyLineMessage(event.replyToken, "練習お疲れ様でした！今日の振り返りを入力してください。");
}

/**
 * ユーザーの現在の進行中セッションを取得
 */
function getUserStatus(userId) {
  console.log(`[Status] Checking status for User: ${userId}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const status = data[i][COL.STATUS];
    if (data[i][COL.USER_ID] === userId && 
       (status === 'OPEN' || status === 'ACTIVE' || status === 'REVIEW_READY')) {
      return { rowIndex: i + 1, status: status };
    }
  }
  return null;
}

/**
 * 30時基準の日付
 */
function getLogicalDate(date) {
  console.log(`[Date] Calculating logical date for: ${date}`);
  const d = new Date(date.getTime());
  d.setHours(d.getHours() - 6);
  return Utilities.formatDate(d, "JST", "yyyy-MM-dd");
}

/**
 * LINE応答
 */
function replyLineMessage(replyToken, text) {
  console.log(`[Reply] Sending reply: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
  const url = 'https://api.line.me/v2/bot/message/reply';
  UrlFetchApp.fetch(url, {
    'headers': {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': 'Bearer ' + ACCESS_TOKEN,
    },
    'method': 'post',
    'payload': JSON.stringify({
      'replyToken': replyToken,
      'messages': [{ 'type': 'text', 'text': text }]
    })
  });
}

/**
 * LINEプッシュ通知
 */
function pushLineMessage(userId, text) {
  console.log(`[Push] Sending push message to ${userId}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
  const url = 'https://api.line.me/v2/bot/message/push';
  UrlFetchApp.fetch(url, {
    'headers': {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': 'Bearer ' + ACCESS_TOKEN,
    },
    'method': 'post',
    'payload': JSON.stringify({
      'to': userId,
      'messages': [{ 'type': 'text', 'text': text }]
    })
  });
}