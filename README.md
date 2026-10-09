# 體感切水果

用一般視訊鏡頭取代 Kinect 的體感切水果。純前端，沒有後端，**影像不會離開你的瀏覽器**。

**▶︎ 線上試玩：https://tzyyung.github.io/body-fruit-ninja/**

需要一顆鏡頭和一個現代瀏覽器（Chrome、Edge、Safari 都可以）。手機和平板也能玩。

---

## 怎麼玩

1. 讓**肩膀、手肘、手腕**都進到畫面裡 —— 掌刀是從手肘算出來的，手肘出框就沒有刀。
2. 按「開啟相機」，瀏覽器會問要不要用鏡頭，選允許。
3. 揮手切水果。只有砍到炸彈會扣命，三條命用完才結束；**漏接不扣命**。
4. 坐著或站著都可以，離鏡頭 2–3 公尺最穩。

畫面右邊是量測面板 —— 那是開發用的儀器（幀率、推論耗時、刀刃抓到率、信心門檻…），
按畫面右上角的「量測」可以收起來。窄螢幕預設是收起來的。

## 這題難在哪

姿態估計本身是解決了的問題（MoveNet 直接拿來用就好）。難的是它之後的三件事：

| 問題 | 做法 |
|---|---|
| 模型對**沒舉起的那隻手**一樣會吐一組座標，而且看起來很合理 | 序列機率比檢定（SPRT, Wald 1945）累積證據，確認過才給刀 |
| 連續動作流裡怎麼認出「這是一次揮擊」 | 分段掃過長度；揮出去和拉回來算同一個動作，掉幀不切斷 |
| 單目沒有深度，手臂朝鏡頭時投影長度嚴重低估 | Taylor (2000) 的逐段 2D→3D 還原，用肩寬當尺規 |

在 12 種常見手勢（圓、方、三角、直線、橫線、斜線…）的合成語料上量到
**支援區域偵測率 95.0%、彎手臂 92.5%、誤報 0%**。

**完整的方法、公式、來源與量測結果在 [`docs/METHOD.md`](docs/METHOD.md)**，
寫成論文的形式：理論、為什麼這樣選、量到多少、以及犯過哪些錯。

## 第一次載入

辨識模型 4.6MB，開頁就會在背景開始下載，畫面上有進度。
兩個來源（GitHub Pages 與 jsDelivr）會**賽跑**，誰先抓完用誰 ——
實測 Pages 對大二進位檔限速到 43 KB/s（89 秒），jsDelivr 是 1385 KB/s（3 秒）。
之後進瀏覽器快取，再開就是即時的。

## 隱私

- 推論全部在瀏覽器裡跑（TensorFlow.js + WebGL／WebGPU）。
- **沒有任何畫面、座標或分數被送出去。** 沒有後端可以送。
- 唯一寫到硬碟的是最高分，放在瀏覽器的 localStorage。

## 本機跑

```sh
git clone https://github.com/tzyyung/body-fruit-ninja.git
cd body-fruit-ninja
./menu.sh open          # 起伺服器並開瀏覽器
```

**一定要從 `localhost` 或 `https` 開，不能直接雙擊 HTML 檔。**
`getUserMedia` 只在 secure context 下存在 —— 用 `file://` 開的話
`navigator.mediaDevices` 整個是 `undefined`，不是權限被拒，是 API 不見了。

其他指令：

```sh
./menu.sh check         # 語法、重複 id、CDN 可用性、本機模型
./menu.sh test          # 單元測試（14 檔 246 條）
node tests/bdd.js       # 驗收條件（Gherkin，繁中關鍵字，36 個場景）
./menu.sh models        # 重新下載模型權重
```

## 檔案配置

```
index.html       畫面骨架、面板、CDN script 標籤
app.js           全部的程式
models/          MoveNet 權重（本機讀 4ms；線上會跟 jsDelivr 賽跑，見下）
tests/           純邏輯單元測試 + 動作語料產生器 + Gherkin 執行器
features/        驗收條件（Gherkin）
docs/METHOD.md   方法與量測（理論、公式、為什麼、量到多少）
docs/DEV.md      操作細節、各項預設值與理由
CLAUDE.md        工作規範：怎麼動手、怎麼驗、踩過的坑
HANDOFF.md       現況與待辦
```

測試用 regex 從 `app.js` 抽出函式再 `eval` —— 測的是**正在跑的那一份**，
不是一份會跟著漂走的複本。細節見 [`CLAUDE.md`](CLAUDE.md) 第 3 節。

## 已知限制

- MoveNet 只有 COCO-17 個關節點，**最末端就是手腕，沒有任何手指**。
  掌刀是從前臂方向外推的，所以手肘的誤差會被放大 1.4 倍。
- 單人。畫面裡有兩個人的時候行為未定義。
- 深度是推論出來的，不是量到的。手臂完全朝向鏡頭時最不準。
- 難度曲線目前掛在分數上，會追碎塊的玩家升得特別快。
- **慢的裝置會漏掉彎曲的動作。** 低階 Android 實測一次推論 117ms
  （約 8.5 次/秒）。那個速率下直線砍接近 100%，但圓、方、三角只有
  **77–79%** —— 340–400ms 的動作只剩 3 個取樣點，形狀根本沒被取樣到。
  這是取樣率的物理限制，不是門檻調得不對。
- uint8 量化版試過了，體積減半但**偵測不到人**，已移除。
  原因與量測見 [`docs/METHOD.md`](docs/METHOD.md) §5.2。

## 技術棧

TensorFlow.js 4.22 + MoveNet SinglePose（Lightning / Thunder）、WebGL／WebGPU backend、
Canvas 2D、零建置步驟、零 npm 相依。

## 授權

MIT。見 [`LICENSE`](LICENSE)。

模型權重來自 Google 的 MoveNet，依其原始授權（Apache 2.0）散布。
