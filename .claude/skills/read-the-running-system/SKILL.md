---
name: read-the-running-system
description: Use when the user reports that a running app misbehaves ("還是沒有" / "沒反應" / "偵測不到" / "看不到") and you are about to form a hypothesis by reading source code. Forces reading the live system's own numbers first — console, DOM/panel fields, instrumentation — before any guess. Applies to browser apps, long-running processes, games, realtime pipelines, anything with observable runtime state.
---

# Read the Running System(先讀跑起來的那個，不要讀原始碼猜)

使用者說「還是沒有」的時候，程式碼不會告訴你答案 —— 因為**值都對、邏輯都對、
測試都綠，bug 在算出來的執行期狀態裡**。

來源：2026-10-09 體感切水果。使用者連續回報三次「手掌沒出現」。
我讀程式碼猜了四輪，每一輪都是一個**合理但錯的**假設（信心門檻、骨鏈幾何、
左右配對、校正值）。真因要讀到跑起來的數字才看得見，而且是**三個獨立的 bug
疊在一起**，每一個單獨都足以讓功能完全失效 —— 所以前兩次修完「還是沒有」，
看起來像沒修對，其實是還有兩層。

## 鐵則

**使用者回報執行期行為異常 → 第一個動作是取得執行期的數字，不是打開檔案。**

不准在取得數字之前說出任何「我想原因是 X」。
猜一輪的成本是使用者再操作一次、再截圖一次、再等你一次。

## 怎麼取得數字（由好到壞）

### 1. 直接讀使用者正在跑的那個 process（最好）

瀏覽器的話，Playwright 通常已經接在使用者的分頁上。

**先確定 log 落在哪裡，這件事比什麼都重要。**
Playwright MCP 會把**每一條** console 訊息寫到工作目錄下的檔案：

```sh
NEW=$(ls -t .playwright-mcp/console-*.log | head -1)   # 最新的那個就是現在這條
tail -200 "$NEW"
grep '關鍵字' "$NEW" | tail -20
ls -t .playwright-mcp/console-*.log | tail -n +6 | xargs -r rm --   # 只留最近 5 個
```

**只留最近 5 個。** 舊的檔看了只會害人判斷錯一輪 —— 而且它們長得一模一樣，
很容易打開錯的那個還以為自己在看現況。最好把「取最新 + 修剪」包成一個
專案裡的指令（這個專案是 `./menu.sh pwlog [關鍵字]`），不要靠記性。

每行長這樣，帶時間戳、層級、以及 `file:line`：

```
[ 3266304ms] [LOG] [無刀] 門檻=0.12 校正前臂=149 … @ http://localhost:8777/app.js:2022
```

**重新導航／重載只是開一個新檔，舊的不會消失** —— 所以導航本身不是問題，
問題是你有沒有去看對的那個檔。導航前先記下現在是哪一個，或直接用 `ls -t`
取最新的。（把這個目錄加進 `.gitignore`。）

三個不打斷使用者就能用的工具：

```
browser_tabs(action="list")              確認接到的是哪個分頁
browser_console_messages()               讀目前分頁的 console 緩衝
browser_evaluate(() => ...)              讀 DOM / 面板欄位
```

需要重載時用 `browser_evaluate(() => location.reload())` 或
`browser_navigate` 都可以，先跟使用者講一聲（相機、遊戲進度、
未存的輸入會沒掉），然後記得去讀**新的**那個 log 檔。

讀面板欄位比請使用者截圖快一個數量級，而且不會被裁切、不會看錯：

```js
browser_evaluate(() => {
  const g = (id) => document.getElementById(id)?.textContent;
  return { state: g('m-state'), track: g('m-track'), /* ... */ };
})
```

### 2. 加 instrumentation，但加在 console

```js
// 失敗的時候每秒印一次完整狀態。節流，不然 console 爆掉。
let lastDiagAt = 0;
if (failing && now - lastDiagAt > 1000) {
  lastDiagAt = now;
  console.log('[狀態] ' + 所有相關的數值);
}
```

**不要畫在畫面上。** 畫面有邊界、有版面、會被裁切 —— 實際發生過：
診斷畫在 canvas 的 `y = 0.90 × 高`，最關鍵那一行超出下緣被切掉，
白白多一輪。而且使用者沒辦法複製貼上給你。

一行要印完整：每一個進入決策的量、它的門檻、以及**這一關過了沒**。
印 `鏈=true 續=false(0.00) 強=true` 比印 `失敗` 有用一百倍。

### 3. 請使用者貼 console（次之）

比截圖好，因為是文字。但仍然要先把 instrumentation 寫好。

### 4. 請使用者截圖（最差）

會被裁切、數字看不清、面板捲到看不見的部分拍不到。只在前三個都不可行時用。

## 讀到數字之後

**一個恆定不變的數字就是答案所在。** 例：

```
Λ=-2.99  Λ=-2.99  Λ=-2.99  ...  32 筆取樣一動也不動
續=false(0.00)  續=false(0.00)  ...  全部剛好 0.00
```

「剛好 0.00、一次都沒變」不是巧合，是某條路徑每次都走同一個 early return。
往回追那個量是誰寫的、什麼條件下被清掉。

這題的答案是：`Λ` 一碰到下界就把 `chainHist` 清掉，而 `continuity` 完全
依賴 `chainHist` —— **證據的來源被「證據不足」這件事本身摧毀了**。
典型的吸收態。

## 連續「還是沒有」要當成「還有下一層」

修完一個真 bug，使用者說「還是沒有」—— 不要假設上一個修錯了。
**先確認上一個修的那一關現在過了**（讀數字），過了就往下一關找。

這題三層：
1. `armsDistinct` 讓 0.16 的猜測點否決 0.60 的真手臂
2. 校正值被幽靈樣本汙染成 40px，反過來把幾何檢查變成「超過 88px 就擋」
3. SPRT 死鎖（上面那個）

每一層都是真 bug、每一層都致命。只修前兩層，畫面上看起來完全沒變。

## 驗證：用同一個管道確認修好了

修完**不要只說「應該好了」**。用剛才讀數字的同一個管道，把修前修後的數字
並排列出來。這題是：

| | 修前 | 修後 |
|---|---|---|
| 軌跡證據 | −3.0 / −3.0 | 4.6✓ / 4.6✓ |
| 骨鏈 | 不合理 / 不合理 | 成立 / 成立 |
| 校正前臂 | 40 px | 249 px |
| 刀刃抓到率 | 0.0% | 98.4% |

沒有這張表就等於沒驗證。

## 每一個修正都要配一條會紅的測試，而且要做變異測試

把失效狀態本身寫成斷言，然後**把修正還原回去，確認測試真的變紅**。
沒跑過變異的測試不算數 —— 它可能從頭到尾都是綠的。

```sh
cp app.js /tmp/bak && <把修正改回舊的> && node tests/x.test.js   # 必須紅
cp /tmp/bak app.js && node tests/x.test.js                       # 必須綠
```

純邏輯（幾何、統計、狀態機、機率）不需要瀏覽器。用 regex 從原始檔抽函式出來
`eval`，測的就是**正在跑的那份**，不是一份會跟著漂走的複本：

```js
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const m = src.match(/  function chainOK\([\s\S]*?\n  \}/);
eval(m[0].replace(/^  function/, 'function'));
```

注意 `eval` 裡的 `const`/`let` 是 eval 自己的區塊作用域，外面拿不到；
`function` 宣告才會進到外層。取 `const foo = (…) => {…}` 要 eval 右手邊的運算式。

## 反模式

| 錯誤 | 正確 |
|---|---|
| 「我想是門檻太嚴」（還沒讀數字） | 先讀數字。沒有數字不准有假設 |
| 讀程式碼找 bug | 程式碼看起來都對 —— 那正是它還在的原因 |
| 把診斷畫在畫面上 | 畫到 console。畫面會裁切，也不能複製 |
| 不知道 log 寫到哪，只好請使用者貼 | `ls -t .playwright-mcp/console-*.log \| head -1`，全部都在裡面 |
| 導航之後找不到 log 就放棄 | 導航只是開新檔。去讀最新的那個 |
| log 目錄堆了幾十個檔 | 只留最近 5 個。打開錯的那個會白白判斷錯一輪 |
| 使用者說「還是沒有」→ 假設上次修錯 | 先確認上次那一關過了，再找下一層 |
| 「應該好了，你試試看」 | 用同一個管道讀修後的數字，並排給他看 |
| 測試寫完是綠的就收工 | 把修正還原，確認測試會紅 |
| 使用者反駁你 → 立刻改口 | 兩邊都要有證據。沒查證就改口跟沒查證就斷言一樣糟 |
