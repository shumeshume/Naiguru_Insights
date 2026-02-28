/**
 * main.gs - Naiguru Insights (v1.7.1)
 * 1.Messaging APIの署名検証機能を実装
 * 2.Webhook検証時の空イベントによるエラーを回避
 */

/**
 * LINE Webhookからのリクエストを処理するエントリポイント
 */
function doPost(e) {
  // 署名検証
  if (!validateSignature(e)) {
    return ContentService.createTextOutput(JSON.stringify({ content: "post ok" })).setMimeType(ContentService.MimeType.JSON);
  }

  // 短い間隔でのメッセージ受信による競合を防ぐためのロックを取得
  const lock = LockService.getUserLock();
  try {
    // 最大10秒間待機
    lock.waitLock(10000);

    const contents = JSON.parse(e.postData.contents);
    
    // LINEからの検証リクエスト等、イベントが空の場合は正常終了させる
    if (!contents.events || contents.events.length === 0) {
      console.log("[Webhook] No events found. (Validation request or empty event)");
      return;
    }

    const events = contents.events;
    
    for (const event of events) {
      const userId = event.source.userId;
      console.log(`[Webhook] Event: ${event.type}, User: ${userId}`);

      // テキストメッセージイベントのみを処理対象とする
      if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();
        const currentSession = getUserStatus(userId);

        // キーワードに応じた処理分岐
        if (userText.toUpperCase() === '練習開始RENSHU') {
          handleStartEvent(event);
        } else if (userText.toUpperCase() === '振り返り開始FURIKAERI') {
          handleReviewStartEvent(event, currentSession);
        } else if (currentSession) {
          // 進行中のセッションがある場合は、メッセージ内容に応じた更新処理を行う
          handleNaiguruMessage(event, currentSession, userText);
        }
      }
    }
  } catch (e) {
    console.error(`[Critical Error] ${e.toString()}`);
  } finally {
    // 処理が完了したらロックを解放
    lock.releaseLock();
  }
}

/**
 * 練習開始処理：新規セッションの作成と二重開始の防止
 */
function handleStartEvent(event) {
  const userId = event.source.userId;
  console.log(`[Start] Handling start event for User: ${userId}`);
  const logicalDate = getLogicalDate(new Date());
  
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  
  // 既に進行中（OPEN, ACTIVE, REVIEW_READY）のセッションがないか確認
  for (let i = data.length - 1; i >= 1; i--) {
    const status = data[i][COL.STATUS];
    if (data[i][COL.USER_ID] === userId && 
        (status === 'OPEN' || status === 'ACTIVE' || status === 'REVIEW_READY')) {
      replyLineMessage(event.replyToken, "既に練習は開始されています。目標を入力するか、振り返りを行ってください。");
      return;
    }
  }

  // 新規セッション情報の作成
  const sessionId = userId + "_" + new Date().getTime();
  const rowSize = Object.keys(COL).length;
  const newRow = new Array(rowSize).fill("");
  
  newRow[COL.SESSION_ID] = sessionId;
  newRow[COL.TIMESTAMP_START] = new Date();
  newRow[COL.LOGICAL_DATE] = logicalDate; // 30時基準の日付
  newRow[COL.USER_ID] = userId;
  newRow[COL.STATUS] = "OPEN";
  newRow[COL.REMIND_COUNT] = 0;
  
  sheet.appendRow(newRow);
  console.log(`[Start] Created session: ${sessionId} at Row: ${sheet.getLastRow()}`);

  // 前回の振り返り内容を添えてリプライ
  const pastEval = getPastEvaluation(userId);
  const welcomeMsg = `練習を開始しました！\n前回の振り返りの内容です\n\n${pastEval}\n\n今日の目標を入力してください。`;
  
  replyLineMessage(event.replyToken, welcomeMsg);
}

/**
 * 過去の振り返り内容を取得する
 * 直近の完了済みセッション(CLOSED)からAI要約を優先して取得し、なければ固定メッセージを返す
 */
function getPastEvaluation(userId) {
  console.log(`[PastEval] Getting past evaluation for User: ${userId}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  
  // ログを末尾から検索して直近のCLOSEDセッションを探す
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][COL.USER_ID] === userId && data[i][COL.STATUS] === 'CLOSED') {
      const AI_ANALYZE_EVALUATION = data[i][COL.AI_ANALYZE_EVALUATION];
      if (AI_ANALYZE_EVALUATION && AI_ANALYZE_EVALUATION !== "") {
        console.log(`[PastEval] AI Summary found for User: ${userId}`);
        return AI_ANALYZE_EVALUATION;
      } else {
        // AI要約がまだ生成されていない場合のフォールバック
        console.log(`[PastEval] AI Summary NOT found, using default for User: ${userId}`);
        return "前回はナイス練習でした！今日も目標を持って頑張りましょう。";
      }
    }
  }
  return "今日から新しい記録の始まりです！";
}

/**
 * 進行中のセッション状態に応じたメッセージ処理
 */
function handleNaiguruMessage(event, session, userText) {
  console.log(`[Message] Handling message from User: ${session.userId || event.source.userId}, Status: ${session.status}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const rowIndex = session.rowIndex;

  if (session.status === 'OPEN') {
    // 目標設定フェーズ：入力されたテキストを目標(THEME)として保存し、ステータスをACTIVEへ
    sheet.getRange(rowIndex, COL.THEME + 1).setValue(userText);
    sheet.getRange(rowIndex, COL.STATUS + 1).setValue('ACTIVE');
    
    // 初回リマインドを3時間後に設定
    const nextRemind = new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
    sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(nextRemind);
    
    console.log(`[Message] Target set for Row: ${rowIndex}. Status -> ACTIVE`);
    replyLineMessage(event.replyToken, `目標「${userText}」を受け付けました。\n練習が終わったら「振り返り開始FURIKAERI」と送ってください。`);

  } else if (session.status === 'REVIEW_READY' || session.status === 'DATA_INPUT') {
    // 現在のシートデータを取得して、実際の入力状況を確認する
    const lastCol = sheet.getLastColumn();
    const rowValues = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    const evalNote = rowValues[COL.EVAL_NOTE];
    const nextItem = getNextNumericItem(rowValues);

    // 振り返り文 (F列) がまだ入力されていない場合は保存する
    if (!evalNote || evalNote === "") {
      sheet.getRange(rowIndex, COL.EVAL_NOTE + 1).setValue(userText);
      // 振り返り保存後は、数値入力待ち状態 (DATA_INPUT) に移行
      sheet.getRange(rowIndex, COL.STATUS + 1).setValue('DATA_INPUT');
      SpreadsheetApp.flush(); // 即座に反映させて、次の判定で最新の値を読み取れるようにする
      console.log(`[Message] Review note saved and Status -> DATA_INPUT for Row: ${rowIndex}.`);

      // 数値入力が必要な項目があるかチェック
      const updatedRowValues = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
      const firstNumericItem = getNextNumericItem(updatedRowValues);

      if (firstNumericItem) {
        let exampleMsg = "";
        if (firstNumericItem.type === 'time') {
          exampleMsg = "（例：1:30）";
        }
        const msg = `振り返りを記録しました。\n次に数値を入力してください。\n\n${firstNumericItem.label}を入力してください。${exampleMsg}\n（スキップする場合は「${SKIP_KEYWORD}」を入力）`;
        replyLineMessage(event.replyToken, msg);
      } else {
        // 数値項目がない場合は終了
        finalizeSession(sheet, rowIndex, event.replyToken);
      }

    } else if (nextItem) {
      // 既に振り返り文がある場合は、数値入力として処理する
      // ステータスが DATA_INPUT でない場合は補正
      if (session.status !== 'DATA_INPUT') {
        sheet.getRange(rowIndex, COL.STATUS + 1).setValue('DATA_INPUT');
      }

      if (userText === SKIP_KEYWORD) {
        // スキップ：ハイフンを書き込んで「入力済み」扱いにする（空文字判定を避けるため）
        sheet.getRange(rowIndex, nextItem.col + 1).setValue("-");
        console.log(`[Message] Skipped input for ${nextItem.label}`);
      } else if (nextItem.type === 'time') {
        // 時間形式 (hh:mm) のバリデーション
        const timeRegex = /^([0-9]{1,2}):([0-9]{2})$/;
        if (timeRegex.test(userText)) {
          sheet.getRange(rowIndex, nextItem.col + 1).setValue(userText);
          console.log(`[Message] Saved ${nextItem.label}: ${userText}`);
        } else {
          replyLineMessage(event.replyToken, `${nextItem.label}を hh:mm 形式（例：1:30）で入力してください。スキップする場合は「${SKIP_KEYWORD}」を入力してください。`);
          return;
        }
      } else {
        // 通常の数値バリデーション
        const num = Number(userText);
        if (!isNaN(num) && userText !== "") {
          sheet.getRange(rowIndex, nextItem.col + 1).setValue(num);
          console.log(`[Message] Saved ${nextItem.label}: ${num}`);
        } else {
          replyLineMessage(event.replyToken, `数値を入力してください。スキップする場合は「${SKIP_KEYWORD}」を入力してください。`);
          return;
        }
      }
      
      SpreadsheetApp.flush();

      // 次の項目をチェック
      const updatedRowValues = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
      const followingItem = getNextNumericItem(updatedRowValues);

      if (followingItem) {
        let exampleMsg = "";
        if (followingItem.type === 'time') {
          exampleMsg = "（例：1:30）";
        }
        replyLineMessage(event.replyToken, `${followingItem.label}を入力してください。${exampleMsg}\n（スキップする場合は「${SKIP_KEYWORD}」を入力）`);
      } else {
        // 全ての数値入力が完了
        finalizeSession(sheet, rowIndex, event.replyToken);
      }
    } else {
      // 振り返りも数値も全て埋まっている場合
      finalizeSession(sheet, rowIndex, event.replyToken);
    }
  }
}

/**
 * セッションを完了状態にし、AI解析を予約する
 */
function finalizeSession(sheet, rowIndex, replyToken) {
  sheet.getRange(rowIndex, COL.STATUS + 1).setValue('CLOSED');
  sheet.getRange(rowIndex, COL.TIMESTAMP_END + 1).setValue(new Date());
  sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(""); // リマインド停止

  console.log(`[Message] Session finalized for Row: ${rowIndex}. Status -> CLOSED`);
  
  // 1分後にAI解析（要約生成）を実行するトリガーを予約
  console.log(`[Trigger] Scheduling AI analysis: summarizeDartsPracticeSession for Row: ${rowIndex}...`);
  ScriptApp.newTrigger('summarizeDartsPracticeSession')
    .timeBased()
    .after(60 * 1000)
    .create();

  replyLineMessage(replyToken, "練習お疲れ様でした！全ての記録を完了しました。");
}

/**
 * 次に入力すべき数値項目を特定する
 */
function getNextNumericItem(rowValues) {
  for (const item of NUMERIC_COL_DEFINITIONS) {
    const val = rowValues[item.col];
    if (val === "" || val === null || val === undefined) {
      return item;
    }
  }
  return null;
}

/**
 * リマインド送信および長時間放置セッションの自動終了
 * 1時間おき等の時間主導型トリガーで実行されることを想定
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

    // リマインド対象：進行中かつ次回リマインド時刻を過ぎているもの
    if ((status === 'ACTIVE' || status === 'REVIEW_READY') && nextRemindAt && new Date(nextRemindAt) <= now) {
      if (remindCount < 4) {
        // リマインド送信：最大4回まで3時間おきに送信
        pushLineMessage(userId, "練習の調子はいかがですか？🎯\n終わったら「振り返り開始」から記録を付けましょう！");
        console.log(`${logPrefix} Sent reminder to User: ${userId} (Count: ${remindCount + 1})`);
        
        const nextTime = new Date();
        nextTime.setHours(nextTime.getHours() + 3);
        sheet.getRange(rowIndex, COL.REMIND_COUNT + 1).setValue(remindCount + 1);
        sheet.getRange(rowIndex, COL.NEXT_REMIND_AT + 1).setValue(nextTime);
      } else {
        // 自動終了：リマインド上限に達した場合は、セッションを期限切れとして終了
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
 * 「振り返り開始」キーワード受信時の処理
 */
function handleReviewStartEvent(event, session) {
  console.log(`[ReviewStart] Handling review start for User: ${event.source.userId}`);
  if (!session || (session.status !== 'OPEN' && session.status !== 'ACTIVE')) {
    replyLineMessage(event.replyToken, "練習が開始されていないか、既に振り返り待ちです。");
    return;
  }
  
  // ステータスを振り返り待ち(REVIEW_READY)に変更し、ユーザーにメッセージを促す
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  sheet.getRange(session.rowIndex, COL.STATUS + 1).setValue('REVIEW_READY');
  
  replyLineMessage(event.replyToken, "練習お疲れ様でした！今日の振り返りを入力してください。");
}

/**
 * ユーザーの現在の進行中セッション（OPEN, ACTIVE, REVIEW_READY, DATA_INPUT）を検索して取得
 */
function getUserStatus(userId) {
  console.log(`[Status] Checking status for User: ${userId}`);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Logs');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const status = data[i][COL.STATUS];
    const userMatches = data[i][COL.USER_ID] === userId;
    
    // 通常の進行中ステータス（数値入力待ちの DATA_INPUT を含む）
    if (userMatches && (status === 'OPEN' || status === 'ACTIVE' || status === 'REVIEW_READY' || status === 'DATA_INPUT')) {
      return { rowIndex: i + 1, status: status };
    }
  }
  return null;
}

/**
 * 30時基準の日付文字列を取得する（早朝の練習を前日分として扱うため）
 */
function getLogicalDate(date) {
  console.log(`[Date] Calculating logical date for: ${date}`);
  const d = new Date(date.getTime());
  d.setHours(d.getHours() - 6); // 6時間戻す
  return Utilities.formatDate(d, "JST", "yyyy-MM-dd");
}

/**
 * 指定された replyToken を使用して LINE に返信する
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

/**
 * LINE Messaging APIの署名検証を行う
 */
function validateSignature(e) {
  const signature = e.parameter['x-line-signature'] || e.headers['x-line-signature'];
  if (!signature) {
    console.error('[Signature] Missing signature');
    return false;
  }

  const channelSecret = CHANNEL_SECRET;
  const body = e.postData.contents;
  const hash = Utilities.computeHmacSha256Signature(body, channelSecret);
  const checkSignature = Utilities.base64Encode(hash);

  if (signature !== checkSignature) {
    console.error('[Signature] Invalid signature');
    return false;
  }

  console.log('[Signature] Validation successful');
  return true;
}
