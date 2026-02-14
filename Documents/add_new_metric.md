# 数値記録項目の追加手順

スプレッドシートに新しい数値入力項目（例：ハットトリック数、ダブル率など）を追加する際の手順です。

## 1. スプレッドシート側の準備
1.  Googleスプレッドシートの「Logs」シートを開きます。
2.  一番右側の列（または適切な位置）に新しい列を追加し、ヘッダー（1行目）に項目名を記入します。
    *   例：P列に「ハットトリック数」を追加。

## 2. スクリプトの修正（`Scripts/config.gs`）

`Scripts/config.gs` を開き、2箇所を修正します。

### ① `COL` 定数の更新
追加した列のインデックス（0から数えた番号）を `COL` オブジェクトに追加します。

```javascript
const COL = {
  // ... 既存の項目 ...
  TIME_PLAYED_ON_DARTSLIVE: 14,  // O列
  HAT_TRICK_COUNT: 15            // P列 (新しく追加)
};
```

### ② `NUMERIC_COL_DEFINITIONS` への追加
LINEで質問したい順番に合わせて、新しい項目を配列に追加します。

```javascript
const NUMERIC_COL_DEFINITIONS = [
  { label: 'BULL数', col: COL.BULL_COUNT },
  { label: 'LowTon数', col: COL.LOWTON_COUNT },
  { label: 'Range', col: COL.RANGE },
  { label: 'DARTSLIVEプレイ時間', col: COL.TIME_PLAYED_ON_DARTSLIVE },
  { label: 'ハットトリック数', col: COL.HAT_TRICK_COUNT } // LINEで聞きたい名前と、上で定義したCOLを指定
];
```

*   `label`: LINEのメッセージで「〇〇を入力してください」と表示される名前になります。
*   `col`: `COL` 定数で定義した値を指定します。

## 3. 反映（デプロイ）
修正が終わったら、変更を保存してデプロイします。

```bash
clasp push
```

## 注意事項
*   **列番号の重複に注意**: `COL` 定数を設定する際、他の項目と番号が重ならないようにしてください。
*   **カンマを忘れない**: `COL` や `NUMERIC_COL_DEFINITIONS` に項目を足した際、末尾のカンマ `,` を忘れると構文エラーになります。
*   **スキップ機能**: 新しい項目も自動的にハイフン `-` での入力スキップに対応します。
