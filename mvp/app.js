(() => {
  'use strict';

  // ---- 參數 ----------------------------------------------------------------
  // 所有距離都寫成「畫面寬度的比例」而不是絕對像素。
  // 相機可能給 640x480 也可能給 1280x720，寫死像素的話門檻會隨解析度無聲偏移。
  // 比例值取自兩個已驗證的 OSS 專案：collidingScopes 用正規化座標的 0.02 當移動
  // 門檻，posenet_fruit_ninja 用 0.3 * videoWidth 當最大連線距離。
  const F = {
    fastSpeed: 1.40,   // 每秒移動幾個畫面寬 → 超過算「快揮」
    maxLink:   0.35,   // 兩幀間位移超過幾個畫面寬就不連線
    // 「有沒有揮出一刀」用整段軌跡掃過的長度來判，不用單幀速度。
    //
    // 單幀速度很吵 —— 抖動會把它頂上去，所以門檻放低會誤判成在揮、
    // 放高又會漏掉真的揮擊，怎麼調都是在兩種壞之間選。
    // 整段長度是 280ms 的累積量，抖動在裡面會互相抵消，穩定得多：
    //   手放著不動（含追蹤抖動）  掃過 < 20px
    //   真的揮一刀                掃過 150–300px
    // 0.12 是量出來的（各 4000 次模擬，視窗 280ms）：
    //   靜止（抖 6px）誤判成揮   0.09→0%    0.12→0%
    //   慢移 200px/s 誤判成揮    0.09→32%   0.12→0%     ← 0.09 在這裡失守
    //   輕揮 350px/s 被漏掉      0.12→0%    0.15→31%    ← 再高就開始漏真揮擊
    slashMin:  0.12,   // 筆畫要掃過 12% 畫面寬（640 寬時約 77px）才算一刀
    moveSpeed: 0.25,   // 仍保留給「快揮掉點率」的量測用
    // 兩把刀靠得比這還近就不可能是兩隻手。
    // 原本 0.016（640 寬時才 10px）遠遠不夠 —— 單手舉起時模型會替
    // 另一隻手猜一個位置，常常落在真手旁邊幾十個像素，生出第二把刀。
    // 實測截圖裡兩把刀相距 90px，舊門檻 10px 完全擋不到。
    lrMin:     0.11,
    fruitR:    0.053,
    // 炸彈的判定半徑另外訂，而且比水果小。
    //
    // 水果判定寬鬆是刻意的 —— 體感追蹤本來就會抖，容錯對玩家有利，
    // 「差一點也切到」不會讓人生氣。但炸彈會扣命，寬鬆就變成
    // 「明明避開了還是被炸到」，那是在處罰系統自己的誤差。
    //
    // 在真瀏覽器裡量過 emoji 字形的不透明像素（從中心射 36 個方位）：
    //   字級 61.1px（= px(fruitR) × 1.8）
    //   💣 看得見的半徑 中位 29.0px（最小 23.5、最大 36.5）
    //   🍉 中位 26.0px
    // 而判定是 px(fruitR) + px(PALM_PAD) = 33.9 + 7.7 = 41.6px
    //   → 炸彈有 12.6px 的隱形致命環，命中面積是看得見的 2.06 倍。
    //
    // 訂成 R + pad = 29.0（看得見的中位）→ R = 21.3 → 0.0333 畫面寬。
    // 「看到什麼就是什麼」，而且畫面上會把這個邊界畫出來（見 drawFruits）。
    bombR:     0.0333,
  };
  const px = (frac) => frac * cv.width;

  let MIN_SCORE   = 0.3;   // 由面板調整
  // 原本 150/120ms 是假設跑在 30fps 以上。推論掉到 8fps 時幀間隔就 >120ms，
  // linked 永遠是 false、刀痕永遠不出現。放寬到能容忍 ~4fps。
  const TRAIL_MS    = 280; // 刀痕殘留
  const MAX_LINK_MS = 260; // 兩幀間隔超過就不連（掉點後不要亂連成假刀痕）
  const GRAVITY_F   = 1.53;  // 每秒每秒幾個畫面寬（tubakhxn 的 1850@720p 換算）

  // 原版《水果忍者》砍到炸彈是直接結束，但體感操作的追蹤本來就會抖，
  // 誤砍的機率比觸控高得多，一刀斃命會讓人覺得是程式在找碴。
  // 改成跟漏接一樣扣一條命。
  const LIVES = 3;
  const BEST_KEY = 'watermelon.best';

  // 難度曲線，取自 tubakhxn/Webcam-Fruit-Ninja 試玩調出來的值
  const SPAWN_MS_0 = 1150, SPAWN_MS_MIN = 280, SPAWN_ACCEL = 17;
  const BOMB_P_0 = 0.03, BOMB_P_GAIN = 0.002, BOMB_P_CAP = 0.20;

  // 手刀的擊打面是手掌小指側那條邊，端點是手腕與小指指節。
  // 指節到小指尖還有一段，所以把向量延長一點讓刀刃長度接近真實手掌。
  const TIP_EXTEND = 1.45;

  // 掌刀位置 = 從手腕沿「手肘→手腕」這條線再往前 10cm。
  //
  // 關鍵是用「前臂長的幾倍」而不是寫死像素：成人前臂（肘到腕）約 25cm，
  // 所以 10cm = 前臂的 0.4 倍。前臂在畫面上的像素長度會隨人站遠站近縮放，
  // 用比例表示就會自動跟著校正 —— 寫死像素偏移量的話，人一退後掌刀就跑掉。
  //
  // 另外手腕和手肘這兩點 MoveNet 與 BlazePose 都有，不必依賴小指指節
  // 那個低信心的點。
  const FOREARM_CM = 25;
  const PALM_CM    = 10;   // 手腕往前多少公分算手掌
  const TIP_CM     = 18;   // 指尖附近，當對照用
  const PALM_K = PALM_CM / FOREARM_CM;   // 0.40
  const TIP_K  = TIP_CM  / FOREARM_CM;   // 0.72

  // 手掌是一個面而不是一個點，命中半徑給它一點加成
  const PALM_PAD = 0.012;

  // ── 抖動處理 ──
  // 掌刀 = 手腕 + K×(手腕−手肘)，手腕的估測誤差在這裡被放大 1.4 倍、
  // 手肘再貢獻 0.4 倍，所以掌刀點比手腕本身更抖，連成線就是折線。
  //
  // 點的抖動交給 tfjs 內建的 enableSmoothing —— 它用的是 One Euro Filter
  // （Casiez et al., CHI 2012），截止頻率隨速度自適應：
  //   α = 1/(1 + τ/Te),  τ = 1/(2π·fc),  fc = minCutOff + beta·|ẋ|
  // bundle 內的預設是 {frequency:30, minCutOff:0.05, beta:80, derivateCutOff:1}。
  // 慢的時候重度平滑（抖動看得見、延遲看不見），快的時候放寬（不削揮擊尖峰）。
  // 不要在這之上再自己疊一層 EMA —— 兩層濾波只會多加延遲，不會更穩。
  //
  // 刀痕的「形狀」是另一件事：一刀揮下去在 150–250ms 內本來就是直的，
  // 所以對軌跡點做直線擬合。那是對已經收到的點做幾何變換，零延遲。
  // 擬合殘差太大表示那其實是一道弧（故意畫圈），就不要硬拉直。
  //
  // 0.975 這個門檻是量出來的，不是猜的（各 2000 次模擬）：
  //   真實揮擊（總長 ≥ 88px、抖動 6–14px）  最小 0.9859
  //   1/4 圓弧                              最大 0.9641
  //   1/3 圓、半圓                          0.92 以下
  //   1/8 圓以內                            0.985（跟直線分不開，但它本來
  //                                          就幾乎是直的，壓平看不出來）
  // 太短的筆畫直線度本身不穩（35px 時最低掉到 0.916），所以另外加長度下限；
  // 沒過的就照原樣畫折線 —— 那種情況下折線也很短，看起來沒問題。
  const MIN_LINEARITY = 0.975;
  const MIN_STROKE = 0.045;   // 佔畫面寬的比例，約 29px @640

  // MoveNet 只有 COCO 17 點，最末端就是手腕、沒有任何手指或指節。
  // 要刀刃就只能從前臂方向外推：手長約前臂的 0.7，掌緣中段取 0.55。
  const EXTRAP_K = 0.55;

  const MODELS = {
    'blazepose-lite':    { kind: 'blazepose', modelType: 'lite' },
    'blazepose-full':    { kind: 'blazepose', modelType: 'full' },
    'movenet-lightning': { kind: 'movenet',   modelType: 'SINGLEPOSE_LIGHTNING',
                           local: 'models/movenet-lightning/model.json' },
    'movenet-lightning-uint8': { kind: 'movenet', modelType: 'SINGLEPOSE_LIGHTNING',
                           local: 'models/movenet-lightning-uint8/model.json' },
    'movenet-thunder':   { kind: 'movenet',   modelType: 'SINGLEPOSE_THUNDER',
                           local: 'models/movenet-thunder/model.json' },
  };

  // 模型預設是從 tfhub.dev 抓，而那會重導到 Kaggle 拿簽章網址 ——
  // 實測 model.json 加兩個權重分片要 7.4 秒，使用者就是在那裡乾等。
  // 同樣三個檔從 localhost 讀只要 4 毫秒。
  // 本機沒有就回去用 CDN，所以 ./menu.sh models 沒跑過也不會壞。
  const localModel = new Map();
  async function localModelUrl(key) {
    if (localModel.has(key)) return localModel.get(key);
    const u = MODELS[key] && MODELS[key].local;
    let found = null;
    if (u) {
      try {
        const r = await fetch(u, { method: 'HEAD' });
        if (r.ok) found = u;
      } catch (e) { /* 沒有就算了，回去用 CDN */ }
    }
    localModel.set(key, found);
    return found;
  }

  // ---- DOM -----------------------------------------------------------------
  const cv  = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const video = document.createElement('video');
  video.playsInline = true; video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  const el = (id) => document.getElementById(id);
  const ui = {
    fps:el('m-fps'), ifps:el('m-ifps'), camDrop:el('m-camdrop'), warm:el('m-warm'),
    p50:el('m-p50'), p95:el('m-p95'), det:el('m-det'), drop:el('m-drop'),
    blade:el('m-blade'), forearm:el('m-forearm'), noise:el('m-noise'),
    ms:el('m-ms'), cusum:el('m-cusum'),
    speed:el('m-speed'),
    gap:el('m-gap'), hit:el('m-hit'),
    miss:el('m-miss'), bomb:el('m-bomb'), tre:el('m-tre'),
    combo:el('m-combo'), crit:el('m-crit'), lr:el('m-lr'),
    jump:el('m-jump'), bone:el('m-bone'), side:el('m-side'), arm:el('m-arm'),
    chain:el('m-chain'), chain2:el('m-chain2'), state:el('m-state'),
    track:el('m-track'),
    link:el('m-link'), rejMove:el('m-rej-move'), rejTime:el('m-rej-time'),
    rejRange:el('m-rej-range'), gapAvg:el('m-gapavg'), lin:el('m-lin'),
    stroke:el('m-stroke'), gen:el('m-gen'),
    backend:el('m-backend'), src:el('m-src'), tensors:el('m-tensors'),
    status:el('status'), hint:el('hint'),
    start:el('btn-start'), reset:el('btn-reset'), demo:el('btn-demo'),
    cmp:el('btn-cmp'), probe:el('btn-probe'), result:el('result'),
    again:el('btn-again'),
    backendSel:el('sel-backend'), model:el('sel-model'), bladeSel:el('sel-blade'),
    smooth:el('chk-smooth'), skel:el('chk-skel'), scoreSel:el('sel-score'),
    gate:el('chk-gate'), straight:el('chk-straight'), sound:el('chk-sound'),
    stable:el('chk-stable'), small:el('chk-small'), raw:el('chk-raw'),
  };

  // ---- 狀態 ----------------------------------------------------------------
  let detector = null, running = false, lastVideoTime = -1, lastPose = null;
  let backendReady = false, panelBroken = false, modelSource = '—';
  let warmupMs = 0;
  let paused = false, lastFrameAt = 0, lastFrameTime = -1;
  let readyAt = 0;
  // requestVideoFrameCallback 會在「真的有新影格」時觸發，
  // 比輪詢 video.currentTime 精確，而且 presentedFrames 可以算出漏了幾格。
  const hasRVFC = typeof HTMLVideoElement !== 'undefined'
    && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
  let newFrame = false, lastPresented = 0, droppedFrames = 0, rvfcAt = 0;
  let small = null;   // 送推論用的縮圖畫布
  // 每次 startLoops 換一個 token。舊迴圈拿著舊 token 就會自己退場 ——
  // 光檢查 running 不夠：舊的 inferLoop 可能正卡在 await 中間，
  // resolve 時 running 已經被重設為 true，它就會繼續跑成第二條迴圈。
  let loopToken = 0;
  let fruits = [], nextSpawn = 0, score = 0, lastT = 0;
  let lives = LIVES, over = false, best = 0;
  let freezeUntil = 0, doubleUntil = 0;
  let comboN = 0, comboAt = 0;
  let hurtAt = 0, hurtWhy = '', overWhy = '';
  // 判斷「有沒有人」用的是「有沒有可用的刀刃」，不是「有沒有回傳姿勢」——
  // 模型可能回傳一個信心很低、關節全錯的姿勢，那對玩家來說等於沒人。
  const NO_PERSON_MS = 1200;
  let lastBladeAt = 0, lostPerson = false;
  // 示範按鈕是沒有相機時的開發工具，不該被「沒看到人」擋住
  let demoMode = false;
  // 滾動樣本。n 越多，量測值的權重越高；一個樣本都沒有就是純預設值。
  let calib = null;
  // idle：還沒開相機 / ready：看得到自己、等懸停開始 / playing：遊戲中 / over：結束
  let phase = 'idle';
  const SIDES = ['left', 'right'];
  const trails = { left: [], right: [] };   // 刀尖軌跡
  const bases  = { left: [], right: [] };   // 刀柄（手腕）軌跡
  const prev   = { left: null, right: null };
  const joint  = {};            // 關節名 → { x, y, t, heldSince }
  // 每一側上一次被信任的鏈，用來判斷延續性
  const chainHist = { left: null, right: null };
  // 每一側累積的對數勝算比，以及「已確認」這個鎖存狀態。
  //
  // SPRT 的決策是鎖存的：兩個界限之間維持上一次的判定，不重新測。
  // 原本每幀重新比 Λ ≥ A，等於把它當成水位計 —— 已確認的手臂
  // 壞一幀（Λ 掉到 −1.63）就失去身分，而快揮時的動態模糊正好
  // 會造成那一幀，刀會在揮到一半時消失。
  const track = { left: 0, right: 0 };
  const confirmed = { left: false, right: false };

  // 這一幀的關節，只有兩份，而且只在 ingestPose 組一次。
  //
  //   rawKp —— 模型原封不動的輸出。要回答「模型看到什麼」用這個。
  //   pipeKp —— 穩定化、左右修正、重疊剔除之後，bladeFor 真正看到的那份。
  //             要回答「遊戲用了什麼」用這個。
  //
  // 顯示用的程式碼一律讀這兩個，**不要自己從 lastPose 再組一次**。
  // 原本有七個地方各組一份，後果是骨架與面板畫的是管線前的資料 ——
  // 手臂已經被剔除了，畫面上還顯示三個漂亮的綠色分數。
  let rawKp = {}, pipeKp = {};

  // 這一幀為什麼沒有刀，是哪一關擋的。
  // 畫面上三個關節分數全綠、卻看不到手掌時，使用者只能猜是自己站錯還是程式壞了 ——
  // 而真正的原因（鏈沒確認、被另一手蓋掉）根本不在那三個數字裡。
  const noBlade = { left: '', right: '' };

  // 這一幀三項證據各自成不成立。軌跡確認不了的時候，
  // 光看 Λ 這個數字不知道是哪一項在扣分。
  const evLast = { left: null, right: null };
  const boneMed = {};           // 骨頭名 → 長度中位數用的樣本
  let stats = freshStats();

  const gateMoving = () => ui.gate.checked;

  function freshStats() {
    return { frames:0, detFrames:0, fastSamples:0, fastDropouts:0, lrRejects:0,
             maxSpeed:0, maxGap:0, bladeLen:0, forearm:0, hits:0, misses:0, bombs:0,
             offFrame:0,
             linkTries:0, linkOk:0, rejTime:0, rejRange:0, linSum:0, linN:0,
             notSlashing:0, slashTests:0, strokeMax:0, maxGen:0, treasures:0,
             sideFix:0, jumpGate:0, boneGate:0, armHidden:0, chainBroken:0,
             comboMax:0, crits:0,
             gapSum:0, gapN:0, infer:[], fpsTimes:[], inferTimes:[] };
  }
  // localStorage 在無痕視窗、擋第三方資料的設定下會直接丟錯，
  // 不是回傳 null。讀寫都要包起來，沒有最高分也要能正常玩。
  function loadBest() {
    try { return parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* 存不了就算了 */ }
  }

  function setStatus(msg, isErr) {
    ui.status.textContent = msg || '';
    ui.status.classList.toggle('err', !!isErr);
  }

  // ---- 相機 ----------------------------------------------------------------
  async function startCamera() {
    // getUserMedia 只在 secure context 下存在。用 file:// 開的話
    // navigator.mediaDevices 整個是 undefined —— 不是權限被拒，是 API 不見了。
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('這個頁面要從 http://localhost 開才能用相機，直接用檔案路徑打開不行。');
    }
    // 重開相機前先把舊的收掉：不停的話舊 track 仍 live、舊的 rVFC 鏈
    // 會繼續續接（它只看 video.srcObject）、舊 track 的 ended 監聽器
    // 稍後還會把新的一局殺掉
    if (video.srcObject) {
      for (const t of video.srcObject.getTracks()) t.stop();
      video.srcObject = null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' }, audio:false });
    // 相機被拔掉、或權限中途被撤銷時會觸發 ended。
    // 但 Safari 在 USB 相機被拔掉時不發這個事件、readyState 甚至還說 live
    // （WebKit bug 187896），所以另外還有一道看門狗在 renderLoop 裡。
    for (const t of stream.getVideoTracks()) {
      t.addEventListener('ended', () => cameraLost('相機斷了'));
    }
    video.srcObject = stream;
    if (hasRVFC) {
      // 續接的條件只能看「串流還在不在」。
      //
      // 原本寫 `if (running || phase !== 'idle')` —— 但這個函式是在
      // startCamera() 裡呼叫的，那時候 running 還是 false、phase 還是 'idle'
      // （要等模型載完才進 ready）。於是第一次回呼就不再續接，整條鏈當場死掉，
      // 推論從此不再跑，畫面上的分數全是一張老影格。
      const onFrame = (_t, meta) => {
        if (lastPresented && meta.presentedFrames > lastPresented + 1) {
          droppedFrames += meta.presentedFrames - lastPresented - 1;
        }
        lastPresented = meta.presentedFrames;
        newFrame = true;
        rvfcAt = performance.now();
        if (video.srcObject) video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    await video.play();
    if (!video.videoWidth) {
      await new Promise((r) => video.addEventListener('loadedmetadata', r, { once:true }));
    }
    cv.width = video.videoWidth; cv.height = video.videoHeight;
  }

  function cameraLost(why) {
    if (!running) return;
    running = false;
    hoverBtns = [];
    clearFruits();
    phase = 'idle'; demoMode = false;
    if (video.srcObject) {
      for (const t of video.srcObject.getTracks()) t.stop();
      video.srcObject = null;
    }
    syncHint();   // 把提示框與按鈕叫回來，否則按鈕是 0×0
    ui.start.disabled = false;
    ui.start.textContent = '重新開啟相機';
    setStatus(why + '。按畫面中央的按鈕再試一次。', true);
  }

  // ---- backend / 模型 ------------------------------------------------------
  function probeBackends() {
    // 只信 tfjs 真的註冊了的那些，不要信我以為載進來的那些。
    const registered = Object.keys(tf.engine().registryFactory || {});
    for (const opt of ui.backendSel.options) {
      if (!registered.includes(opt.value) || (opt.value === 'webgpu' && !navigator.gpu)) {
        opt.disabled = true;
        opt.textContent = opt.textContent.replace(/（.*）$/, '') + '（這台不能用）';
      }
    }
    if (ui.backendSel.selectedOptions[0] && ui.backendSel.selectedOptions[0].disabled) {
      const ok = [...ui.backendSel.options].find((o) => !o.disabled);
      if (ok) ui.backendSel.value = ok.value;
    }
  }

  // MoveNet 沒有指節點，所以選它的時候「手腕→指節」這兩個選項要關掉，
  // 而不是讓人選了之後在畫面上無聲失效。
  function syncBladeOptions() {
    const kind = MODELS[ui.model.value].kind;
    for (const opt of ui.bladeSel.options) {
      const needsKnuckle = opt.value === 'pinky' || opt.value === 'index';
      opt.disabled = needsKnuckle && kind !== 'blazepose';   // palm/tip/wrist 兩種模型都有手腕與手肘
    }
    if (ui.bladeSel.selectedOptions[0] && ui.bladeSel.selectedOptions[0].disabled) {
      ui.bladeSel.value = 'palm';
      setStatus('這個模型沒有指節點，刀刃改用手腕往前 10cm。');
    }
  }

  // 第一次推論要編譯 shader，會卡一下。模型是背景載入的，
  // 正好在那時候先跑一次空推論，把這個停頓挪到玩家還沒開始之前。
  async function warmup() {
    try {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const t0 = performance.now();
      await detector.estimatePoses(c, { flipHorizontal: false });
      warmupMs = Math.round(performance.now() - t0);
    } catch (e) { /* 暖機失敗不影響正常運作 */ }
  }

  async function buildDetector() {
    const want = ui.backendSel.value;
    if (tf.getBackend() !== want) {
      const ok = await tf.setBackend(want);
      if (ok === false) throw new Error('這台切不到 ' + want + '，請在上面選別的運算方式。');
    }
    await tf.ready();
    backendReady = true;
    ui.backend.textContent = tf.getBackend();

    if (detector) {
      if (typeof detector.dispose === 'function') detector.dispose();
      detector = null;
    }
    const key = ui.model.value;
    const m = MODELS[key];
    if (m.kind === 'movenet') {
      const url = await localModelUrl(key);
      const cfg = {
        modelType: poseDetection.movenet.modelType[m.modelType],
        enableSmoothing: ui.smooth.checked,
        minPoseScore: 0.2,
      };
      if (url) cfg.modelUrl = url;
      modelSource = url ? '本機' : 'CDN';
      detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, cfg);
      await warmup();
    } else {
      modelSource = 'CDN';
      detector = await poseDetection.createDetector(poseDetection.SupportedModels.BlazePose, {
        runtime: 'tfjs',
        modelType: m.modelType,
        enableSmoothing: ui.smooth.checked,
      });
      await warmup();
    }
  }

  // ---- 刀刃幾何 ------------------------------------------------------------
  // 回傳 {bx,by, tx,ty}：刀柄（手腕）與刀尖。座標已經做過鏡像。
  // 一整條手臂要三個點都夠可信才算「真的看到這隻手」。
  // 只看手腕的話，垂下或出框的那隻手仍會被模型猜出一個位置、
  // 偶爾越過門檻，就在畫面上生出一把到處游移的幽靈刀。
  // 手腕是必要的 —— 沒有它就沒有刀。
  // 手肘和肩膀只要有「一個」能用就好：手肘最準（掌刀本來就是從前臂算的），
  // 肩膀次之，兩個都沒有就退化成只用手腕。
  //
  // 原本三個都強制要，結果坐在桌前、手肘出框時整隻手直接消失 ——
  // 但那時候手明明看得見，掌刀少掉 10cm 的偏移頂多準度差一點，
  // 比完全沒有刀好太多。
  // 兩條手臂必須用到不同的點。
  //
  // chainOK 是各驗各的，所以兩條鏈可以各自「合法」卻用了幾乎同一組點 ——
  // 單手舉起時模型會替另一隻手猜位置，猜的點常常疊在真手上，
  // B 就用 A 的點拼出一條看似合法的鏈，一隻手長出兩把刀。
  //
  // 最強的訊號是肩膀：兩隻真手的手腕可以靠很近（雙手合十），
  // 但兩個肩膀永遠不會重疊。肩膀疊在一起就表示模型根本沒在分左右。
  //
  // 只拿「兩邊都過得了信心門檻」的點來比。
  // 低於門檻的點根本做不出刀（bladeFor 會先擋掉），所以它偷不走任何東西；
  // 讓一個 0.16 的猜測座標去否決一隻 0.60 的真手臂，是純粹的誤判。
  // 而單手舉起時，模型本來就一定會替沒舉的那隻手吐出一組 0.1x 的猜測 ——
  // 那正是這裡最常遇到的輸入，不是例外。
  function armsDistinct(kp) {
    const scale = bodyScale(kp);
    const sep = (part) => {
      const need = scoreNeed(part);
      const a = kp['left_' + part], b = kp['right_' + part];
      if (!a || !b || below(a.score, need) || below(b.score, need)) return Infinity;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    if (sep('shoulder') < scale * 0.5) return false;
    // 手腕和手肘只擋「幾乎疊在同一點」。
    // 雙手往中間揮、雙手合十，兩隻手腕本來就會靠得很近 ——
    // 那是切水果最基本的動作，用肩膀那個門檻去擋等於每次都砍掉一把刀。
    if (sep('wrist') < scale * 0.15) return false;
    if (sep('elbow') < scale * 0.15) return false;
    return true;
  }

  // 兩條鏈重疊時，手腕信心要差這麼多倍才算「一眼就看得出誰是真的」。
  // 1.25 來自實際分布：舉起的手大約 0.4–0.8，沒舉的那隻猜測值大約 0.1–0.25，
  // 中間隔了兩倍以上；相差不到 1.25 倍就表示兩邊都說不準，再去比軌跡信用。
  const LR_SCORE_MARGIN = 1.25;

  // 兩條鏈重疊時要刪掉哪一邊。
  //
  // 先比手腕信心，信心相近才比軌跡信用 —— 順序不能反過來。
  // 重疊的時候幽靈那條是「用真手的點拼出來的」：它的骨鏈成立、
  // 也接得上上一幀（跟的是同一個真實動作），所以軌跡信用賺得跟真手一樣快，
  // 那個數字在這裡根本不是獨立證據。
  //
  // 反過來比會卡死：幽靈先確認、真手剛舉起還在爬，真手每幀都被判成弱的、
  // 被刪掉、信用再被扣 —— 永遠翻不了身。症狀是「手掌不見了而且一直不回來」。
  //
  // 手腕信心是唯一不受重疊汙染的量：模型對沒舉起的那隻手只能猜，
  // 猜出來的分數就是低。
  function weakerArm(kp, trk2) {
    const sl = (kp.left_wrist  && kp.left_wrist.score)  || 0;
    const sr = (kp.right_wrist && kp.right_wrist.score) || 0;
    const hi = Math.max(sl, sr), lo = Math.min(sl, sr);
    if (hi > lo * LR_SCORE_MARGIN) return sl >= sr ? 'right' : 'left';
    if (Math.abs(trk2.left - trk2.right) > 0.01) {
      return trk2.left > trk2.right ? 'right' : 'left';
    }
    return sl >= sr ? 'right' : 'left';
  }

  // 這一側的三個關節，跟它自己上一次被信任的位置有多接近。
  // 回傳 0..1，1 代表完全沒動，0 代表接不上（或根本沒有歷史）。
  function continuity(side, kp, now) {
    const h = chainHist[side];
    if (!h || now - h.t > CHAIN_MEM_MS) return 0;
    const scale = bodyScale(kp);
    // 允許的位移隨經過時間放大，掉幀時才不會誤判成接不上
    const budget = scale * CHAIN_MOVE * Math.max(1, (now - h.t) / 33);
    let worst = 0;
    for (const part of ARM) {
      const k = kp[side + '_' + part], p = h[part];
      if (!k || !p) return 0;
      worst = Math.max(worst, Math.hypot(k.x - p.x, k.y - p.y));
    }
    return Math.max(0, 1 - worst / budget);
  }

  function rememberChain(side, kp, now) {
    const rec = { t: now };
    for (const part of ARM) {
      const k = kp[side + '_' + part];
      if (!k) { chainHist[side] = null; return; }
      rec[part] = { x: k.x, y: k.y };
    }
    chainHist[side] = rec;
  }

  // 這一幀這一側的三項證據，累積成對數勝算比
  function updateTracks(kp, now) {
    for (const side of SIDES) {
      const sh = kp[side + '_shoulder'], eb = kp[side + '_elbow'],
            wr = kp[side + '_wrist'];
      if (!sh || !eb || !wr) {
        // 連三個點都湊不齊，直接往丟棄端推
        track[side] = Math.max(SPRT_B, track[side] - 2);
        latch(side);
        if (!confirmed[side]) chainHist[side] = null;
        continue;
      }
      const okChain  = chainOK(sh, eb, wr, shoulderWidth(kp), side);
      const contVal  = continuity(side, kp, now);
      const okCont   = contVal > 0.25;
      const okStrong = atLeast(wr.score, MIN_SCORE * 1.5);
      evLast[side] = { chain: okChain, cont: okCont, contVal, strong: okStrong };
      // 三項證據不是條件獨立的。
      //
      // 幽靈鏈是「用真手的點拼出來的」—— 它既接得上上一幀（續✓）、
      // 手腕信心也高（強✓）。所以鏈不成立的時候，「續」根本分不出
      // 真手與幽靈，不該給它 +1.814。
      //
      // 不修的話有一個死區：鏈✗續✓強✓ = −2.639 +1.814 +0.827 = **+0.0014**，
      // 每幀往上爬萬分之一 —— 既到不了上界也到不了下界，
      // 15fps 下要 370 秒（6.2 分鐘）才爬得出來。
      // 身體轉超過 60°（上臂/肩寬 > 1.5）就會進去，而那是往側邊揮刀的自然動作。
      const d = llr('chain', okChain)
              + (okChain ? llr('cont', okCont) : 0)
              + llr('strong', okStrong);
      track[side] = Math.min(SPRT_A, Math.max(SPRT_B, track[side] + d));
      latch(side);
      // 歷史無條件記下來。
      //
      // 原本是「Λ 掉到下界就把歷史清掉」，那會死鎖：沒有歷史 → continuity
      // 回 0 → 證據變成 鏈✓續✗強✓ = +1.153 −2.365 +0.827 = −0.385，每幀都是負的
      // → Λ 釘死在下界 → 歷史又被清掉。就算幾何完全正確也永遠爬不出來。
      // 實測使用者端 32 筆取樣全部 續=false(0.00)、Λ=-2.99 一動也不動。
      //
      // 「續」這項證據依賴歷史，不能在它最需要歷史的時候把歷史刪掉。
      // 歷史只是「這條鏈上一幀在哪」，不是獎勵 —— 幽靈鏈穩定的話本來就
      // 該拿到這一分，那是 EV.cont 的 0.92/0.15 已經算進去的假設。
      rememberChain(side, kp, now);
    }
  }

  // 鎖存：越過上界才確認，越過下界才撤銷，中間維持現狀
  function latch(side) {
    if (track[side] >= SPRT_A * 0.999) confirmed[side] = true;
    else if (track[side] <= SPRT_B * 0.999) confirmed[side] = false;
  }

  const hasTrack = (side) => confirmed[side];

  // ── 單一來源：尺度與門檻 ────────────────────────────────────────────
  //
  // 這兩支是「這個人現在有多大」與「這個點可不可信」的唯一答案。
  // 以前這兩條運算式各被複製了 5 次和 6 次，複製出去的一定會各自漂走 ——
  // 而且改的時候只會改到其中幾處，測試還是綠的。

  // 身體尺度：優先用校正前臂，沒有就用當幀肩寬換算，最後才退回畫面比例。
  // 肩寬是這一幀直接量到的，不經過任何估計器，校正值壞掉時它還是對的。
  function bodyScale(kp) {
    if (calib && calib.forearm > 4) return calib.forearm;
    const sw = kp ? shoulderWidth(kp) : 0;
    if (sw > 4) return sw * FORE_OVER_SHOULDER;
    return px(0.09);
  }

  // ── 單一來源：門檻比較 ────────────────────────────────────────────
  //
  // 浮點數的門檻一律走這兩支，不要直接寫 >= 或 <。
  //
  // 門檻幾乎都是算出來的（0.20 × 1.15 × 1.5 …），而
  // 0.20 * 1.5 === 0.30000000000000004 —— 「剛好到門檻」的那個值會隨著
  // 算式的寫法落在兩邊，同一個分數在兩個地方得到不同結論。
  // 遊戲裡這不會爆炸，但會變成「偶爾有一幀沒有刀」這種查不出來的毛病，
  // 而且測試會卡在無法解釋的邊界上。
  //
  // 容差取 1e-9：信心分數與像素都遠大於這個量級，不會蓋掉真實差異。
  const EPS = 1e-9;
  const atLeast = (v, min) => v >= min - EPS;   // 達到門檻（含剛好）
  const below   = (v, min) => v <  min - EPS;   // 未達門檻

  // 這個關節要多少信心才算數。手肘要比手腕嚴，因為掌刀 = 手腕 + K×(手腕−手肘)，
  // 手肘的誤差會被放大帶進來。
  function scoreNeed(part) {
    return part === 'elbow' ? MIN_SCORE * ELBOW_SCORE_MUL : MIN_SCORE;
  }

  // 兩肩都看得到才有肩寬可用；只看得到一邊就回 0，那道檢查自動略過。
  //
  // 刻意不提供「退回校正值」的版本：肩寬的用途就是當一把
  // **不經過任何估計器**的尺規，退回 calib.forearm 等於讓估計器自己
  // 當自己的裁判，學壞了就再也出不來（實機出現過 40px 與 17px 兩次）。
  // 代價是量不到肩寬時 chainOK 的兩道上界會略過 —— 那是刻意的取捨，
  // 寧可少一道檢查，也不要一道會自我汙染的檢查。
  function shoulderWidth(kp) {
    const l = kp.left_shoulder, r = kp.right_shoulder;
    if (!l || !r || below(l.score, MIN_SCORE) || below(r.score, MIN_SCORE)) return 0;
    return Math.hypot(l.x - r.x, l.y - r.y);
  }

  // 這三點是不是同一隻手臂？
  // 人的上臂與前臂長度相近，比例差太多就表示配錯了。
  // 有校正值的話再多一道：前臂長度不該偏離量到的身形太多。
  // 只檢查上界，不檢查下界。
  //
  // 透視投影只會讓線段「變短」，不會變長 —— 所以「太長」一定是配錯手臂，
  // 但「太短」可能只是手伸直指向鏡頭。原本有三個下界檢查
  // （upper<4、ratio 下限、fore/前臂 下限），手一伸直全部誤擋，
  // 而那正是切水果最常用的動作。
  //
  // 擋掉錯配的工作改由上界 + armsDistinct（兩條鏈不能共用點）負責。
  // 實測先前漏掉的「手肘是另一隻手的」案例（上臂 230px / 肩寬 120px = 1.9）
  // 單靠上界就擋得下來。
  // 上一次判斷用到的實際比值。鏈不成立時畫在螢幕上 ——
  // 只看 true/false 沒辦法知道是差一點還是差很多，也沒辦法知道是哪一道擋的。
  const chainWhy = { left: null, right: null };

  function chainOK(sh, eb, wr, shoulderW, side) {
    const upper = Math.hypot(sh.x - eb.x, sh.y - eb.y);
    const fore  = Math.hypot(eb.x - wr.x, eb.y - wr.y);
    if (side) {
      chainWhy[side] = {
        upper, fore, shoulderW,
        rU: shoulderW > 4 ? upper / shoulderW : null,
        rF: (calib && calib.forearm > 4) ? fore / calib.forearm : null,
      };
    }
    // 只用「單一線段的絕對長度上界」。
    //
    // 不能用「前臂/上臂的比值」—— 投影會獨立影響兩段：手肘收在身側、
    // 前臂橫向伸出時，上臂縮成 10px 而前臂 70px，比值 7.0，
    // 但那是完全正常的姿勢。上界只對單一線段成立，對比值不成立。
    if (shoulderW > 4 && upper / shoulderW > UPPER_VS_SHOULDER_HI) return false;
    // 前臂的上界也用肩寬，不用校正值。
    //
    // 原本是 fore / calib.forearm > 2.2。問題是 calib.forearm 是「學來的」，
    // 學壞了就會變成一道關掉整條管線的閘門 —— 實測它被幽靈手臂的樣本
    // 汙染到 40px，於是「超過 88px 就擋」，真手臂一律不合格，
    // 鏈永遠不成立、SPRT 一路掉到下界、永遠沒有刀，而且不會自己好。
    //
    // 肩寬是這一幀直接量到的，不經過任何估計器，壞不了。
    // 成人前臂約 25cm、肩寬約 40cm，比值約 0.63；投影只會讓它變短，
    // 所以 1.6 已經留了兩倍半的餘裕。
    if (shoulderW > 4 && fore / shoulderW > FORE_VS_SHOULDER_HI) return false;
    return true;
  }

  // 手腕過不了就直接不用算了。
  // 完整的條件是「肩肘腕三點成一條合理的鏈」，那由 bladeFor 的 chainOK 把關；
  // 這裡只是提早退出，省掉後面的計算。
  function armVisible(side, kp) {
    const w = kp[side + '_wrist'];
    if (!w || below(w.score, MIN_SCORE)) {
      stats.armHidden++;
      noBlade[side] = '手腕看不清楚 —— 手舉高一點';
      return false;
    }
    return true;
  }

  // 掌刀的幾何。抽成純函式是為了能在 node 裡測 ——
  // 這是整個遊戲最核心的一條式子，不能只靠「看起來對」。
  //
  //   掌刀 = 手腕 + K × 前臂投影長 × (手腕 − 基準點 的單位向量)
  //   K = 10cm ÷ 25cm 前臂 = 0.4
  //
  // 兩個刻意的設計：
  // 1) 位移量用「投影後的前臂長」而不是校正值 —— 手朝鏡頭時真實的 10cm
  //    在畫面上本來就該縮短，縮到 0 是對的。
  // 2) 方向在前臂投影夠長時用手肘（最準）；手伸直指向鏡頭時前臂縮成幾個
  //    像素、方向全是雜訊，改用肩膀→手腕當基線（同一條已驗證的鏈，
  //    基線長得多）。反對用肩膀的理由是「配到另一隻手的肩膀」，
  //    鏈驗證過之後就不是那個問題了。
  function palmPoint(wrist, eb, sh, K, ref) {
    const foreLen = Math.hypot(wrist.x - eb.x, wrist.y - eb.y);
    const useElbow = foreLen >= ref * DIR_MIN_FOREARM;
    const ax = useElbow ? eb.x : sh.x, ay = useElbow ? eb.y : sh.y;
    const len = Math.hypot(wrist.x - ax, wrist.y - ay) || 1;
    const off = foreLen * K;
    return { x: wrist.x + (wrist.x - ax) / len * off,
             y: wrist.y + (wrist.y - ay) / len * off,
             foreLen, useElbow, off };
  }

  // 這一幀的掌刀在 3D 的哪裡（肩膀座標系）。
  // 掌刀 = 手腕 + K×(手腕 − 手肘)，三維版就是把同一條式子套在還原後的向量上。
  const lastLift = { left: null, right: null };
  function palm3D(side, sh, eb, wr, K) {
    const fore = bodyScale(pipeKp);
    if (!(fore > 4)) return null;
    const L = liftChain(sh, eb, wr, fore, lastLift[side]);
    lastLift[side] = L;
    const e = { x: eb.x - sh.x, y: eb.y - sh.y, z: L.z1 };
    const w = { x: L.x, y: L.y, z: L.z };          // 手腕（肩膀座標系）
    return { x: w.x + (w.x - e.x) * K,
             y: w.y + (w.y - e.y) * K,
             z: w.z + (w.z - e.z) * K };
  }

  function bladeFor(side, kp, now) {
    if (ui.stable.checked && !armVisible(side, kp)) return null;
    const mirror = (k) => ({ x: cv.width - k.x, y: k.y, score: k.score });
    const get = (n) => {
      const k = kp[side + '_' + n];
      return k && atLeast(k.score, scoreNeed(n)) ? mirror(k) : null;
    };
    const wrist = get('wrist');
    if (!wrist) { noBlade[side] = '手腕看不清楚 —— 手舉高一點'; return null; }

    const mode = ui.bladeSel.value;
    if (mode === 'palm' || mode === 'tip') {
      // 手肘→手腕定出前臂方向，從手腕再往前走 K 倍前臂長。
      // 前臂的像素長度本身就是尺度，所以這個距離會隨人站遠站近自動縮放。
      const K = mode === 'palm' ? PALM_K : TIP_K;
      const eb = get('elbow'), sh = get('shoulder');

      // 方向只能從「驗證過的同一條手臂」來。
      //
      // 不要拿肩膀當替代方向來源 —— 單手舉起時模型對左右的標記不可靠，
      // 很可能把這隻手的手腕配上另一邊的肩膀，算出一條橫跨身體的方向。
      // 錯的方向比沒有方向糟糕得多：沒方向只是少 10cm 偏移，
      // 錯方向會讓刀刃指到完全不相干的位置。
      // 幾何過不了但接得上自己上一幀的鏈 → 仍然可信。
      // 手往前伸是連續動作，中途某幾幀的幾何可能剛好落在邊界外，
      // 不該因此整條鏈作廢。
      // 軌跡沒站穩就不給刀 —— 幽靈手撐不過連續幾幀的確認
      if (eb && sh && hasTrack(side)) {
        const foreLen = Math.hypot(wrist.x - eb.x, wrist.y - eb.y);
        stats.forearm = Math.max(stats.forearm, foreLen);
        const pt = palmPoint(wrist, eb, sh, K, bodyScale(kp));
        // 這一幀的 3D 位置要在這裡算 —— 軌跡點是過去的刀刃位置，
        // 到了量揮擊長度的時候已經拿不到當時的肩肘腕了。
        return { bx:pt.x, by:pt.y, tx:pt.x, ty:pt.y, pad: px(PALM_PAD),
                 v3: palm3D(side, sh, eb, wrist, K) };
      }
      // 鏈不成立 → 沒有刀。不做「退化成手腕單點」。
      //
      // 鏈不成立時我們沒有任何證據說那個手腕是對的 ——
      // 不是「位置對、只是少了方向」，而是「這個點可能根本不是手」。
      // 模型對沒舉起來的那隻手也會猜一個手腕，猜的位置常落在真手旁邊，
      // 一隻手就長出兩把刀。位置錯的刀比沒有刀糟得多：
      // 會誤砍炸彈、斷連擊、讓整個遊戲看起來是隨機的。
      stats.chainBroken++;
      noBlade[side] = !eb ? '看不到手肘 —— 手肘也要進畫面'
                    : !sh ? '看不到肩膀 —— 退後一點讓上半身入鏡'
                    : '手停一下，馬上就好';
      return null;
    }
    if (mode === 'wrist') {
      // posenet_fruit_ninja（★45）就是只追手腕。刀刃退化成一個點，
      // 留著當對照組 —— 它是這個題目裡唯一被多人玩過的做法。
      return { bx: wrist.x, by: wrist.y, tx: wrist.x, ty: wrist.y };
    }
    if (mode === 'pinky' || mode === 'index') {
      const knuckle = get(mode);
      if (knuckle) {
        // 指節到指尖還有一段，延長向量讓刀刃接近真實掌緣長度
        return { bx: wrist.x, by: wrist.y,
                 tx: wrist.x + (knuckle.x - wrist.x) * TIP_EXTEND,
                 ty: wrist.y + (knuckle.y - wrist.y) * TIP_EXTEND };
      }
      // 指節掉了就退回外推，刀刃不要整個消失
    }
    const elbow = get('elbow');
    // 手肘也掉了就退回手腕單點。刀刃退化成一個點還能玩，
    // 整個回 null 就連刀痕都沒有了 —— 寧可退化不要消失。
    if (!elbow) return { bx: wrist.x, by: wrist.y, tx: wrist.x, ty: wrist.y };
    return { bx: wrist.x, by: wrist.y,
             tx: wrist.x + (wrist.x - elbow.x) * EXTRAP_K,
             ty: wrist.y + (wrist.y - elbow.y) * EXTRAP_K };
  }

  // 全最小平方直線擬合（垂直距離最小，不是 y 對 x 的回歸 —— 垂直刀痕
  // 在後者會爆掉）。回傳線段兩端與直線度；直線度 1 = 完全共線。
  function fitLine(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let Sxx = 0, Syy = 0, Sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      Sxx += dx*dx; Syy += dy*dy; Sxy += dx*dy;
    }
    const th = 0.5 * Math.atan2(2*Sxy, Sxx - Syy);
    const dx = Math.cos(th), dy = Math.sin(th);
    let tmin = Infinity, tmax = -Infinity;
    for (const p of pts) {
      const t = (p.x - mx)*dx + (p.y - my)*dy;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    // 兩個主成分的特徵值：差距越大越像一條線
    const tr2 = Sxx + Syy;
    const det = Math.sqrt((Sxx - Syy)*(Sxx - Syy) + 4*Sxy*Sxy);
    const l1 = (tr2 + det) / 2, l2 = (tr2 - det) / 2;
    const linearity = l1 > 1e-6 ? 1 - Math.max(0, l2) / l1 : 1;
    return { x1: mx + dx*tmin, y1: my + dy*tmin,
             x2: mx + dx*tmax, y2: my + dy*tmax, linearity, len: tmax - tmin };
  }

  // 軌跡尾端連續相連的那一段 —— 掉點造成的斷裂不要跨過去一起擬合
  // 這一點接不接得上上一點。
  //
  // 「接得上」才算同一筆；接不上就從這裡開始新的一筆（activeRun 用它切）。
  // 兩道各自獨立：隔太久（掉點太多）或跳太遠（追蹤跳動）都不接。
  function linkInfo(p, b, now) {
    const dtp = Math.max((now - p.t) / 1000, 1e-3);
    const dist = Math.hypot(b.tx - p.tx, b.ty - p.ty);
    const speed = dist / dtp;
    const inTime = (now - p.t) <= MAX_LINK_MS;
    // 「跳太遠」就是「速度超過人手可能的極限」，那個量已經有了（maxSpeedPx），
    // 不要再另外訂一個距離門檻。
    //
    // 原本是 dist <= px(F.maxLink) = 畫面寬的 35%（640 下 224px）——
    // 一個絕對的畫面比例，違反 §4.3，而且不隨影格間隔變。
    // 後果：15fps 下一刀只有 3 個點，掉一點就變成單步 242px > 224px
    // → 判定接不上 → 整段筆畫斷掉。語料實測 15fps + 22% 掉點時
    // 直線揮的偵測率只有 78–81%，8fps 幾乎全掛。
    // 改成速度上限之後兩者都回到 ~100%（見 tests/motion.test.js 的表）。
    const inRange = dist <= maxSpeedPx() * dtp;
    return { dist, speed, inTime, inRange,
             linked: inTime && inRange,
             fast: speed > px(F.fastSpeed),
             moving: speed >= px(F.moveSpeed) };
  }

  // 把一筆軌跡在「方向反轉」的地方切段。
  //
  // 揮出去和拉回來是兩段，但那是同一個動作 —— 人的手揮到底一定要收回來，
  // 收回的那一段也是這次揮擊的一部分，不該讓它重新從零賺一次門檻。
  // 所以切段不是為了拆散它們，是為了「分段量、再相加」：
  // 整段直線擬合會讓來回互相抵消（去 160px、回 160px，投影長還是 160px），
  // 分段相加才量得到真正掃過的 320px。
  //
  // 反轉的判準是相鄰兩步的內積為負（夾角超過 90°）。
  function segments(run) {
    if (run.length < 2) return [run];
    const segs = [];
    let cur = [run[0]];
    for (let i = 1; i < run.length; i++) {
      if (i >= 2) {
        const ax = run[i-1].x - run[i-2].x, ay = run[i-1].y - run[i-2].y;
        const bx = run[i].x   - run[i-1].x, by = run[i].y   - run[i-1].y;
        if (ax * bx + ay * by < 0) { segs.push(cur); cur = [run[i-1]]; }
      }
      cur.push(run[i]);
    }
    segs.push(cur);
    return segs;
  }

  // 這一連續動作在畫面上總共掃過多長。分段量再相加，見 segments()。
  function sweepLen(run) {
    let total = 0;
    for (const seg of segments(run)) {
      if (seg.length < 2) continue;
      const f = fitLine(seg);
      if (f) total += f.len;
    }
    return total;
  }

  // ── 手是掛在肩膀上的：射線–球面 ─────────────────────────────────────
  //
  // 肩膀固定，所以手腕一定在以肩為心、半徑＝臂長 L 的**球面**上。
  // 相機看到的是那顆球的投影，所以從影像點往 z 射一條線去跟球求交，
  // 就能把深度解回來（弱透視下射線平行 z，二次式退化成）：
  //
  //     z² = L² − d²         d = 投影後的 |手腕 − 肩膀|
  //
  // 判別式 L² − d² 為負 = 射線沒有交點 = 這個點不可能是掛在那個肩膀上的手。
  // 但實務上 ±6px 的抖動把 d 推過輪廓邊界是常態，所以**夾到 0 而不是丟點**
  // （等價於「手臂剛好在鏡頭平面內」，那是最接近的合法解）。
  //
  // 兩個根（±z）的歧義用時間連續性解：選離上一幀比較近的那個。
  // 這是 2D→3D pose lifting 的標準做法（骨長約束 + 時間平滑）。
  const ARM_OVER_FOREARM = 2.2;        // 上臂 30cm + 前臂 25cm ÷ 前臂 25cm
  const UPPER_OVER_FOREARM = 1.2;      // 上臂 30cm ÷ 前臂 25cm
  // 追蹤抖動的尺度，用前臂長的比例表示（前臂 151px 時約 6px，與實測相符）
  const LIFT_SIGMA = 0.04;
  // z 要大過自己的誤差幾倍才採信。語料掃出來的（每格 2200 次動作）：
  //
  //    K     支援區域 reliability   彎手臂偵測   誤報
  //    0            83.0%            70.2%      233   ← 無條件採信 z
  //    3            88.7%            73.4%      140
  //    6            97.0%            85.7%        0
  //   10            95.0%            92.5%        0   ← 總偵測率最高 93.8%
  //  200            90.4%            90.0%        0   ← 等於完全關掉 3D
  //
  // 選 10：總偵測率最高，而且比「完全關掉 3D」高 3.6 個百分點 ——
  // 那 3.6 點就是 Taylor 還原實際賺到的東西。
  const LIFT_TRUST_K = 10;
  // Taylor 的逐段還原（Reconstruction of Articulated Objects from Point
  // Correspondences in a Single Uncalibrated Image, C.J. Taylor, CVIU 2000）。
  //
  // 弱透視 + 已知骨長，每一段骨頭各自解一次：
  //
  //     ΔZ = ±√( L² − (Δu² + Δv²) )        L 是換算成像素的真實骨長
  //
  // 關鍵是「逐段」。先前的版本把整條手臂當一顆球（肩為心、半徑＝臂長），
  // 那只在手臂伸直時成立 —— 手肘一彎，手腕的半徑就變短，而球面模型會把
  // 那個變短硬解成「手往深處去了」，憑空捏造出 0.9 倍臂長的深度。
  // 逐段就沒有這個問題：手肘彎多少由 肘→腕 那一段自己承擔。
  //
  // 論文另外兩個結論也直接用上：
  //  1) 解是一整族，由尺度 s 參數化，而 s 的下界是 max(投影長 / 真實長) ——
  //     也就是「投影只會變短」的正式版。我們有校正值，s 直接拿來用。
  //  2) 每段有獨立的 ± 歧義（n 段 2^(n−1) 種）。這裡用時間連續性挑：
  //     取跟上一幀同號的那個根。
  //
  // 回傳肩膀座標系下的 3D 手腕向量（肩膀在原點）。
  function liftChain(sh, eb, wr, foreLenPx, prev) {
    const L1 = foreLenPx * UPPER_OVER_FOREARM;   // 上臂，換算成像素
    const L2 = foreLenPx;                        // 前臂
    const e = { x: eb.x - sh.x, y: eb.y - sh.y };
    const w = { x: wr.x - eb.x, y: wr.y - eb.y };
    // 判別式為負＝投影比真實骨長還長，只可能是量測誤差（投影不會變長）。
    // 夾到 0 而不是丟掉 —— 量測誤差把投影推過骨長是常態。
    // 只在 z 大於它自己的誤差時才採信。
    //
    // dz/dd = −d/z，所以 σ_z = (d/z)·σ_d —— z→0（投影長接近骨長、手臂落在
    // 鏡頭平面內）時誤差發散。實測不處理的話，靜止的手光靠 ±6px 抖動就能
    // 生出 233 次假揮擊，而同樣條件下純 2D 是 0 次。
    // 採信條件 z > √(d·σ_d·K)：要求訊號大過雜訊 K 倍。不採信就設 0，
    // 等價於「手臂就在鏡頭平面內」—— 那正是這種情況下最接近的合法解，
    // 而且會自動退回 2D 的量法。
    const sig = Math.max(1, foreLenPx * LIFT_SIGMA);
    const trust = (z, d) => (z * z > d * sig * LIFT_TRUST_K ? z : 0);
    const d1 = Math.hypot(e.x, e.y), d2 = Math.hypot(w.x, w.y);
    const z1 = trust(Math.sqrt(Math.max(0, L1 * L1 - d1 * d1)), d1);
    const z2 = trust(Math.sqrt(Math.max(0, L2 * L2 - d2 * d2)), d2);
    const s1 = (prev && prev.z1 < 0) ? -1 : 1;
    const s2 = (prev && prev.z2 < 0) ? -1 : 1;
    return { x: e.x + w.x, y: e.y + w.y, z: s1 * z1 + s2 * z2,
             z1: s1 * z1, z2: s2 * z2 };
  }

  // 真正的 3D 掃過量，換算成「等效弧長 px」，跟畫面上的量同單位。
  // 真正的 3D 掃過量，換算成「等效弧長 px」，跟畫面上的量同單位。
  // 每個軌跡點上的 v3 是它產生當下用 Taylor 逐段還原出來的（見 palm3D）。
  function sweep3D(run, armLen) {
    let total = 0;
    for (const seg of segments(run)) {
      if (seg.length < 2) continue;
      // 取這一段「頭到尾」的角度，不要逐步累加。
      //
      // 逐步累加等於路徑長，抖動會一路加上去 —— 而 3D 這邊抖動特別大：
      // dz/dd = −d/z，z→0 時誤差發散。實測逐步累加讓靜止的手產生 268 次誤報，
      // 而 2D 路徑同樣條件是 0 次，差別就在 2D 是「分段擬合取端點距離」，
      // 中間的抖動互相抵消。這裡套同一招：只看端點。
      // 段落已經在方向反轉處切開了，所以每段大致單向，端點距離就是掃過量。
      let a = null, b = null;
      for (const q of seg) {
        if (!q.v3) continue;
        if (!a) a = q.v3;
        b = q.v3;
      }
      if (a && b) {
        const na = Math.hypot(a.x, a.y, a.z), nb = Math.hypot(b.x, b.y, b.z);
        if (na > 1 && nb > 1) {
          const c = Math.min(1, Math.max(-1,
            (a.x*b.x + a.y*b.y + a.z*b.z) / (na * nb)));
          total += Math.acos(c) * armLen;
        }
      }
    }
    return total;
  }

  // 這一刀掃過多少 —— 看條件數決定信 2D 還是 3D。
  //
  // 語料實測（12 種動作 × 動作平面偏離鏡頭 0/30/60/75° × 22% 掉點，每格 300 次）：
  //
  //   判準            最差偵測率   誤判率
  //   只用 2D              0%        0%   ← 手臂在鏡頭平面內橫揮時整個看不到
  //   只用 3D             47%        9%   ← 輪廓邊界上 z 病態，抖動變成假揮擊
  //   依條件數切換       100%        0%
  //
  // 取 max 而不是二選一：投影只會變短，所以 2D 是真值的下界，
  // 兩個都算、取大的，不會比單用 2D 差。
  // 這一刀掃過多少。
  //
  // 2D（畫面上的掃過長）是真值的**下界** —— 投影只會變短。
  // 3D（Taylor 逐段還原後的真實角度）把前縮補回來，但在輪廓邊界上
  // （投影長接近真實骨長、判別式趨近 0）導數發散、對抖動極敏感。
  // 所以兩個都算、取大的：3D 失準時它給出的值不會比 2D 大多少，
  // 2D 失準時（手臂朝鏡頭橫揮）3D 把它救回來。
  function sweepOf(run) {
    const flat = sweepLen(run);
    const armLen = bodyScale(pipeKp) * ARM_OVER_FOREARM;
    if (!(armLen > 4)) return flat;
    return Math.max(flat, sweep3D(run, armLen));
  }

  function activeRun(tr) {
    if (tr.length < 2) return tr.slice();
    let i = tr.length - 1;
    while (i > 0 && tr[i].linked) i--;
    return tr.slice(i);
  }

  // 每幀算一次，命中判定與繪製共用。
  // 之前 testSlices 和 draw 各呼叫一次，fitLine 每幀跑 4 次，而且統計值會
  // 從繪製路徑被更新 —— 等於「關掉繪製」就會改變量測結果。
  const strokeCache = { left: null, right: null };
  const strokeFor = (side) => strokeCache[side];

  // 這隻手當下的刀痕：拉直成一條線段，或在它其實是弧線時維持原樣
  function computeStroke(side) {
    const run = activeRun(trails[side]);
    if (run.length < 2) return null;
    const fit = fitLine(run);
    if (!fit) return null;
    const straight = ui.straight.checked
                  && fit.linearity >= MIN_LINEARITY
                  && fit.len >= px(MIN_STROKE);
    // 沒揮出一刀就不是刀。靜止的手不該因為水果飛過來就切到它。
    //
    // 量的是「這個連續動作掃過多長」（分段相加），不是整段的直線擬合長。
    // 整段擬合會讓來回互相抵消，也量不到轉折 —— 動作語料實測
    // （tests/motion.test.js，每格 400 次）：
    //
    //   判準                  最差偵測率   誤判率
    //   整段 fit.len（舊）        0%        0%   ← 三角形 15fps 全漏
    //   各段取最大                0%        0%   ← 之字 30fps 掉到 63%
    //   各段相加（現在）         88%        0%
    //
    // 三種判準的誤判率都是 0%，所以選涵蓋面最好的那個。
    const sweep = sweepOf(run);
    const slashing = !gateMoving() || sweep >= slashMinPx();
    stats.strokeMax = Math.max(stats.strokeMax, sweep);
    stats.linSum += fit.linearity; stats.linN++;
    return { run, fit, straight, slashing };
  }

  // ---- 自適應量（Tracked）--------------------------------------------------
  //
  // 會變的、不會變的、緩慢變的，用同一套機制：
  //   滾動估計器（中位數之類的）＋ 帶遲滯的變化偵測。
  // 差別只有「波動性」這一個參數：
  //
  //   static  身形這種不會變的 —— 收斂後鎖定。鎖定很重要，因為估計器的
  //           輸入在遊戲進行中會被遊戲本身汙染（手一直在動，雜訊地板會
  //           緩慢上爬），不鎖就會形成自己惡化的回饋迴路。
  //   slow    光線這種會變但變得慢的 —— 持續跟，但要差夠多且持續夠久
  //           才換值，否則門檻每幀亂飄，手感變得不可預測。
  //   live    每幀都該更新的 —— 不做遲滯。
  //
  // 變化偵測用的是真正的兩側 CUSUM（Page, 1954）：
  //
  //   C⁺ᵢ = max(0, C⁺ᵢ₋₁ + (xᵢ − T) − K)
  //   C⁻ᵢ = max(0, C⁻ᵢ₋₁ − (xᵢ − T) − K)
  //   C 超過 H 就判定「真的變了」
  //
  // 為什麼不用「連續 N 次超出門檻」那種 run-length 規則：那個累積的是
  // 次數，只要有一次落回帶內就整個歸零，所以帶雜訊的真實偏移可能永遠
  // 累積不起來。CUSUM 累積的是偏離的「量」—— K 這個容忍量會把純雜訊
  // 拉回 0（對雜訊記性短），但系統性偏差會一路累加（對持續偏移記性長），
  // 而且偏移越大觸發越快，不像 run-length 不管多大都要等滿 N 次。
  //
  // 參數換算（慣例是 K = δ/2，δ 是想偵測的偏移量）：
  //   以相對偏離 z = est/value − 1 為單位
  //   K = band / 2
  //   H = dwell × band / 2  →  剛好 band 大小的持續偏移會在 dwell 次後觸發，
  //                            更大的偏移按比例更快
  // 所以 band / dwell 這兩個旋鈕的意思不變，只是底下換成正確的演算法。

  const median = (v) => {
    if (!v.length) return 0;
    const a = [...v].sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  const pctile = (v, q) => {
    if (!v.length) return 0;
    const a = [...v].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  };

  function Tracked(opts) {
    const o = Object.assign({
      volatility: 'slow',
      window: 150,        // 滾動視窗保留幾個樣本
      full: 60,           // 樣本到這麼多就完全採信（之前跟預設值加權混合）
      settle: 30,         // 連續穩定這麼多次才算定下來
      tol: 0.03,          // 相鄰兩次估計差這麼少算穩定
      band: 0.25,         // 偏離已定值這麼多算「真的變了」
      dwell: 45,          // 而且要持續這麼多次
      estimate: median,
      fallback: 0,
    }, opts);
    const buf = [];
    const K = o.band / 2;             // 容忍量：小於這個的偏離不累積
    const H = o.dwell * o.band / 2;   // 決策界限
    let value = o.fallback, settled = false, stable = 0, prev = 0;
    let cHi = 0, cLo = 0;
    return {
      get value() { return value; },
      get settled() { return settled; },
      get n() { return buf.length; },
      get weight() { return Math.min(1, buf.length / o.full); },
      get raw() { return o.estimate(buf); },
      // 目前累積了多少證據（0..1，1 就是即將觸發）。放進面板看得到變化在醞釀
      get evidence() { return H ? Math.min(1, Math.max(cHi, cLo) / H) : 0; },
      reset() {
        buf.length = 0; value = o.fallback;
        settled = false; stable = 0; prev = 0; cHi = 0; cLo = 0;
      },
      // 回傳 'settled' | 'changed' | undefined，讓呼叫端決定要不要通知使用者
      push(v) {
        buf.push(v);
        if (buf.length > o.window) buf.shift();
        const est = o.estimate(buf);

        if (o.volatility === 'live') { value = est; return; }

        if (settled) {
          // 兩側 CUSUM，以相對偏離為單位
          const z = value ? est / value - 1 : 0;
          cHi = Math.max(0, cHi + z - K);
          cLo = Math.max(0, cLo - z - K);
          if (cHi > H || cLo > H) {
            cHi = 0; cLo = 0;
            if (o.volatility === 'static') { this.reset(); return 'changed'; }
            value = est; return 'changed';     // slow：換到新值但不重來
          }
          return;
        }

        const w = this.weight;
        value = o.fallback * (1 - w) + est * w;
        const drift = prev ? Math.abs(est - prev) / Math.abs(prev) : 1;
        prev = est;
        stable = drift < o.tol ? stable + 1 : 0;
        if (w >= 1 && stable >= o.settle) { settled = true; value = est; return 'settled'; }
      },
    };
  }

  // 三個量，三種波動性。預設值都用畫面比例，量到之後換成身體尺度。
  const trk = {
    // 估計量用第 80 百分位，不是中位數。
    // 透視投影「只會讓線段變短、不會變長」，所以觀測值的分布是
    // 「真實長度」往下拖出一條尾巴 —— 中位數會被每一幀的前縮系統性低估，
    // 也會被殘留的幽靈樣本拉走。取高百分位才貼近真實長度。
    forearm: Tracked({ volatility: 'static', fallback: 0,
                       estimate: (v) => pctile(v, 0.80) }),
    // 雜訊地板取每幀位移的第 10 百分位 —— 不需要請人站著別動，
    // 任何一段時間裡都有手比較靜的時刻，那些低位移就是雜訊
    noise: Tracked({ volatility: 'static', fallback: 0,
                     estimate: (v) => pctile(v, 0.10) }),
    // 光線會變，所以這個要持續跟
    score: Tracked({ volatility: 'slow', fallback: 0.6,
                     band: 0.15, dwell: 60, settle: 30 }),
  };

  const autoScore = () => ui.scoreSel.value === 'auto';

  function resetCalib() {
    for (const k of Object.keys(trk)) trk[k].reset();
    calib = null; calLast = null;
  }

  let calLast = null;

  // 這一筆「手肘→手腕」的長度，可不可以拿來當校正樣本。
  //
  // 尺規一定要是「不經過任何估計器」的量，所以只能用真的量到的肩寬。
  // 不可以退回 calib.forearm —— 那等於讓估計器自己決定什麼叫合理，
  // 一旦學壞就再也出不來。
  //
  // 沒有肩寬的那些幀「不收樣本」，不是「照收」。
  // 原本寫成 if (sw > 4 && 不合理) continue —— 肩膀看不到時整道閘門被略過、
  // 什麼長度都收。而「單手舉起、另一邊肩膀只有 0.1x」是常態不是例外，
  // 實機因此先後把前臂學成 40px 和 17px（真實約 200px），整組門檻跟著崩掉。
  function forearmSampleOK(len, shoulderW) {
    if (!(shoulderW > 4)) return false;
    const r = len / shoulderW;
    return r >= FORE_VS_SHOULDER_LO && r <= FORE_VS_SHOULDER_HI;
  }

  // 現在在用的是哪一隻手。
  // 模型對沒舉起的那隻手一樣會吐出一組座標，分數通常低一截 ——
  // 用手腕分數高的那邊當「真的那隻」，不設門檻（設了就變成雞生蛋）。
  function activeSide(kp) {
    const sl = (kp.left_wrist  && kp.left_wrist.score)  || 0;
    const sr = (kp.right_wrist && kp.right_wrist.score) || 0;
    return sl >= sr ? 'left' : 'right';
  }

  function feedCalib(kp) {
    // 信心樣本只收「正在用的那隻手」。
    //
    // 原本兩隻手一起推進同一個 Tracked，而單手遊玩時每幀固定 2 真 2 幽靈 ——
    // 雙峰分布的中位數卡在兩群中間的鞍點上，樣本數一點點失衡就整個翻面。
    // 實機一局量到 MIN_SCORE 在 0.12 ↔ 0.37 之間來回跳，肩膀 0.22 的
    // 真關節因此每十幀閃一次 → 那幀沒有刀 → prev 歸 null →
    // 下一點 linked=false → activeRun 只剩一個點 → 刀痕永遠畫不出來。
    // 只收一隻手之後分布是單峰的，中位數穩定。
    //
    // ⚠ 已知未解：手放下（還在畫面裡）時這兩個點只剩猜測值，中位數跟著掉、
    // 門檻掉到下限，幽靈手腕就過得了門檻 —— 詳見 HANDOFF「門檻會跟著
    // 沒有手一起往下掉」。
    // 試過改用肩膀當錨點，但實機資料否決了：用「鏈成立且接得上上一幀」
    // 這個不涉及手腕分數的標籤分群之後，兩群的手腕分數分布幾乎完全重疊
    // （中位都是 0.11，腕/肩 0.44 vs 0.34），任何係數都分不開，
    // 只會連真手腕一起擋掉。沒有證據支持的修法不要上。
    const act = activeSide(kp);
    {
      const e = kp[act + '_elbow'], w = kp[act + '_wrist'];
      // 不設信心門檻 —— 自動放寬正是為了「拿不到高分」的情況設計的，
      // 拿高分當入場券就永遠跑不起來（§4.5）。
      if (e) trk.score.push(e.score);
      if (w) trk.score.push(w.score);
    }
    for (const side of SIDES) {
      const e = kp[side + '_elbow'], w = kp[side + '_wrist'];
      // 前臂樣本的門檻跟著 MIN_SCORE 走，不要寫死 0.25 ——
      // MIN_SCORE 會自動降到 0.12，寫死的話暗房裡刀能用但校正永遠不啟動。
      if (!e || !w || below(e.score, MIN_SCORE) || below(w.score, MIN_SCORE)) continue;
      const len = Math.hypot(e.x - w.x, e.y - w.y);
      // 用當幀的肩寬把明顯不是手臂的樣本擋掉。
      //
      // 兩隻手的樣本是丟進同一個估計器的，而沒舉起的那隻手，模型會把
      // 手肘和手腕都猜在身體邊緣、擠成 20–50px。兩群數值混在一起取中位數，
      // 中位數就掉進幽靈那一群 —— 實測校正值因此鎖在 40px。
      // 肩寬是這一幀量到的，不經過估計器，拿它當尺規最安全。
      if (!forearmSampleOK(len, shoulderWidth(kp))) continue;
      if (trk.forearm.push(len) === 'changed') {
        // 位置變了就連雜訊地板一起重量 —— 距離不同，雜訊的像素尺度也不同。
        // 同時重開靜止窗，讓它有機會在新位置重新量一次。
        trk.noise.reset(); calLast = null;
        readyAt = performance.now();
        setStatus('你的位置變了，重新量一次。');
      }
    }
    // 雜訊只在「靜止窗」裡收：相機剛開、人還沒把手移到按鈕上的那幾秒。
    // 那是真的靜止，量到的位移就是雜訊地板。
    //
    // 窗外不收是刻意的 —— 玩的時候手一直在動，繼續收只會把雜訊地板
    // 一路推高、揮擊門檻跟著升、越玩越難切中。那是會自己惡化的迴路。
    // 估計器仍用第 10 百分位，萬一這個人一開始就在動也擋得住。
    const inRest = readyAt && performance.now() - readyAt < REST_MS;
    if (inRest && !trk.forearm.settled) {
      const w = kp.right_wrist || kp.left_wrist;
      // 門檻跟著 MIN_SCORE 走，不要寫死。寫死 0.25 的話，
      // 暗房裡 MIN_SCORE 降到 0.12、刀能用，雜訊地板卻永遠量不到。
      if (w && atLeast(w.score, MIN_SCORE)) {
        if (calLast) trk.noise.push(Math.hypot(w.x - calLast.x, w.y - calLast.y));
        calLast = { x: w.x, y: w.y };
      }
    }
    recalc();
    adaptScore();
  }

  function recalc() {
    if (!trk.forearm.n) { calib = null; return; }
    // 鎖定前用 raw（估計器的原始輸出），不要用 value。
    //
    // Tracked.value 在未鎖定時已經是 est × weight 了，recalc 下面的 mix()
    // 會再乘一次 —— 權重套兩次，門檻在校正中途非單調，而且 calib.forearm
    // 被系統性低估。混合只該做一次，就是 mix() 那次。
    const forearm = trk.forearm.settled ? trk.forearm.value : trk.forearm.raw;
    const noise = trk.noise.value;
    const w = trk.forearm.weight;
    const mix = (def, got) => def * (1 - w) + got * w;
    calib = {
      n: trk.forearm.n, w, forearm, noise,
      locked: trk.forearm.settled,
      score: trk.score.value,
      slashMin: mix(px(F.slashMin),
                    Math.max(forearm * SLASH_FOREARM, noise * SLASH_NOISE_MUL)),
      // 下限用畫面比例兜著。校正值一旦被汙染變小，這裡會跟著變嚴，
      // 關節被凍住 → 凍住的點再回頭餵給校正 → 越來越小。那是會自己惡化的
      // 迴路，實測跳動閘門因此觸發 3164 次。給它一個跟身形無關的地板。
      maxSpeed: Math.max(px(MAX_JOINT_SPEED) * 0.5,
                         mix(px(MAX_JOINT_SPEED), forearm * SPEED_FOREARM)),
    };
  }

  // 光線差 → 整體信心下降 → 門檻跟著降，不然整條手臂會被判成不可信。
  // 光線變好 → 門檻升回去，不然會把雜訊當成手。兩個方向都自動。
  // 遲滯由 Tracked 的 band/dwell 負責，這裡只做對應。
  function adaptScore() {
    if (!autoScore() || trk.score.n < 20) return;
    const target = Math.min(SCORE_MAX, Math.max(SCORE_MIN, trk.score.value * 0.5));
    if (Math.abs(target - MIN_SCORE) < 0.005) return;
    const was = MIN_SCORE;
    MIN_SCORE = target;
    if (Math.abs(target - was) >= 0.04) {
      setStatus('光線變了，信心門檻自動從 ' + was.toFixed(2)
        + ' 調到 ' + target.toFixed(2) + '。');
    }
  }

  const slashMinPx = () => calib ? calib.slashMin : px(F.slashMin);
  const maxSpeedPx = () => calib ? calib.maxSpeed : px(MAX_JOINT_SPEED);
  const calibLockedNow = () => trk.forearm.settled;

  // ---- 關節穩定化 ----------------------------------------------------------

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // 骨長的滾動中位數。用中位數不用平均，因為平均會被跳動本身拉走 ——
  // 而我們正是要用這個值去判斷跳動。
  function boneLength(name, v) {
    const w = boneMed[name] || (boneMed[name] = []);
    w.push(v);
    if (w.length > 31) w.shift();
    const srt = [...w].sort((a, b) => a - b);
    return srt[srt.length >> 1];
  }

  // 1) 左右身分：模型會把左右手整個標反，造成點橫跨身體瞬移。
  //    每幀試兩種指派，選跟上一幀最吻合的那個。
  function fixSides(kp) {
    // 用整條鏈比對，不是只看手腕。
    // 只看手腕的話，「手腕標對但手肘標反」這種錯配偵測不到 ——
    // 而那正是單手時最常發生的情形。
    let keep = 0, swap = 0, n = 0;
    for (const part of ARM) {
      const pl = joint['left_' + part], pr = joint['right_' + part];
      const cl = kp['left_' + part], cr = kp['right_' + part];
      if (!pl || !pr || !cl || !cr) continue;
      keep += dist(cl, pl) + dist(cr, pr);
      swap += dist(cl, pr) + dist(cr, pl);
      n++;
    }
    if (!n) return false;
    // 要明顯比較好才換，不然兩邊差不多時會每幀來回跳
    if (swap >= keep * SWAP_MARGIN) return false;
    for (const part of ARM) {
      const a = 'left_' + part, b = 'right_' + part;
      const t = kp[a]; kp[a] = kp[b]; kp[b] = t;
    }
    stats.sideFix++;
    return true;
  }

  // 2) 跳動閘門：單幀位移超過人類極限就丟掉這次偵測，沿用上一個。
  //    但不能永遠擋 —— 人真的走到別處時要讓它跟上，所以有時限。
  function gateJumps(kp, now) {
    for (const side of SIDES) {
      for (const part of ARM) {
        const name = side + '_' + part;
        const k = kp[name];
        if (!k || below(k.score, MIN_SCORE)) { delete joint[name]; continue; }
        const p = joint[name];
        if (p) {
          const dt = Math.max((now - p.t) / 1000, 1e-3);
          const speed = dist(k, p) / dt;
          const held = p.heldSince ? now - p.heldSince : 0;
          if (speed > maxSpeedPx() && held < HOLD_MAX_MS) {
            kp[name] = { x: p.x, y: p.y, score: k.score, name };
            p.heldSince = p.heldSince || now;
            p.t = now;
            stats.jumpGate++;
            continue;
          }
        }
        joint[name] = { x: k.x, y: k.y, t: now, heldSince: 0 };
      }
    }
  }

  // 3) 骨長合理性：上臂、前臂的長度不會突然變成兩倍。
  //    會變就是末端那個點抓錯了，沿用上一個。
  function gateBones(kp, now) {
    for (const side of SIDES) {
      for (const [a, b] of [['shoulder', 'elbow'], ['elbow', 'wrist']]) {
        const ka = kp[side + '_' + a], kb = kp[side + '_' + b];
        if (!ka || !kb) continue;
        const name = side + '_' + a + '_' + b;
        const len = dist(ka, kb);
        const med = boneLength(name, len);
        if (med > 4 && (len < med * BONE_LO || len > med * BONE_HI)) {
          const p = joint[side + '_' + b];
          if (p && now - (p.heldSince || now) < HOLD_MAX_MS) {
            kp[side + '_' + b] = { x: p.x, y: p.y, score: kb.score, name: kb.name };
            stats.boneGate++;
          }
        }
      }
    }
  }

  // 出框的點要直接消失，不是「降低權重」。
  //
  // 模型不會告訴你出框了 —— MoveNet 永遠回傳 17 個點，出框的會被壓在
  // 邊界上，位置看起來合法、只是分數低。所以規則是
  // 「在邊界上**而且**信心不夠」才當作沒有這個點。
  // 真手確實會揮到畫面邊緣，但那時分數是高的，所以留得下來。
  //
  // 在這裡刪（跟跳動閘門同一個地方）而不是在每個消費端各判一次：
  // 刪掉之後 SPRT 會看到「三個點湊不齊」而往丟棄端推、chainOK 與
  // armsDistinct 自動略過、bladeFor 拿不到點就沒有刀 —— 一個入口，
  // 下游全部自動正確。
  //
  // 使用者回報：「手已經放下來在螢幕外了，卻仍然被判定有手刀可以切」。
  const EDGE_MARGIN = 0.25;      // 離邊界多近算在邊緣（身體尺度，約 1/4 前臂）
  const EDGE_SCORE_MUL = 1.5;    // 在邊緣的話信心要高這麼多倍才留

  function dropOffFrame(kp) {
    const m = bodyScale(kp) * EDGE_MARGIN;
    for (const side of SIDES) {
      for (const part of ARM) {
        const name = side + '_' + part;
        const k = kp[name];
        if (!k) continue;
        const atEdge = k.x < m || k.y < m
                    || k.x > cv.width - m || k.y > cv.height - m;
        if (atEdge && below(k.score, scoreNeed(part) * EDGE_SCORE_MUL)) {
          delete kp[name];
          delete joint[name];
          stats.offFrame++;
        }
      }
    }
  }

  function stabilize(kp, now) {
    if (!ui.stable.checked) return;
    dropOffFrame(kp);
    fixSides(kp);
    gateJumps(kp, now);
    gateBones(kp, now);
  }

  // ---- 懸停按鈕（Kinect 式）------------------------------------------------
  //
  // 把手停在按鈕上，圓圈走完一圈就觸發。體感遊戲沒有游標也沒有點擊，
  // 懸停計時是唯一不需要額外手勢就能確認的方式。
  //
  // 注意：「開始」那一顆不能用這個 —— 相機還沒開就沒有手可以追，
  // 而且瀏覽器規定相機權限與 AudioContext 都要由真實點擊觸發。
  const DWELL_MS = 2000;    // 要停多久才算按下
  const DWELL_DECAY = 2.5;  // 手離開後進度倒退的速度（倍率）
  let hoverBtns = [];

  function hoverPoints() {
    const pts = [];
    for (const side of SIDES) {
      const tr = trails[side];
      if (tr.length) pts.push(tr[tr.length - 1]);
    }
    return pts;
  }

  function stepHover(dt) {
    const pts = hoverPoints();
    for (const b of hoverBtns) {
      const on = pts.some((p) => Math.hypot(p.x - b.x, p.y - b.y) <= b.r);
      const was = b.dwell;
      b.dwell = on
        ? Math.min(1, b.dwell + dt * 1000 / DWELL_MS)
        : Math.max(0, b.dwell - dt * DWELL_DECAY);
      // 每走過 1/6 圈滴一聲，讓人知道系統有在讀他的動作
      if (on && Math.floor(was * 6) !== Math.floor(b.dwell * 6)) sfx('tick');
      if (b.dwell >= 1) {
        b.dwell = 0;
        sfx('confirm');
        const fn = b.action;
        hoverBtns = [];
        fn();
        return;
      }
    }
  }

  // 追蹤失靈、或手不方便舉的時候，滑鼠點圓圈也要能用。
  // 體感是主要操作方式，但不該是唯一的。
  cv.addEventListener('click', (ev) => {
    if (!hoverBtns.length) return;
    const r = cv.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (cv.width / r.width);
    const y = (ev.clientY - r.top) * (cv.height / r.height);
    for (const b of hoverBtns) {
      if (Math.hypot(x - b.x, y - b.y) <= b.r) {
        initAudio();
        sfx('confirm');
        const fn = b.action;
        hoverBtns = [];
        fn();
        return;
      }
    }
  });

  // 選單狀態下要看得到手在哪，不然使用者不知道該往哪移動。
  // 這個一定要畫在 drawGameOver / drawReady 的半透明遮罩「之後」，
  // 不然會被蓋掉 —— 原本刀刃圓點就是畫在遮罩之前，所以看不見。
  function drawHandCursor() {
    const pts = hoverPoints();
    if (!pts.length) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fbbf24';
      ctx.font = '600 16px -apple-system,"PingFang TC",sans-serif';
      ctx.fillText(framingHint(), cv.width / 2, cv.height * 0.84);
      drawWhyNoArm(cv.height * 0.90);
      return;
    }
    for (const p of pts) {
      // 外圈用脈動的光暈，在暗色遮罩上才看得出來
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 260);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.beginPath(); ctx.arc(0, 0, 26 * pulse, 0, 6.3);
      ctx.fillStyle = 'rgba(96,165,250,.22)'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(96,165,250,.95)'; ctx.stroke();
      ctx.font = '26px serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🖐', 0, 1);
      ctx.restore();
    }
  }

  // 得分與生命值。兩個都畫在 canvas 上 —— 之前得分是 HTML、生命值是 canvas，
  // 兩套畫法混用，結果得分又小又暗，根本沒人注意到。
  function drawHud(now) {
    // 扣命的那一刻畫面邊緣閃紅。聲音可能被忽略，畫面不會。
    const hurt = hurtAt ? 1 - Math.min(1, (now - hurtAt) / 500) : 0;
    if (hurt > 0) {
      const g = ctx.createRadialGradient(
        cv.width/2, cv.height/2, Math.min(cv.width, cv.height) * 0.25,
        cv.width/2, cv.height/2, Math.max(cv.width, cv.height) * 0.62);
      g.addColorStop(0, 'rgba(248,113,113,0)');
      g.addColorStop(1, 'rgba(248,113,113,' + (0.55 * hurt).toFixed(3) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(248,113,113,' + Math.min(1, hurt * 1.6).toFixed(2) + ')';
      ctx.font = '700 26px -apple-system,"PingFang TC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(hurtWhy, cv.width / 2, cv.height * 0.20);
    }

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 8;

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '600 13px -apple-system,"PingFang TC",sans-serif';
    ctx.fillText('分數', 16, 12);
    ctx.fillStyle = now < doubleUntil ? '#fbbf24' : '#fff';
    ctx.font = '700 40px -apple-system,"PingFang TC",sans-serif';
    ctx.fillText(String(score), 16, 28);

    ctx.textAlign = 'right';
    ctx.font = '24px serif';
    let hearts = '';
    for (let i = 0; i < LIVES; i++) hearts += i < lives ? '❤️' : '🖤';
    // 剛扣命時愛心抖一下，視線在別處也會被餘光抓到
    const shake = hurt > 0 ? Math.sin(now / 24) * 5 * hurt : 0;
    ctx.fillText(hearts, cv.width - 14 + shake, 14);

    // 生效中的寶物：顯示剩幾秒，不然不知道什麼時候會沒
    let y = 50;
    const badge = (icon, label, until) => {
      const left = (until - now) / 1000;
      if (left <= 0) return;
      ctx.font = '600 14px -apple-system,"PingFang TC",sans-serif';
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(icon + ' ' + label + ' ' + left.toFixed(1) + 's', cv.width - 14, y);
      y += 22;
    };
    badge('⭐', '雙倍', doubleUntil);
    badge('🍌', '慢動作', freezeUntil);

    // 連擊：只在真的連起來時才出現，平常不要佔畫面
    if (comboN >= 3 && now - comboAt < COMBO_WINDOW) {
      const fade = 1 - (now - comboAt) / COMBO_WINDOW;
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.min(1, fade * 1.6);
      ctx.fillStyle = '#67e8f9';
      ctx.font = '700 34px -apple-system,"PingFang TC",sans-serif';
      ctx.fillText(comboN + ' 連擊！', cv.width / 2, cv.height * 0.14);
      ctx.font = '600 15px -apple-system,"PingFang TC",sans-serif';
      ctx.fillText('×' + Math.min(comboN, COMBO_MAX), cv.width / 2, cv.height * 0.14 + 26);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  }

  // 「偵測點不見了」最糟的回應是畫面什麼都不顯示 —— 使用者分不清是
  // 自己沒站好、光線不夠、還是程式壞了。直接把每個關節的分數和門檻印出來。
  // 「舉起手」不一定是對的建議。肩膀分數也偏低時，問題是整個人框太近、
  // 身體被裁掉 —— MoveNet 是看較完整的人訓練出來的，這時候叫人舉手沒有用。
  function framingHint() {
    if (!lastPose) return '站到鏡頭前面，讓上半身進到畫面裡';
    const kp = rawKp;
    const sh = Math.max((kp.left_shoulder || {}).score || 0,
                        (kp.right_shoulder || {}).score || 0);
    const wr = Math.max((kp.left_wrist || {}).score || 0,
                        (kp.right_wrist || {}).score || 0);
    if (sh < 0.55) return '整個人離鏡頭太近了，退遠一點或把相機往後移';
    if (wr < MIN_SCORE) return '舉起手，讓手掌進到畫面裡';
    return '手肘最好也入鏡，掌刀會更準';
  }

  function drawWhyNoArm(y) {
    if (!lastPose) {
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '400 12px -apple-system,"PingFang TC",sans-serif';
      ctx.fillText('完全沒偵測到人', cv.width / 2, y);
      return;
    }
    const kp = rawKp;

    const why = SIDES
      .filter((sd) => noBlade[sd])
      .map((sd) => (sd === 'left' ? '左手' : '右手') + '　' + noBlade[sd]);

    // 軌跡確認不了是最難從外面看出原因的一種 —— 把證據攤開。
    // 這幾行是給開發者看的儀器，跟上面給玩家的提示分開。
    const ev = !why.length ? [] : SIDES.map((sd) => {
      const e = evLast[sd], c = chainWhy[sd];
      if (!e) return (sd === 'left' ? '左' : '右') + ' —';
      const f = (k, ok) => (ok ? '' : '✗') + k;
      const r = c ? ' 上/肩 ' + (c.rU == null ? '—' : c.rU.toFixed(2))
                  + ' 前/校 ' + (c.rF == null ? '—' : c.rF.toFixed(2)) : '';
      return (sd === 'left' ? '左' : '右') + ' \u039b' + track[sd].toFixed(1)
           + ' ' + f('鏈', e.chain) + f('續', e.cont) + f('強', e.strong) + r;
    });

    // 先把每一列和它的高度排出來，再決定從哪裡開始畫。
    // 原本直接從 y 往下排，在 y = 0.90×畫布高 的呼叫點會超出下緣 ——
    // 被切掉的正好是最後一行，也就是最關鍵的那行證據。
    const rows = [{ kind: 'scores', h: 18 }];
    if (why.length) {
      for (const t of why) rows.push({ kind: 'hint', text: t, h: 17 });
      for (const t of ev)  rows.push({ kind: 'ev',   text: t, h: 14 });
    } else {
      rows.push({ kind: 'hint', h: 17,
                  text: '肩膀、手肘、手腕三點都要進畫面，掌刀才算得出來' });
    }
    // 最後一列的基線 = 起點 + 前面所有列的高度
    const above = rows.slice(0, -1).reduce((a, r) => a + r.h, 0);
    let cy = Math.min(y, cv.height - 6 - above);

    for (const r of rows) {
      if (r.kind === 'scores') {
        ctx.font = '400 12px -apple-system,"PingFang TC",sans-serif';
        ctx.textAlign = 'left';
        let x = cv.width / 2 - 150;
        for (const side of SIDES) {
          ctx.fillStyle = '#9aa3b2';
          ctx.fillText(side === 'left' ? '左' : '右', x, cy);
          x += 18;
          for (const part of ARM) {
            const k = kp[side + '_' + part];
            const sc = k ? k.score : 0;
            const need = scoreNeed(part);
            ctx.fillStyle = sc >= need ? '#4ade80' : '#f87171';
            ctx.fillText({ shoulder: '肩', elbow: '肘', wrist: '腕' }[part]
                         + ' ' + sc.toFixed(2), x, cy);
            x += 52;
          }
          x += 14;
        }
        ctx.textAlign = 'center';
      } else if (r.kind === 'hint') {
        ctx.font = '400 12px -apple-system,"PingFang TC",sans-serif';
        ctx.fillStyle = why.length ? '#fbbf24' : '#9aa3b2';
        ctx.fillText(r.text, cv.width / 2, cy);
      } else {
        ctx.font = '400 11px ui-monospace,Menlo,monospace';
        ctx.fillStyle = '#9aa3b2';
        ctx.fillText(r.text, cv.width / 2, cy);
      }
      cy += r.h;
    }
    ctx.font = '400 12px -apple-system,"PingFang TC",sans-serif';
  }

  // 把模型輸出的 17 個點原封不動畫出來 —— 不過門檻、不經穩定化。
  // 「分數很低」和「位置找錯」是兩回事，光看分數分不出來；
  // 把點畫在它實際落的地方，一眼就知道模型把人認在哪。
  const SKELETON = [
    ['left_shoulder','right_shoulder'],
    ['left_shoulder','left_elbow'], ['left_elbow','left_wrist'],
    ['right_shoulder','right_elbow'], ['right_elbow','right_wrist'],
    ['left_shoulder','left_hip'], ['right_shoulder','right_hip'],
    ['left_hip','right_hip'],
    ['left_hip','left_knee'], ['left_knee','left_ankle'],
    ['right_hip','right_knee'], ['right_knee','right_ankle'],
  ];

  function drawRawPose() {
    if (!lastPose) {
      ctx.fillStyle = '#f87171';
      ctx.font = '600 15px -apple-system,"PingFang TC",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('模型完全沒回傳姿勢', cv.width / 2, cv.height * 0.5);
      return;
    }
    const kp = rawKp;
    const X = (k) => cv.width - k.x;   // 畫面是鏡像的

    ctx.lineWidth = 2;
    for (const [a, b] of SKELETON) {
      const ka = kp[a], kb = kp[b];
      if (!ka || !kb) continue;
      const w = Math.min(ka.score, kb.score);
      ctx.strokeStyle = 'rgba(248,113,113,' + (0.15 + w * 0.7).toFixed(2) + ')';
      ctx.beginPath(); ctx.moveTo(X(ka), ka.y); ctx.lineTo(X(kb), kb.y); ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.font = '600 10px ui-monospace,Menlo,monospace';
    for (const k of Object.values(rawKp)) {
      if (!k.name) continue;
      const x = X(k), y = k.y;
      // 顏色代表分數：越綠越有信心
      const g = Math.round(80 + k.score * 175);
      ctx.fillStyle = `rgba(${Math.round(248 - k.score * 180)},${g},113,0.95)`;
      ctx.beginPath(); ctx.arc(x, y, 3 + k.score * 4, 0, 6.3); ctx.fill();
      ctx.fillText(k.score.toFixed(2), x + 7, y + 3);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 13px -apple-system,"PingFang TC",sans-serif';
    ctx.fillText('原始輸出（未過門檻）　整體分數 '
      + (lastPose.score != null ? lastPose.score.toFixed(2) : '—'),
      cv.width / 2, 18);
  }

  function drawHoverBtns() {
    for (const b of hoverBtns) {
      ctx.save();
      ctx.translate(b.x, b.y);
      const hot = b.dwell > 0;
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, 6.3);
      ctx.fillStyle = hot ? 'rgba(24,36,56,.9)' : 'rgba(16,20,28,.82)'; ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = hot ? 'rgba(96,165,250,.45)' : 'rgba(255,255,255,.22)';
      ctx.stroke();
      if (b.dwell > 0) {
        ctx.beginPath();
        ctx.arc(0, 0, b.r, -Math.PI / 2, -Math.PI / 2 + b.dwell * Math.PI * 2);
        ctx.lineWidth = 6; ctx.strokeStyle = '#60a5fa'; ctx.lineCap = 'round';
        ctx.stroke();
      }
      ctx.fillStyle = '#e6e8ec';
      ctx.font = '600 17px -apple-system,"PingFang TC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, -7);
      ctx.font = '400 11px -apple-system,"PingFang TC",sans-serif';
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText('手停住，或用點的', 0, 13);
      ctx.restore();
    }
  }

  // ---- 音效 ----------------------------------------------------------------
  //
  // 全部用 Web Audio 合成，不帶任何音檔 —— 省掉素材、授權、載入時間。
  //
  // 自動播放政策：在使用者手勢之外建立的 AudioContext 會是 suspended，
  // 而且 Safari/iOS 上在手勢外呼叫 resume() 會被「無聲忽略」—— 不報錯，
  // 就是沒聲音。所以 AudioContext 只在「開始」按鈕的 click 處理器裡建立，
  // 並掛一個一次性的 fallback，萬一第一次沒 resume 成功，之後任何點擊都能救回來。
  let actx = null;

  function initAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { actx = new AC(); } catch (e) { return; }
    actx.resume();
    if (actx.state !== 'running') {
      const retry = () => {
        if (!actx) return;
        actx.resume();
        if (actx.state === 'running') {
          document.removeEventListener('click', retry);
          document.removeEventListener('touchstart', retry);
        }
      };
      document.addEventListener('click', retry);
      document.addEventListener('touchstart', retry);
    }
  }

  // 一段帶包絡的白噪音，用來做「刷」的風聲與爆炸
  function noiseBurst(dur, { type = 'bandpass', freq = 2000, q = 1, gain = 0.25,
                             sweepTo = null } = {}) {
    const n = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, n, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = actx.createBufferSource(); src.buffer = buf;
    const flt = actx.createBiquadFilter();
    flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
    if (sweepTo != null) {
      flt.frequency.setValueAtTime(freq, actx.currentTime);
      flt.frequency.exponentialRampToValueAtTime(sweepTo, actx.currentTime + dur);
    }
    const g = actx.createGain();
    g.gain.setValueAtTime(gain, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    src.connect(flt).connect(g).connect(actx.destination);
    src.start();
  }

  function tone(freq, dur, { type = 'sine', gain = 0.2, to = null, delay = 0 } = {}) {
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to != null) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // 炸彈飛行中的引信聲。查到的原話是這個聲音「makes your stomach drop」——
  // 我們原本只有炸到之後的爆炸聲，等於完全沒有事前警告。
  function startFuse(seconds) {
    if (!actx || actx.state !== 'running' || !ui.sound.checked) return null;
    try {
      const n = Math.floor(actx.sampleRate * seconds);
      const buf = actx.createBuffer(1, n, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1);
      const src = actx.createBufferSource(); src.buffer = buf;
      const flt = actx.createBiquadFilter();
      flt.type = 'bandpass'; flt.frequency.value = 5200; flt.Q.value = 1.1;
      const g = actx.createGain();
      // 由小漸大，越接近越緊張
      g.gain.setValueAtTime(0.001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, actx.currentTime + seconds * 0.8);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + seconds);
      src.connect(flt).connect(g).connect(actx.destination);
      src.start();
      return () => { try { src.stop(); } catch (e) { /* 已經停了 */ } };
    } catch (e) { return null; }
  }

  function sfx(kind, arg) {
    if (!actx || actx.state !== 'running' || !ui.sound.checked) return;
    try {
      if (kind === 'slice') {
        const gen = arg || 0;   // 切得越細，聲音越輕越高
        noiseBurst(0.11, { freq: 2600 + gen * 900, q: 0.9,
                           gain: 0.22 * Math.pow(0.7, gen), sweepTo: 700 });
        tone(300 + gen * 120, 0.09, { type: 'triangle', gain: 0.1 * Math.pow(0.7, gen) });
      } else if (kind === 'bomb') {
        noiseBurst(0.5, { type: 'lowpass', freq: 900, gain: 0.45, sweepTo: 90 });
        tone(70, 0.4, { type: 'sawtooth', gain: 0.22, to: 32 });
      } else if (kind === 'miss') {
        tone(220, 0.16, { type: 'sine', gain: 0.14, to: 150 });
      } else if (kind === 'over') {
        [440, 350, 262, 196].forEach((f, i) =>
          tone(f, 0.28, { type: 'triangle', gain: 0.18, delay: i * 0.14 }));
      } else if (kind === 'crit') {
        noiseBurst(0.13, { freq: 4200, q: 1.4, gain: 0.26, sweepTo: 900 });
        tone(1320, 0.18, { type: 'triangle', gain: 0.2, to: 1760 });
      } else if (kind === 'combo') {
        // 連擊數越高音越高，耳朵自己會知道在累積
        const n = Math.min(arg || 2, 8);
        tone(440 * Math.pow(1.122, n * 2), 0.1, { type: 'square', gain: 0.09 });
      } else if (kind === 'gem') {
        [784, 1047, 1319].forEach((f, i) =>
          tone(f, 0.16, { type: 'triangle', gain: 0.17, delay: i * 0.055 }));
      } else if (kind === 'power') {
        tone(523, 0.12, { type: 'square', gain: 0.1 });
        tone(784, 0.2, { type: 'triangle', gain: 0.16, delay: 0.08, to: 1047 });
      } else if (kind === 'tick') {
        tone(1100, 0.04, { type: 'square', gain: 0.05 });
      } else if (kind === 'confirm') {
        tone(660, 0.1, { type: 'triangle', gain: 0.18 });
        tone(990, 0.14, { type: 'triangle', gain: 0.16, delay: 0.08 });
      }
    } catch (e) { /* 聲音壞掉不該影響遊戲 */ }
  }

  // ---- 遊戲 ----------------------------------------------------------------
  // 果汁顆粒需要顏色，emoji 本身取不到，所以一併列出來
  const FRUIT = [
    { ch:'🍉', color:'#f2415a' }, { ch:'🍊', color:'#ff9f2e' },
    { ch:'🍋', color:'#ffd93d' }, { ch:'🍓', color:'#f2415a' },
    { ch:'🥝', color:'#7ac74f' }, { ch:'🍎', color:'#e8453c' },
  ];
  const BOMB = { ch:'💣', color:'#8b8f99' };

  // 寶物不會被切成兩半 —— 它們是「拿到」不是「切開」，
  // 讓它們跟水果用不同的反應，玩家一眼就分得出發生了什麼事。
  const TREASURE = {
    gem:    { ch:'💎', color:'#67e8f9', p:0.06, label:'+5',    sound:'gem' },
    双倍:   { ch:'⭐', color:'#fbbf24', p:0.04, label:'雙倍分數', sound:'power' },
    freeze: { ch:'🍌', color:'#fde68a', p:0.04, label:'慢動作',  sound:'power' },
    life:   { ch:'❤️', color:'#f87171', p:0.03, label:'+1 命',   sound:'power' },
  };
  const FREEZE_MS = 4500, DOUBLE_MS = 7000;

  // 炸彈飛得比水果慢，讓人來得及把手移開。
  //
  // 做法是「等價的時間縮放」：速度 ×k、重力 ×k²。
  // 這樣軌跡的**形狀完全不變**（頂點高度 v²/2g 與水平距離都不變），
  // 只是走完同一條路要 1/k 倍的時間。
  // 不能只調速度不調重力 —— 那會變成一顆飛得比較低的炸彈，
  // 玩家對它的落點預期會錯，反而更容易誤砍。
  //
  // k = 0.72 → 滯空從 1.6–2.1 秒拉長到 2.2–2.9 秒，多出約 39% 的反應時間。
  // 不做得更慢是因為炸彈在畫面上待越久，被亂揮的刀掃到的機會也越多。
  const BOMB_SLOW = 0.72;

  // 連擊：Fruit Ninja 的計分核心 —— 連續切中不失手，倍率往上爬。
  // 視窗 1.1 秒取自 tubakhxn/Webcam-Fruit-Ninja 的 COMBO_WINDOW。
  const COMBO_WINDOW = 1100, COMBO_MAX = 5;
  const CRIT_P = 0.08, CRIT_BONUS = 10;

  // ── 關節穩定化 ──
  // 抖動（小幅高頻雜訊）交給 One Euro；這裡處理的是「跳動」——
  // 整個點瞬間移到別的地方。那不是雜訊，是錯誤的偵測值，濾波治不了：
  // 平滑一個錯誤的點只會得到一個平滑地移到錯誤位置的點。
  //
  // 人的手腕全力揮動大約 3–4 m/s。站 2.5 公尺、畫面寬約涵蓋 2 公尺時，
  // 換算約 1300 px/秒。左右互換造成的跳動是「一幀之內橫跨身體」，
  // 在 30fps 下等於 6000 px/秒以上 —— 兩者差了四倍以上，很好分。
  const MAX_JOINT_SPEED = 3.0;   // 每秒幾個畫面寬，超過就當偵測錯誤
  const HOLD_MAX_MS = 250;       // 連續擋這麼久就放行（人可能真的移動了）
  const BONE_LO = 0.45, BONE_HI = 2.2;   // 骨長相對於中位數的可接受範圍
  const SWAP_MARGIN = 0.6;       // 交換後要好這麼多才真的換，避免來回跳
  const ARM = ['shoulder', 'elbow', 'wrist'];
  // 掌刀 = 手腕 + 0.4 ×（手腕 − 手肘），所以手肘的誤差會被放大 0.4 倍帶進來。
  // 手腕穩但手肘是低信心的猜測值時，看起來就是「手在跳」—— 實際上跳的是手肘。
  // 所以手肘要比手腕更嚴。
  // 手肘誤差會被掌刀算式放大，所以門檻比手腕嚴一點 —— 但只能一點。
  // 原本 1.35 疊在校正之後會變成 0.47，整條手臂都過不了。
  // 手肘的「穩定度」已經由跳動閘門在顧，這裡只需要擋掉明顯的亂猜。
  const ELBOW_SCORE_MUL = 1.15;
  // 肩→肘→腕必須是同一條鏈。人的前臂與上臂長度相近，
  // 透視會讓比例偏離，但不會差到這個範圍外。
  // 比例不合就表示這三點不是同一隻手臂（單手時模型常把左右配錯）。
  // 上臂約 30cm、肩寬約 40cm。肩寬是當下這一幀就有的尺度參考，
  // 不必等校正 —— 而且少了它，光靠「上臂/前臂比例」擋不住配錯的手肘：
  // 錯配出來的鏈比例可能剛好落在合理範圍內，只有絕對尺度看得出不對。
  const UPPER_VS_SHOULDER_HI = 1.5;
  // 成人前臂約 25cm、肩寬約 40cm。這個比值是「沒有校正值時怎麼估身體尺度」
  // 與「樣本合不合理」共用的那一個常數。
  const FORE_OVER_SHOULDER = 0.63;
  // 前臂相對肩寬的上界。真實比值約 0.63，投影只會更短，1.6 留足餘裕。
  const FORE_VS_SHOULDER_HI = 1.6;
  // 收校正樣本時的合理範圍（下界只用在「要不要採信這個樣本」，
  // 不用在「這條鏈成不成立」—— 手伸直朝鏡頭時下界會誤擋，但那種影格
  // 本來就不該拿來估計真實長度）。
  const FORE_VS_SHOULDER_LO = 0.30;
  // 前臂投影短於這個比例時，拿它當方向來源不可靠（手伸直指向鏡頭的情形）
  // —— 改用肩膀→手腕，同一條已驗證的鏈，基線長得多也穩得多
  const DIR_MIN_FOREARM = 0.3;

  // 手臂不會瞬移，也不會憑空出現。一條鏈該不該信，除了看它自己的幾何，
  // 還要看它是不是上一幀的延續 —— 真手是連續動作的產物，
  // 模型猜出來的幽靈手不是。
  const CHAIN_MEM_MS = 700;    // 記得多久以前的鏈
  const CHAIN_MOVE = 0.55;     // 每 33ms 每個關節最多移動幾倍前臂長

  // 軌跡確認：序列機率比檢定（SPRT, Wald）。
  //
  // 這是資料關聯問題：真實世界有 1–2 隻手臂，模型每幀吐出 2 條標好左右的
  // 鏈，要決定哪些是真的。每一幀是一次觀測，累積對數勝算比：
  //
  //   Λ ← Λ + log( P(觀測|真手) / P(觀測|幽靈) )
  //   Λ ≥ A → 確認      A = log((1−β)/α)
  //   Λ ≤ B → 丟棄      B = log(β/(1−α))
  //
  // 好處是門檻由「願意接受的錯誤率」推導，不是挑出來的：
  //   α = 把幽靈當成真手的機率
  //   β = 把真手當成幽靈的機率
  // 而每一項證據的權重也不是選的，是該特徵在兩種假設下出現機率的比值。
  //
  // 這取代了先前的 +1/−1、門檻 3 計數器 —— 那其實是 SPRT 的退化版
  // （二元證據、所有證據等權）。分級證據才用得到它的長處：
  // 強確認的一幀抵得過兩幀勉強的，不必等滿固定幀數。
  const SPRT_ALPHA = 0.01, SPRT_BETA = 0.05;
  const SPRT_A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);   // ≈ +4.55
  const SPRT_B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));   // ≈ −2.98

  // 每一項證據：[P(出現|真手), P(出現|幽靈)]。
  // 這些是假設，但是「可以討論的假設」—— 不像權重 1.5 無從檢驗。
  const EV = {
    chain:  [0.95, 0.30],   // 骨鏈幾何成立
    cont:   [0.92, 0.15],   // 接得上自己上一幀（幽靈沒有穩定歷史）
    strong: [0.80, 0.35],   // 手腕信心明顯高於門檻
  };
  const llr = (k, yes) => {
    const [p1, p0] = EV[k];
    return yes ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
  };

  // ── 校正 ──
  // 原本所有門檻都是用「畫面寬的比例」表示的，那已經比寫死像素好，
  // 但畫面寬跟「這個人的手臂有多長」沒有關係 —— 站遠一點、手臂短一點，
  // 同一個比例的意義就完全不同。
  // 開始前量三秒，把門檻換算成這個人自己的身體尺度。
  // 不做「請站好三秒」那種阻斷式校正 —— 相機一開就持續量，
  // 數值從預設值逐步收斂到量到的，使用者完全不用配合。
  //
  // 會變的、不會變的、緩慢變的，用同一套東西處理（見 Tracked）：
  // 每個量都是「滾動估計器 + 帶遲滯的變化偵測」，差別只在波動性。
  const SLASH_FOREARM = 1.0;   // 一刀至少要掃過一個前臂長
  const SLASH_NOISE_MUL = 6;   // 而且至少要是雜訊地板的這麼多倍
  // 手腕極速。原本 16 個前臂長／秒 = 恰好 4.0 m/s，而人全力揮擊就是 3–4 m/s
  // —— 等於門檻壓在真實動作上，沒有任何餘裕。提到 28 留一倍。
  const SPEED_FOREARM = 28;
  const SCORE_MIN = 0.12, SCORE_MAX = 0.32;
  // 相機剛開、人還在看畫面的那幾秒，是真正的靜止窗 ——
  // 他得先把手移到按鈕上才會開始動，所以這段時間量到的位移就是雜訊地板。
  // 比「從長時間取第 10 百分位」直接得多，也快得多。
  const REST_MS = 2500;

  let bits  = [];    // 果汁顆粒
  let marks = [];    // 切痕閃光 / 炸彈環
  let pops  = [];    // 切中時往上飄的分數

  // 每一塊果肉都帶著「自己被切過哪幾刀」的清單（本體座標系的角度 + 留哪一側）。
  // 再切一刀就是複製成兩塊、各自多一個切面 —— 所以四分之一、八分之一都是
  // 同一套邏輯，不用為「兩半」寫死一組特例。
  const MAX_GEN   = 3;     // 最多切到八分之一，再細就看不出來也沒意義
  const GEN_SHRINK = 0.72; // 每切一刀，命中半徑縮這麼多倍
  const PIECE_IMMUNE_MS = 200;  // 碎塊剛生出來的無敵時間
  const GEN_LABEL = ['—', '1/2', '1/4', '1/8'];

  // 寶物是「拿到」不是「切開」：不分裂，改成一圈光環加文字
  function takeTreasure(f, now) {
    const t = TREASURE[f.treasure];
    stats.treasures++;
    sfx(t.sound);
    marks.push({ kind: 'boom', x: f.x, y: f.y, t: now, R: f.R });
    pops.push({ x: f.x, y: f.y, text: t.label, color: t.color, t: now });
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, v = px(0.1) + Math.random() * px(0.4);
      bits.push({ x:f.x, y:f.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v,
                  r: 2 + Math.random()*3, color: t.color, t: now });
    }
    if (f.treasure === 'gem')        score += (now < doubleUntil ? 10 : 5);
    else if (f.treasure === '双倍')  doubleUntil = now + DOUBLE_MS;
    else if (f.treasure === 'freeze') freezeUntil = now + FREEZE_MS;
    else if (f.treasure === 'life')  lives = Math.min(LIVES, lives + 1);
  }

  // why 會顯示在畫面上。扣命如果只有一聲低音，玩家不會知道發生了什麼 ——
  // 這一局就是漏接漏到沒命，但使用者以為只有炸彈才會結束。
  function loseLife(why) {
    comboN = 0;
    if (over) return;
    lives--;
    hurtAt = performance.now();
    hurtWhy = why || '漏掉了';
    if (lives > 0) { sfx('miss'); return; }
    lives = 0; over = true;
    overWhy = hurtWhy;
    nextSpawn = Infinity;
    if (score > best) { best = score; saveBest(best); }
    sfx('over');
    showGameOver();
  }

  function spawnDelay() { return Math.max(SPAWN_MS_MIN, SPAWN_MS_0 - SPAWN_ACCEL * score); }

  function pickKind() {
    // 炸彈從 3% 開始慢慢爬到 20%，不是一開始就 18%。
    if (Math.random() < Math.min(BOMB_P_CAP, BOMB_P_0 + BOMB_P_GAIN * score)) {
      return { kind: BOMB, bomb: true };
    }
    let r = Math.random();
    for (const [key, t] of Object.entries(TREASURE)) {
      // 命還是滿的時候不要掉愛心，那會讓人覺得遊戲在浪費機會
      if (key === 'life' && lives >= LIVES) continue;
      if (r < t.p) return { kind: t, treasure: key };
      r -= t.p;
    }
    return { kind: FRUIT[Math.floor(Math.random() * FRUIT.length)] };
  }

  function spawn() {
    const x = px(0.125) + Math.random() * (cv.width - px(0.25));
    const { kind, bomb, treasure } = pickKind();
    const slow = bomb ? BOMB_SLOW : 1;
    fruits.push({
      x, y: cv.height + px(F.fruitR),
      vx: ((cv.width / 2 - x) * 0.45 + (Math.random() - 0.5) * 120) * slow,
      vy: -(px(1.19) + Math.random() * px(0.41)) * slow,
      ch: kind.ch, color: kind.color,
      bomb: !!bomb, treasure: treasure || null,
      dead: false, rot: 0, spin: (Math.random() - 0.5) * 4 * slow,
      cuts: [], gen: 0, R: px(bomb ? F.bombR : F.fruitR), slow,
      // 引信聲要跟著拉長，不然聲音先停了炸彈還在飛
      stopFuse: bomb ? startFuse(2.2 / slow) : null,
    });
  }

  // 沒人的時候水果凍住，但果汁、閃光這些殘留特效要讓它們播完，
  // 不然畫面會卡著一堆半透明的東西
  function stepEffectsOnly(dt) {
    const g = px(GRAVITY_F);
    bits = bits.filter((b) => {
      b.vy += g * dt; b.x += b.vx * dt; b.y += b.vy * dt;
      return b.y < cv.height + 20 && performance.now() - b.t < 900;
    });
    marks = marks.filter((m) => performance.now() - m.t < (m.kind === 'boom' ? 420 : 200));
    pops = pops.filter((p) => { p.y -= 46 * dt; return performance.now() - p.t < 700; });
  }

  function stepFruits(dt) {
    // 慢動作只放慢水果，手的追蹤與刀痕維持原速 —— 不然會變成整個遊戲變鈍
    if (performance.now() < freezeUntil) dt *= 0.42;
    const g = px(GRAVITY_F);
    const kept = [];
    for (const f of fruits) {
      if (f.dead) continue;   // 被切開的那塊由它的兩個子塊接手
      // 重力 ×k²：配上生成時的速度 ×k，整條軌跡形狀不變、只是變慢（見 BOMB_SLOW）
      const fg = g * (f.slow || 1) * (f.slow || 1);
      f.vy += fg * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.spin * dt;
      if (f.y > cv.height + f.R * 3) {
        if (f.stopFuse) { f.stopFuse(); f.stopFuse = null; }
        // 只有完整的水果沒切到才算漏掉；碎塊落地是正常的
        // 漏掉寶物只是可惜，不該扣命 —— 那是獎勵不是義務
        // 漏接只計數、不扣命。
        // 體感追蹤本來就會失誤，漏 3 顆就結束等於在處罰系統自己的問題 ——
        // 實測一局 9 切 5 漏，命三顆根本撐不過開頭。只有炸彈扣命。
        if (!f.bomb && !f.treasure && f.gen === 0) {
          stats.misses++;
          comboN = 0;   // 漏接仍然中斷連擊，那是技術問題不是處罰
        }
      } else kept.push(f);
    }
    fruits = kept;
    bits = bits.filter((b) => {
      b.vy += g * dt; b.x += b.vx * dt; b.y += b.vy * dt;
      return b.y < cv.height + 20 && performance.now() - b.t < 900;
    });
    marks = marks.filter((m) => performance.now() - m.t < (m.kind === 'boom' ? 420 : 200));
    pops = pops.filter((p) => { p.y -= 46 * dt; return performance.now() - p.t < 700; });
  }

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
  }

  // cutAngle 是刀痕在世界座標的角度，兩塊會沿它的法線分開
  function hitFruit(f, cutAngle) {
    f.dead = true;
    if (f.stopFuse) { f.stopFuse(); f.stopFuse = null; }
    const R = f.R;
    const now = performance.now();

    if (f.bomb) {
      score = Math.max(0, score - 10); stats.bombs++;
      sfx('bomb');
      loseLife('砍到炸彈');
      marks.push({ kind:'boom', x:f.x, y:f.y, t:now, R });
      pops.push({ x: f.x, y: f.y, text: '−10', color: '#f87171', t: now });
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, v = px(0.12) + Math.random() * px(0.5);
        bits.push({ x:f.x, y:f.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v,
                    r: 2 + Math.random()*3, color:'#ffb24d', t:now });
      }
      return;
    }
    if (f.treasure) { takeTreasure(f, now); return; }

    stats.hits++;
    if (now - comboAt > COMBO_WINDOW) comboN = 0;
    comboN++; comboAt = now;
    stats.comboMax = Math.max(stats.comboMax, comboN);

    const mult = Math.min(comboN, COMBO_MAX);
    const crit = Math.random() < CRIT_P;
    let gained = mult * (now < doubleUntil ? 2 : 1);
    if (crit) { gained += CRIT_BONUS; stats.crits++; }
    score += gained;

    sfx(crit ? 'crit' : 'slice', crit ? 0 : f.gen);
    if (comboN >= 2) sfx('combo', comboN);
    pops.push({ x: f.x, y: f.y, t: now, text: '+' + gained,
                color: crit ? '#fbbf24' : (mult > 1 ? '#67e8f9' : '#e6e8ec') });
    if (f.gen < MAX_GEN) stats.maxGen = Math.max(stats.maxGen, f.gen + 1);

    marks.push({ kind:'cut', x:f.x, y:f.y, a:cutAngle, t:now, R });

    // 果汁：切得越細噴得越少
    const juice = Math.max(4, 12 - f.gen * 3);
    for (let i = 0; i < juice; i++) {
      const a = cutAngle + (Math.random() - 0.5) * 1.4 + (Math.random() < 0.5 ? 0 : Math.PI);
      const v = px(0.1) + Math.random() * px(0.42);
      bits.push({ x:f.x, y:f.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v,
                  r: 2 + Math.random()*3.5, color:f.color, t:now });
    }

    if (f.gen >= MAX_GEN) return;   // 再切下去已經看不出形狀

    const nx = -Math.sin(cutAngle), ny = Math.cos(cutAngle);
    const sep = (px(0.22) + Math.random() * px(0.1)) * Math.pow(0.8, f.gen);
    for (const side of [1, -1]) {
      fruits.push({
        ch: f.ch, color: f.color, bomb: false, dead: false,
        gen: f.gen + 1,
        R: f.R * GEN_SHRINK,
        // 切面角度存成「相對於果肉本體」，果肉翻滾時切面才會跟著轉
        cuts: f.cuts.concat([{ a: cutAngle - f.rot, side }]),
        x: f.x + nx * side * R * 0.12,
        y: f.y + ny * side * R * 0.12,
        vx: f.vx + nx * side * sep,
        vy: Math.min(f.vy, -px(0.18)) + ny * side * sep,
        rot: f.rot, spin: f.spin + side * (1.5 + Math.random() * 2),
        // 剛生出來的碎塊先無敵一下，否則同一刀的同一條線段會立刻把它再切一次
        born: now,
      });
    }
  }

  // 手刀是一條邊在空間裡掃過去。用三條線段近似那塊掃掠面積：
  // 這一幀的刀身、刀尖的移動軌跡、刀柄的移動軌跡。
  function testSlices() {
    for (const side of SIDES) {
      const tr = trails[side];
      if (!tr.length) continue;
      stats.slashTests++;
      const st = strokeFor(side);
      if (st && !st.slashing) { stats.notSlashing++; continue; }
      const pad = tr[tr.length - 1].pad || 0;
      const segs = [];

      if (st && st.straight) {
        // 拉直模式：命中判定也用那一條擬合線。
        // 這同時修掉折線的一個副作用 —— 鋸齒狀的小段會從水果旁邊「繞過去」，
        // 明明揮過了卻沒切到。一條直線不會有這個問題。
        segs.push([st.fit.x1, st.fit.y1, st.fit.x2, st.fit.y2]);
      } else if (st) {
        for (let i = 1; i < st.run.length; i++) {
          segs.push([st.run[i-1].x, st.run[i-1].y, st.run[i].x, st.run[i].y]);
        }
      }
      // 刀身（手腕→刀刃）同樣只在揮的時候算
      const bs = bases[side];
      if (bs.length && st && st.slashing) {
        const t = tr[tr.length-1], b = bs[bs.length-1];
        if (Math.hypot(t.x - b.x, t.y - b.y) > 1) segs.push([b.x, b.y, t.x, t.y]);
      }

      const now = performance.now();
      for (const f of fruits) {
        if (f.dead) continue;
        // 剛被切出來的碎塊先無敵一下。不然同一刀的同一條線段下一幀還在，
        // 會把它一路切到最細，玩家只感覺到「碰一下就碎光了」。
        if (f.born && now - f.born < PIECE_IMMUNE_MS) continue;
        // 已經切到最細就切不動了。讓它繼續飛，不要一碰就蒸發。
        if (f.gen >= MAX_GEN) continue;
        for (const g of segs) {
          if (segDist(f.x, f.y, g[0], g[1], g[2], g[3]) < f.R + pad) {
            hitFruit(f, Math.atan2(g[3] - g[1], g[2] - g[0]));
            break;
          }
        }
      }
    }
  }

  // ---- 兩個獨立迴圈 --------------------------------------------------------
  //
  // 重點：rAF 的回呼必須是同步的。
  // 原本 `await estimatePoses` 就寫在 rAF 回呼裡，瀏覽器要等整個 async
  // 函式走完才能畫下一幀 —— 於是遊戲幀率被綁死在推論速度上，推論 30ms
  // 就只能 33fps。把 await 移出 rAF 之後，GPU 在算的時候瀏覽器照樣能畫，
  // 推論掉到 20fps 畫面仍然是 60fps。

  // 把一次推論結果吃進軌跡裡
  function showStartBtn() {
    hoverBtns = [{ x: cv.width / 2, y: cv.height * 0.58,
                   r: Math.min(78, cv.width * 0.12),
                   label: '開始', dwell: 0, action: beginPlay }];
  }

  function ingestPose(pose, now) {
    lastPose = pose;
    const kp = {};
    if (pose) for (const k of pose.keypoints) if (k.name) kp[k.name] = k;
    rawKp = Object.assign({}, kp);   // 管線動它之前先留一份

    // 先把關節點穩住，再去算刀刃 —— 肩、肘、腕三個點一起修，
    // 不然掌刀是從抓錯的手肘算出來的，怎麼平滑都沒用。
    stabilize(kp, now);
    feedCalib(kp);
    noBlade.left = ''; noBlade.right = '';

    // 先決定哪幾隻手臂可用，再去算刀刃。
    // 兩邊的點重疊時，弱的那一邊直接從 kp 裡拿掉 ——
    // 不能只是「不給它刀」，要讓它完全沒機會沾到另一邊的點。
    // 先更新軌跡信用，再決定重疊時留誰
    updateTracks(kp, now);

    if (!armsDistinct(kp)) {
      const weak = weakerArm(kp, track);
      for (const part of ARM) delete kp[weak + '_' + part];
      chainHist[weak] = null;
      // 只扣分，不打到下界。打到下界等於「這一幀判錯就鎖死好幾秒」，
      // 而重疊本來就常常是一兩幀的事。扣的量跟「三點湊不齊」同一個標準。
      track[weak] = Math.max(SPRT_B, track[weak] - 2);
      confirmed[weak] = false;
      noBlade[weak] = '兩隻手的關節疊在一起 —— 手分開一點';
      stats.lrRejects++;
    }

    const blades = { left: bladeFor('left', kp, now), right: bladeFor('right', kp, now) };

    // 「這是不是兩隻不同的手」只由 armsDistinct 判，而且只判一次。
    //
    // 這裡本來還有第二道：兩把掌刀靠得比 1.1 個前臂近就刪掉一把
    // （posenet_fruit_ninja 的 leftRightMiniDistance）。拿掉的理由：
    //
    // 1) 它判的是**算出來的掌刀點**，而 armsDistinct 判的是**原始關節點**。
    //    同一件事兩個地方判、兩套門檻、兩份資料 —— 兩邊一定會漂走。
    //    原始關節點已經確定是兩條不共用點的鏈了，那兩把刀靠在一起
    //    就只是「兩隻手靠在一起」，那是合法動作。
    // 2) 雙手往中間揮是切水果最基本的動作，兩掌刀本來就會交會，
    //    雙手合十更是 0px。實機一局量到這道觸發 2164 次，
    //    每次都讓那隻手 prev 歸 null、整段筆畫作廢。
    // 3) 它要防的「左右互換造成一條橫跨畫面的假刀痕」，
    //    現在由 fixSides（運動連續性）＋ armsDistinct（兩條鏈不共用點）
    //    ＋ SPRT 軌跡確認三道一起擋，而且都在原始座標上做。
    //
    // posenet_fruit_ninja 需要這道，是因為它只追手腕、沒有骨鏈驗證。

    let any = false;
    for (const side of SIDES) {
      const b = blades[side];
      const p = prev[side];
      if (b) {
        any = true;
        stats.bladeLen = Math.max(stats.bladeLen, Math.hypot(b.tx - b.bx, b.ty - b.by));
        let linked = false, fast = false, moving = false;
        if (p) {
          const L = linkInfo(p, b, now);
          fast = L.fast; moving = L.moving; linked = L.linked;
          stats.maxSpeed = Math.max(stats.maxSpeed, L.speed);
          stats.maxGap = Math.max(stats.maxGap, L.dist);
          if (fast) stats.fastSamples++;
          // 分別記下是哪一道關卡擋掉的，才不用再猜
          stats.linkTries++;
          if (!L.inTime) stats.rejTime++;
          if (!L.inRange) stats.rejRange++;
          if (linked) stats.linkOk++;
          stats.gapSum += L.dist; stats.gapN++;
        }
        trails[side].push({ x:b.tx, y:b.ty, t:now, linked, moving,
                            pad: b.pad || 0, v3: b.v3 || null });
        bases[side].push({ x:b.bx, y:b.by, t:now, linked, moving });
        prev[side] = { tx:b.tx, ty:b.ty, t:now, fast };
      } else {
        // 這一幀沒抓到刀，但**不要把 prev 清掉**。
        //
        // 清掉的話下一個點的 linked 必然是 false，activeRun 就從那裡切開、
        // 整段筆畫重新開始 —— 而 MAX_LINK_MS（260ms）與 maxLink（224px）
        // 這兩個「容忍掉點」的常數就形同虛設，它們存在的理由正是這個。
        //
        // 實機刀刃抓到率約 78%，每五幀掉一幀 → 平均每段只剩 4–5 點
        // （約 150ms），遠短於 280ms 的視窗，fit.len 被腰斬、揮了也不算一刀。
        // 畫圓時手臂朝向變化大、掉點更密集，所以那個姿勢最明顯
        // （使用者回報「手畫圓型時會漏揮動」）。
        //
        // 真的斷太久或跳太遠，inTime / inRange 會各自擋下來。
        if (p && p.fast) stats.fastDropouts++;
      }
    }
    pipeKp = kp;                     // 管線實際用的那一份
    if (any) { stats.detFrames++; lastBladeAt = now; }
    if (!any) logNoBlade(now);
  }

  // 兩隻手都沒有刀的時候，每秒把完整狀態印一次。
  //
  // 為什麼是 console 不是畫布：畫布有下緣、有寬度，排版錯了就把最關鍵的
  // 那一行切掉（已經發生過一次），而且使用者沒辦法把數字複製給我。
  // console 沒有版面問題，一行就是一行。
  let lastDiagAt = 0;
  function logNoBlade(now) {
    if (now - lastDiagAt < 1000) return;
    lastDiagAt = now;
    const raw = rawKp;
    const num = (v, d) => (v == null ? '—' : v.toFixed(d));
    const row = (sd) => {
      const e = evLast[sd] || {}, c = chainWhy[sd] || {};
      const sc = (nm) => raw[sd + '_' + nm] ? raw[sd + '_' + nm].score.toFixed(2) : '—';
      return sd.padEnd(5)
        + ' \u039b=' + num(track[sd], 2) + (confirmed[sd] ? '✓' : ' ')
        + ' 鏈=' + (e.chain === undefined ? '—' : e.chain)
        + ' 續=' + (e.cont === undefined ? '—' : e.cont) + '(' + num(e.contVal, 2) + ')'
        + ' 強=' + (e.strong === undefined ? '—' : e.strong)

        + ' | 上臂=' + num(c.upper, 0) + ' 前臂=' + num(c.fore, 0)
        + ' 肩寬=' + num(c.shoulderW, 0)
        + ' 上/肩=' + num(c.rU, 2) + '(>1.5擋)'
        + ' 前/校=' + num(c.rF, 2) + '(>2.2擋)'
        + ' | 肩' + sc('shoulder') + ' 肘' + sc('elbow') + ' 腕' + sc('wrist')
        + ' | ' + (noBlade[sd] || '—');
    };
    console.log('[無刀] 門檻=' + MIN_SCORE.toFixed(2)
      + ' 肘門檻=' + scoreNeed('elbow').toFixed(2)
      + ' 校正前臂=' + (calib ? calib.forearm.toFixed(0) : '—')
      + ' 畫布=' + cv.width + 'x' + cv.height
      + ' 影像=' + video.videoWidth + 'x' + video.videoHeight
      + '\n  ' + row('left') + '\n  ' + row('right'));
  }

  // 推論迴圈：唯一會 await 的地方，不在 rAF 裡
  // MoveNet 內部會把輸入縮到 192×192，但 640×480 的材質上傳成本還在。
  // 先縮小再送進去「可能」比較快 —— 但 drawImage 本身也要錢，
  // 所以做成開關去量，不要憑感覺決定。
  function inferInput() {
    if (!ui.small.checked) return { src: video, scale: 1 };
    const W = 256;
    const H = Math.round(W * video.videoHeight / video.videoWidth) || 192;
    if (!small) { small = document.createElement('canvas'); }
    if (small.width !== W || small.height !== H) { small.width = W; small.height = H; }
    small.getContext('2d').drawImage(video, 0, 0, W, H);
    return { src: small, scale: video.videoWidth / W };
  }

  async function inferLoop(token) {
    if (!running || token !== loopToken) return;
    let didWork = false;
    // rVFC 若超過半秒沒動靜就不要再信它，退回輪詢。
    // 推論整個停擺是最糟的失敗模式 —— 畫面還在動，數字還在更新，
    // 但全部是舊的，從外面完全看不出來。寧可多一道保險。
    const rvfcOK = hasRVFC && rvfcAt && performance.now() - rvfcAt < 500;
    const fresh = rvfcOK ? newFrame : (video.currentTime !== lastVideoTime);
    if (detector && video.readyState >= 2 && fresh) {
      newFrame = false;
      lastVideoTime = video.currentTime;
      didWork = true;
      const t0 = performance.now();
      let poses = [];
      const inp = inferInput();
      try {
        poses = await detector.estimatePoses(inp.src, { flipHorizontal: false });
        // 縮過圖的話，關節點座標是在縮圖的尺度上，要放大回原本的畫面
        if (inp.scale !== 1 && poses[0]) {
          for (const k of poses[0].keypoints) { k.x *= inp.scale; k.y *= inp.scale; }
        }
      } catch (e) { setStatus('推論失敗：' + e.message, true); }
      const now = performance.now();
      stats.infer.push(now - t0);
      if (stats.infer.length > 180) stats.infer.shift();
      stats.frames++;
      stats.inferTimes.push(now);
      while (stats.inferTimes.length && now - stats.inferTimes[0] > 1000) stats.inferTimes.shift();
      try {
        ingestPose(poses[0] || null, now);
      } catch (e) { setStatus('處理姿勢失敗：' + e.message, true); }
    }
    // 交回主執行緒讓 rAF 有機會跑。沒事做時隔久一點，不要空轉。
    setTimeout(() => inferLoop(token), didWork ? 0 : 16);
  }

  // 繪製迴圈：全同步，絕不 await
  function renderLoop(token) {
    if (!running || token !== loopToken) return;
    const now = performance.now();
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 0.016;
    lastT = now;

    // 看門狗：影格時間停止前進就代表相機其實已經斷了。
    // 這是給 Safari 用的 —— 它拔掉相機時不發 ended、readyState 還報 live。
    if (video.readyState >= 2) {
      if (video.currentTime !== lastFrameTime) {
        lastFrameTime = video.currentTime; lastFrameAt = now;
      } else if (lastFrameAt && now - lastFrameAt > 2500) {
        cameraLost('相機沒有畫面了');
        return;
      }
    }

    // 分頁切到背景時 rAF 會被節流，回來那一瞬間 dt 會暴衝、水果直接穿過畫面。
    // 乾脆暫停，回來再繼續。
    if (paused) {
      draw(now);
      requestAnimationFrame(() => renderLoop(token));
      return;
    }

    // 沒人就整個停住 —— 不生水果、不跑物理、不判命中。
    // 原本只延後生成，但已經在空中的水果照樣落下、照樣算漏接，
    // 畫面上也沒有任何表示，看起來就像遊戲自己在玩。
    // lastBladeAt 為 0 代表「從來沒看到過人」—— 那正是最該暫停的情況，
    // 不是例外。原本寫 `&& !!lastBladeAt` 把語意弄反了，結果永遠不觸發。
    lostPerson = phase === 'playing' && !demoMode
                 && (now - lastBladeAt > NO_PERSON_MS);

    for (const side of SIDES) {
      trails[side] = trails[side].filter((p) => now - p.t <= TRAIL_MS);
      bases[side]  = bases[side].filter((p) => now - p.t <= TRAIL_MS);
    }
    for (const side of SIDES) strokeCache[side] = computeStroke(side);

    if (!lostPerson) {
      if (phase === 'playing' && now >= nextSpawn) { spawn(); nextSpawn = now + spawnDelay(); }
      stepFruits(dt);
      if (!over) testSlices();
    } else {
      // 停住時只讓特效跑完，水果凍在原地等人回來
      stepEffectsOnly(dt);
    }
    stepHover(dt);
    draw(now);

    stats.fpsTimes.push(now);
    while (stats.fpsTimes.length && now - stats.fpsTimes[0] > 1000) stats.fpsTimes.shift();
    // 面板只是顯示用的，不該讓它的錯誤中斷下一幀的排程。
    try {
      updatePanel();
    } catch (e) {
      if (!panelBroken) {
        panelBroken = true;
        setStatus('量測面板出錯，遊戲繼續：' + e.message, true);
      }
    }
    requestAnimationFrame(() => renderLoop(token));
  }

  function startLoops() {
    const token = ++loopToken;   // 讓前一輪的迴圈退場
    lastT = 0;
    requestAnimationFrame(() => renderLoop(token));
    inferLoop(token);
  }

  function draw(now) {
    if (video.readyState >= 2) {
      ctx.save();
      ctx.translate(cv.width, 0); ctx.scale(-1, 1);   // 鏡像，讓人像照鏡子
      ctx.drawImage(video, 0, 0, cv.width, cv.height);
      ctx.restore();
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.fillStyle = 'rgba(8,10,14,.42)';
    ctx.fillRect(0, 0, cv.width, cv.height);

    if (ui.skel.checked && lastPose) {
      // 只畫手臂。這個遊戲只用到肩、肘、腕，
      // 臉上那些點畫出來只是雜訊，還會擋住自己的臉。
      // 畫管線實際用的那一份 —— 骨架要跟刀刃講同一個故事，
      // 不然會出現「骨架畫得好好的卻沒有刀」而看不出原因。
      const kp = pipeKp;
      // 只連「相鄰」的兩個關節，而且兩端都要過門檻。
      //
      // 原本是先用 filter 把低分的點濾掉、再把剩下的依序連起來 ——
      // 手肘沒過門檻時那會畫出一條「肩膀→手腕」的直線，
      // 看起來像三點一線成立了，實際上根本不是解剖學上的鏈。
      ctx.lineWidth = 3;
      const sw = shoulderWidth(kp);
      for (const side of SIDES) {
        const sh = kp[side + '_shoulder'], eb = kp[side + '_elbow'],
              wr = kp[side + '_wrist'];
        const ok = (k, part) => k && k.score >=
          scoreNeed(part);
        const shOK = ok(sh, 'shoulder'), ebOK = ok(eb, 'elbow'), wrOK = ok(wr, 'wrist');
        // 整條鏈成立（會用來算掌刀方向）→ 綠色；否則藍色，代表只能退化成單點
        const full = shOK && ebOK && wrOK && chainOK(sh, eb, wr, sw);
        const col = full ? '76,222,128' : '96,165,250';
        ctx.strokeStyle = 'rgba(' + col + ',.65)';
        ctx.fillStyle = 'rgba(' + col + ',.9)';
        const link = (a, b, aOK, bOK) => {
          if (!aOK || !bOK) return;
          ctx.beginPath();
          ctx.moveTo(cv.width - a.x, a.y); ctx.lineTo(cv.width - b.x, b.y); ctx.stroke();
        };
        link(sh, eb, shOK, ebOK);
        link(eb, wr, ebOK, wrOK);
        for (const [k, good] of [[sh, shOK], [eb, ebOK], [wr, wrOK]]) {
          if (!good) continue;
          ctx.beginPath(); ctx.arc(cv.width - k.x, k.y, 4, 0, 6.3); ctx.fill();
        }
      }
    }

    ctx.font = (px(F.fruitR) * 1.8) + 'px serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 每一塊都是「同一個 emoji，被它自己那串切面裁過」。
    // 連續 clip() 會取交集，所以切兩刀自然得到四分之一、三刀得到八分之一。
    // 裁切框跟著果肉一起翻滾，切面方向看起來就固定在果肉上。
    for (const f of fruits) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      if (f.cuts.length) {
        const B = px(F.fruitR) * 3;   // 夠大就好，蓋得住整顆
        for (const c of f.cuts) {
          ctx.rotate(c.a);
          ctx.beginPath();
          ctx.rect(-B, c.side > 0 ? 0 : -B, B * 2, B);
          ctx.clip();
          ctx.rotate(-c.a);
        }
      }
      ctx.fillText(f.ch, 0, 0);
      ctx.restore();

      // 炸彈把判定邊界畫出來。
      //
      // 這是唯一會扣命的東西，所以「碰到哪裡會爆」不能靠猜。
      // emoji 的輪廓是不規則的（💣 各方位 23.5–36.5px），
      // 玩家沒辦法從圖案推出判定圓在哪 —— 畫出來就沒有爭議了。
      // 半徑用 f.R + pad，跟 testSlices 用的同一個值（見 F.bombR 的註解）。
      if (f.bomb) {
        const pulse = 0.55 + 0.25 * Math.sin(now / 150);
        ctx.strokeStyle = 'rgba(248,113,113,' + pulse.toFixed(2) + ')';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.R + px(PALM_PAD), 0, 6.3);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 果汁
    for (const b of bits) {
      const age = (now - b.t) / 900;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.3); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 切中時浮出來的分數
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of pops) {
      const age = (now - p.t) / 700;
      ctx.globalAlpha = Math.max(0, 1 - age * age);
      ctx.fillStyle = p.color;
      ctx.font = '700 ' + (22 + 8 * (1 - age)) + 'px -apple-system,sans-serif';
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // 切痕閃光與炸彈環
    for (const m of marks) {
      if (m.kind === 'cut') {
        const age = (now - m.t) / 200;
        ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.a);
        ctx.globalAlpha = Math.max(0, 1 - age);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * (1 - age) + 1;
        ctx.beginPath();
        ctx.moveTo(-m.R * 1.5, 0); ctx.lineTo(m.R * 1.5, 0); ctx.stroke();
        ctx.restore();
      } else {
        const age = (now - m.t) / 420;
        ctx.globalAlpha = Math.max(0, 1 - age);
        ctx.strokeStyle = '#ffb24d'; ctx.lineWidth = 6 * (1 - age) + 1;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.R * (0.5 + age * 2.4), 0, 6.3); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round';
    for (const side of SIDES) {
      const tr = trails[side], bs = bases[side];
      const st = strokeFor(side);
      // 只有真的算一刀的時候才畫刀痕。
      // 畫了卻切不到會讓人以為是判定失靈，而不是自己揮得不夠。
      if (st && st.slashing) {
        if (st.straight) {
          // 一條直線，粗細從頭到尾漸變，看起來像一刀劃過
          const grad = ctx.createLinearGradient(st.fit.x1, st.fit.y1, st.fit.x2, st.fit.y2);
          grad.addColorStop(0, 'rgba(255,255,255,0.05)');
          grad.addColorStop(0.65, 'rgba(255,255,255,0.85)');
          grad.addColorStop(1, 'rgba(255,255,255,0.98)');
          ctx.strokeStyle = grad; ctx.lineWidth = 9;
          ctx.beginPath();
          ctx.moveTo(st.fit.x1, st.fit.y1); ctx.lineTo(st.fit.x2, st.fit.y2); ctx.stroke();
        } else {
          // 擬合殘差太大 → 這是一道弧，照原樣畫不要硬拉直
          for (let i = 1; i < st.run.length; i++) {
            const age = (now - st.run[i].t) / TRAIL_MS;
            ctx.strokeStyle = 'rgba(255,255,255,' + (0.9 * (1 - age)).toFixed(3) + ')';
            ctx.lineWidth = 9 * (1 - age) + 2;
            ctx.beginPath();
            ctx.moveTo(st.run[i-1].x, st.run[i-1].y);
            ctx.lineTo(st.run[i].x, st.run[i].y); ctx.stroke();
          }
        }
      }
      // 刀身：這一幀的手腕→刀刃，畫出來才看得出掌刀的位置
      if (tr.length && bs.length) {
        const t = tr[tr.length-1], b = bs[bs.length-1];
        if (Math.hypot(t.x - b.x, t.y - b.y) > 1) {
          ctx.strokeStyle = 'rgba(96,165,250,.9)'; ctx.lineWidth = 5;
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(96,165,250,.95)';
        ctx.beginPath(); ctx.arc(t.x, t.y, 6, 0, 6.3); ctx.fill();
      }
    }
    drawHud(now);

    if (lostPerson) {
      ctx.fillStyle = 'rgba(8,10,14,.6)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '700 26px -apple-system,"PingFang TC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('看不到你，先暫停', cv.width / 2, cv.height * 0.42);
      ctx.font = '400 15px -apple-system,"PingFang TC",sans-serif';
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText('回到畫面裡就會繼續，水果和分數都留著',
                   cv.width / 2, cv.height * 0.42 + 30);
      drawWhyNoArm(cv.height * 0.42 + 64);
    } else if (paused) {
      ctx.fillStyle = 'rgba(8,10,14,.72)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#e6e8ec';
      ctx.font = '600 22px -apple-system,"PingFang TC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暫停中，切回這個分頁就繼續', cv.width / 2, cv.height / 2);
    } else if (phase === 'over') drawGameOver();
    else if (phase === 'ready') drawReady();
    drawHoverBtns();
    // 手的位置永遠畫在最上層。選單狀態下要指引，遊戲中抓不到手時
    // 也要讓人知道「系統現在看不到你」而不是默默沒反應。
    if (ui.raw.checked) drawRawPose();
    if (hoverBtns.length) drawHandCursor();
    else if (phase === 'playing' && !hoverPoints().length) drawWhyNoArm(cv.height * 0.93);
  }

  // ---- 面板 ----------------------------------------------------------------
  const pct = (n, d) => d ? ((n/d)*100).toFixed(1) + '%' : '—';
  function q(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a,b) => a-b);
    return s[Math.min(s.length-1, Math.floor(p * s.length))];
  }
  function tint(node, v, goodBelow, badAbove) {
    node.classList.remove('good','warn','bad');
    if (v == null) return;
    node.classList.add(v <= goodBelow ? 'good' : v >= badAbove ? 'bad' : 'warn');
  }

  function updatePanel() {
    const fps = stats.fpsTimes.length;
    ui.fps.textContent = fps + ' /秒';
    tint(ui.fps, -fps, -30, -20);
    // 這兩個數字現在是獨立的。解耦生效的話，推論掉下去畫面仍該維持住。
    const ifps = stats.inferTimes.length;
    ui.ifps.textContent = ifps + ' /秒';
    tint(ui.ifps, -ifps, -20, -10);
    ui.camDrop.textContent = hasRVFC ? String(droppedFrames) : '（不支援偵測）';
    ui.warm.textContent = warmupMs ? warmupMs + ' ms' : '—';

    const p50 = q(stats.infer, .5), p95 = q(stats.infer, .95);
    ui.p50.textContent = p50 == null ? '—' : p50.toFixed(1) + ' ms';
    ui.p95.textContent = p95 == null ? '—' : p95.toFixed(1) + ' ms';
    tint(ui.p50, p50, 15, 33); tint(ui.p95, p95, 25, 50);

    ui.det.textContent = pct(stats.detFrames, stats.frames);
    const den = stats.fastSamples + stats.fastDropouts;
    ui.drop.textContent = pct(stats.fastDropouts, den);
    tint(ui.drop, den ? stats.fastDropouts/den : null, .05, .2);

    ui.blade.textContent = stats.bladeLen ? Math.round(stats.bladeLen) + ' px' : '—';
    ui.forearm.textContent = calib
      ? Math.round(calib.forearm) + ' px（'
        + (calibLockedNow() ? '已鎖定' : Math.round(calib.w * 100) + '%') + '）' : '—';
    ui.noise.textContent = calib ? calib.noise.toFixed(1) + ' px/幀' : '—';
    ui.ms.textContent = MIN_SCORE.toFixed(2)
      + (autoScore() ? '（自動）' : '（固定）');
    ui.cusum.textContent = trk.forearm.settled
      ? Math.round(trk.forearm.evidence * 100) + '%' : '—';
    ui.speed.textContent = stats.maxSpeed ? Math.round(stats.maxSpeed) + ' px/秒' : '—';
    ui.gap.textContent   = stats.maxGap ? Math.round(stats.maxGap) + ' px' : '—';
    ui.hit.textContent = stats.hits; ui.miss.textContent = stats.misses;
    ui.bomb.textContent = stats.bombs;
    ui.tre.textContent = stats.treasures;
    ui.combo.textContent = stats.comboMax;
    ui.crit.textContent = stats.crits;
    ui.jump.textContent = stats.jumpGate;
    ui.bone.textContent = stats.boneGate;
    ui.side.textContent = stats.sideFix;
    ui.arm.textContent  = stats.armHidden;
    ui.chain.textContent = stats.chainBroken;
    ui.track.textContent =
      track.left.toFixed(1) + (confirmed.left ? '✓' : '') + ' / ' +
      track.right.toFixed(1) + (confirmed.right ? '✓' : '') +
      '（' + SPRT_B.toFixed(1) + ' … ' + SPRT_A.toFixed(1) + '）';
    ui.state.textContent = lostPerson ? '沒看到人（暫停）'
      : paused ? '分頁在背景' : demoMode ? phase + '（示範）' : phase;
    // 兩隻手各自的鏈現在成不成立，一眼看出是哪一邊有問題
    if (lastPose) {
      const kp = pipeKp;
      const sw = shoulderWidth(kp);
      const mark = (side) => {
        const sh = kp[side + '_shoulder'], eb = kp[side + '_elbow'],
              wr = kp[side + '_wrist'];
        if (!wr || below(wr.score, MIN_SCORE)) return '無手腕';
        if (!sh || !eb || below(sh.score, MIN_SCORE)
            || below(eb.score, scoreNeed('elbow'))) return '只有腕';
        return chainOK(sh, eb, wr, sw) ? '成立' : '不合理';
      };
      ui.chain2.textContent = mark('left') + ' / ' + mark('right');
    }
    ui.lr.textContent = stats.lrRejects;

    const T = stats.linkTries;
    ui.link.textContent     = pct(stats.linkOk, T);
    tint(ui.link, T ? -(stats.linkOk / T) : null, -0.5, -0.15);
    ui.rejMove.textContent  = pct(stats.notSlashing, stats.slashTests);
    ui.gen.textContent = GEN_LABEL[stats.maxGen] || '—';
    ui.stroke.textContent   = stats.strokeMax
      ? Math.round(stats.strokeMax) + ' px（門檻 ' + Math.round(slashMinPx()) + '）' : '—';
    ui.rejTime.textContent  = pct(stats.rejTime, T);
    ui.rejRange.textContent = pct(stats.rejRange, T);
    ui.gapAvg.textContent   = stats.gapN
      ? (stats.gapSum / stats.gapN).toFixed(1) + ' px' : '—';
    const lin = stats.linN ? stats.linSum / stats.linN : null;
    ui.lin.textContent = lin == null ? '—' : lin.toFixed(3);
    tint(ui.lin, lin == null ? null : -lin, -MIN_LINEARITY, -0.94);
    // 還沒初始化任何 backend 時 tf.memory() 會丟錯
    // （載了 webgpu 之後它是最高優先的 backend，但尚未 init）
    ui.src.textContent = modelSource;
    ui.tensors.textContent = backendReady ? tf.memory().numTensors : '—';
  }

  // ---- 控制 ----------------------------------------------------------------
  // 一次把水果清乾淨，連引信一起停。原本停引信的迴圈寫在 fruits = []
  // 之後，永遠跑 0 圈 —— 炸彈從畫面消失，嘶嘶聲繼續響到 buffer 播完。
  function clearFruits() {
    for (const f of fruits) if (f.stopFuse) f.stopFuse();
    fruits = [];
  }

  // 只負責歸零量測與遊戲狀態，不碰 phase、不碰 hoverBtns。
  // 原本它把 phase 推到 'ready' 卻沒重建「開始」圓圈，而唯一的
  // 「開啟相機」按鈕在 .hint 裡、phase !== 'idle' 時整個隱藏 ——
  // 五個入口（歸零重測／四個 select）全都會卡進「有畫面、沒有任何可按的東西」。
  function clearRuntime() {
    stats = freshStats(); clearFruits(); bits = []; marks = []; pops = []; score = 0;
    lives = LIVES; over = false; ui.again.hidden = true; hoverBtns = [];
    freezeUntil = 0; doubleUntil = 0; comboN = 0;
    lastBladeAt = 0; lostPerson = false; demoMode = false;
    track.left = 0; track.right = 0;
    confirmed.left = false; confirmed.right = false;
    chainHist.left = null; chainHist.right = null;
    strokeCache.left = null; strokeCache.right = null;
    for (const s of SIDES) { trails[s] = []; bases[s] = []; prev[s] = null; }
  }

  ui.start.addEventListener('click', async () => {
    ui.start.disabled = true;
    ui.start.textContent = '開啟相機';
    lastFrameAt = 0; lastFrameTime = -1;
    initAudio();   // 一定要在這個 click 處理器裡建立，不然 Safari 會無聲
    setStatus('正在開相機…');
    try {
      // 相機一好就讓畫面動起來，不要壓在模型載入後面。
      // 模型冷啟要幾秒，這段時間使用者只看得到提示框，會以為當掉了。
      await startCamera();
      clearRuntime(); running = true; lastVideoTime = -1;
      phase = 'ready'; syncHint();   // 相機一好就把提示框收起來，先讓人看到自己
      nextSpawn = Infinity;   // 模型還沒好就先不要丟水果，不然會白白算成漏接
      startLoops();
      setStatus('相機好了，正在載入模型…');

      await buildDetector();
      ui.reset.disabled = false;
      enterReady();
    } catch (e) {
      // 一定要回到 idle。
      //
      // 上面已經做過 phase = 'ready'; syncHint()，而 syncHint 在
      // phase !== 'idle' 時會把提示框整個收起來 —— 唯一的「開啟相機」按鈕
      // 就在那裡面。只把它 disabled = false 沒有用，它是 0×0 的。
      // 而建立懸停圓圈的 enterReady() 在失敗路徑上永遠跑不到，
      // 所以畫面上會變成「有影像、有文字、沒有任何能按的東西」。
      // cameraLost() 早就做對了，這裡照抄同一套。
      cameraLost(e.message || String(e));
      ui.start.textContent = '再試一次';
    }
  });

  // 不需要相機就能看到切半特效，也讓這條繪製路徑在交付前真的被跑過一次
  ui.demo.addEventListener('click', () => {
    initAudio();   // 這也是真實點擊，可以解鎖音訊
    const now = performance.now();
    // 畫面上還有可切的碎塊就再切一刀，沒有才生一顆新的。
    // 這樣連按就會看到 整顆 → 兩半 → 四分之一 → 八分之一。
    const live = fruits.filter((f) => !f.dead && !f.bomb && f.gen < MAX_GEN
                                   && (!f.born || now - f.born >= PIECE_IMMUNE_MS)
                                   && f.y > 0 && f.y < cv.height);
    if (live.length) {
      const a = Math.random() * Math.PI;
      for (const f of live) hitFruit(f, a);
      setStatus('再切一刀：現在最細是 '
        + ['—','1/2','1/4','1/8'][Math.min(3, stats.maxGen)] + '。');
    } else {
      const kind = FRUIT[Math.floor(Math.random() * FRUIT.length)];
      const f = {
        x: cv.width / 2, y: cv.height / 2, vx: 0, vy: -px(0.1),
        ch: kind.ch, color: kind.color,
        bomb: false, dead: false, rot: 0.3, spin: 1.2,
        cuts: [], gen: 0, R: px(F.fruitR),
      };
      fruits.push(f);
      hitFruit(f, 0.5);
      setStatus('切成兩半了。再按一次會把兩半各自再切開。');
    }
    // 示範不要借用 phase。原本從 idle 直接推成 'playing'，
    // syncHint() 會因此把提示框藏起來 —— 唯一的「開啟相機」按鈕就在裡面，
    // 按一次示範就永久失去開相機的能力。
    demoMode = true;
    if (!running) { running = true; startLoops(); }
  });

  // 量化到底傷了多少，只有用真人影像量才算數。
  // 合成的假人連基準模型自己都認不出來，拿那種輸入比等於在比雜訊。
  ui.cmp.addEventListener('click', async () => {
    if (!video.videoWidth) { setStatus('要先按「開始」把相機打開。', true); return; }
    ui.cmp.disabled = true;
    const ARM = ['left_shoulder','right_shoulder','left_elbow','right_elbow',
                 'left_wrist','right_wrist'];
    let a = null, b = null;
    try {
      setStatus('載入兩個模型…');
      const mk = (url) => poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          modelUrl: url, enableSmoothing: false, minPoseScore: 0.2 });
      a = await mk('models/movenet-lightning/model.json');
      b = await mk('models/movenet-lightning-uint8/model.json');

      const dArm = [], dAll = [], sA = [], sB = [];
      let frames = 0, missA = 0, missB = 0;
      const until = performance.now() + 5000;
      setStatus('揮動手臂五秒，正在比對…');
      while (performance.now() < until) {
        const pa = (await a.estimatePoses(video, { flipHorizontal:false }))[0];
        const pb = (await b.estimatePoses(video, { flipHorizontal:false }))[0];
        frames++;
        if (!pa) { missA++; }
        if (!pb) { missB++; }
        if (!pa || !pb) continue;
        for (let i = 0; i < pa.keypoints.length; i++) {
          const ka = pa.keypoints[i], kb = pb.keypoints[i];
          const d = Math.hypot(ka.x - kb.x, ka.y - kb.y);
          dAll.push(d);
          if (ARM.includes(ka.name)) { dArm.push(d); sA.push(ka.score); sB.push(kb.score); }
        }
      }
      const srt = (v) => [...v].sort((x,y)=>x-y);
      const q = (v,p) => v.length ? srt(v)[Math.floor(v.length*p)] : NaN;
      const avg = (v) => v.length ? v.reduce((s,n)=>s+n,0)/v.length : NaN;

      if (!dArm.length) {
        showResult([['有效幀', '0']],
          '五秒內都沒同時抓到兩邊的手臂。站進畫面、讓手肘也入鏡，再按一次。');
        setStatus('沒量到東西，再試一次。', true);
        return;
      }

      const medArm = q(dArm, 0.5), p95Arm = q(dArm, 0.95);
      const cA = avg(sA), cB = avg(sB);
      const lostA = missA / frames, lostB = missB / frames;

      // 判讀基準：掌刀是從手腕和手肘算出來的，誤差會被放大 1.4 倍，
      // 而命中半徑約 41.6px。所以關節點差 5px → 刀刃差 7px，
      // 只佔命中半徑的 17%，切不切得到不會變；差 15px 就開始有感。
      let verdict, tone;
      if (lostB > lostA + 0.15) {
        verdict = 'uint8 掉追蹤的機率明顯比較高（' + (lostA*100).toFixed(0) + '% → '
          + (lostB*100).toFixed(0) + '%）。這比位置誤差更傷，建議留在 fp16。';
        tone = 'bad';
      } else if (medArm < 5) {
        verdict = '手臂關節點中位只差 ' + medArm.toFixed(1)
          + 'px，換算到刀刃約 ' + (medArm*1.4).toFixed(1)
          + 'px，不到命中半徑的兩成 —— 玩起來不會有差別。可以用 uint8。';
        tone = 'good';
      } else if (medArm < 15) {
        verdict = '中位差 ' + medArm.toFixed(1) + 'px、p95 差 ' + p95Arm.toFixed(1)
          + 'px。多半感覺不出來，但快揮時的刀痕會比較不穩。想省體積就用，'
          + '想要最穩就留 fp16。';
        tone = 'warn';
      } else {
        verdict = '中位就差 ' + medArm.toFixed(1) + 'px，換算到刀刃約 '
          + (medArm*1.4).toFixed(1) + 'px，接近命中半徑的一半 —— '
          + '會切不準。建議留在 fp16。';
        tone = 'bad';
      }

      showResult([
        ['比對幀數',          String(frames)],
        ['手臂關節點差 中位', medArm.toFixed(1) + ' px'],
        ['手臂關節點差 p95',  p95Arm.toFixed(1) + ' px'],
        ['全部關節點差 中位', q(dAll,0.5).toFixed(1) + ' px'],
        ['手臂信心 fp16',     cA.toFixed(3)],
        ['手臂信心 uint8',    cB.toFixed(3)],
        ['抓不到的幀 fp16',   (lostA*100).toFixed(0) + '%'],
        ['抓不到的幀 uint8',  (lostB*100).toFixed(0) + '%'],
      ], verdict, tone);
      setStatus('比對完成，結果在下面。');
    } catch (e) {
      setStatus('比對失敗：' + e.message, true);
    } finally {
      if (a && a.dispose) a.dispose();
      if (b && b.dispose) b.dispose();
      ui.cmp.disabled = false;
    }
  });

  // 看得到自己、但遊戲還沒開始。站好位置，再把手停到圓圈上。
  // 提示框只在還沒開相機時出現。散在各條路徑裡手動開關，
  // 遲早會有一條忘記關 —— 示範按鈕那條就忘了，結果提示蓋在結束畫面上。
  // 提示框（連同「開啟相機」按鈕）只要相機還沒跑起來就該在。
  // 不能只看 phase —— 示範模式與相機斷線都會讓 phase 不是 idle，
  // 但那兩種情形使用者正需要那顆按鈕。
  function syncHint() {
    ui.hint.hidden = !!(video.srcObject && phase !== 'idle');
  }

  // 歸零之後要把該有的互動補回去 —— 這是 clearRuntime 不碰 phase 的配套
  function reenter() {
    clearRuntime();
    if (phase === 'over') showGameOver();
    else if (phase !== 'idle') enterReady();
    syncHint();
  }

  function enterReady() {
    phase = 'ready';
    readyAt = performance.now();
    over = false;
    lives = LIVES;
    syncHint();
    fruits = []; bits = []; marks = []; pops = [];
    nextSpawn = Infinity;
    ui.again.hidden = true;
    showStartBtn();   // 不用等校正，校正是背景持續在跑的
    setStatus('把手停在圓圈上就開始。站位會自己量，不用配合做什麼。');
  }

  function drawReady() {
    ctx.fillStyle = 'rgba(8,10,14,.5)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e6e8ec';
    ctx.font = '600 22px -apple-system,"PingFang TC",sans-serif';

    // 模型還沒載好就沒有圓圈（enterReady 才建立它）。
    // 相機一好就先 phase='ready' 是刻意的 —— 要讓人馬上看到自己 ——
    // 但畫面不能在這段時間叫他去停一個不存在的圓圈。
    // 本機模型約 45ms，CDN 要 5–7 秒，後者使用者一定會遇到。
    if (!detector) {
      ctx.fillText('正在準備，稍等一下', cv.width / 2, cv.height * 0.30);
      ctx.font = '400 15px -apple-system,"PingFang TC",sans-serif';
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText('第一次開比較久，之後就快了', cv.width / 2, cv.height * 0.30 + 30);
      return;
    }

    ctx.fillText('把手停在圓圈上', cv.width / 2, cv.height * 0.30);

    ctx.font = '400 15px -apple-system,"PingFang TC",sans-serif';
    ctx.fillStyle = '#9aa3b2';
    if (!calib) {
      ctx.fillText('確認肩膀、手肘、手腕都在畫面裡', cv.width / 2, cv.height * 0.30 + 30);
      return;
    }
    ctx.fillText('前臂 ' + Math.round(calib.forearm) + 'px　揮擊門檻 '
      + Math.round(calib.slashMin) + 'px', cv.width / 2, cv.height * 0.30 + 30);
    // 校正收斂進度。不擋人開始，只是讓他知道數字還在調
    const bw = cv.width * 0.28, bx = (cv.width - bw) / 2, by = cv.height * 0.30 + 50;
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = calibLockedNow() ? '#4ade80' : '#60a5fa';
    ctx.fillRect(bx, by, bw * (calibLockedNow() ? 1 : calib.w), 4);
    ctx.font = '400 12px -apple-system,"PingFang TC",sans-serif';
    ctx.fillStyle = calibLockedNow() ? '#4ade80' : '#9aa3b2';
    ctx.fillText(calibLockedNow() ? '已依你的身形校正' : '校正中…', cv.width / 2, by + 20);
  }

  function beginPlay() {
    phase = 'playing';
    over = false;
    lives = LIVES;
    score = 0;
    freezeUntil = 0; doubleUntil = 0; comboN = 0;
    hurtAt = 0; hurtWhy = ''; overWhy = '';
    syncHint();
    fruits = []; bits = []; marks = []; pops = [];
    hoverBtns = [];
    ui.again.hidden = true;
    nextSpawn = performance.now() + 600;   // 給一點反應時間再丟第一顆
    lastBladeAt = performance.now();       // 剛開始先當作有人，不要立刻判定離開
    lostPerson = false; demoMode = false;
    setStatus('揮動手臂切水果，避開炸彈。');
  }

  function showGameOver() {
    phase = 'over';
    syncHint();
    ui.again.hidden = false;
    hoverBtns = [{ x: cv.width / 2, y: cv.height * 0.62, r: Math.min(76, cv.width * 0.12),
                   label: '再玩一次', dwell: 0, action: restart }];
    setStatus('把手停在圓圈上，圈走完一輪就重新開始。');
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(8,10,14,.72)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e6e8ec';
    ctx.font = '700 44px -apple-system,"PingFang TC",sans-serif';
    ctx.fillText('得分 ' + score, cv.width / 2, cv.height * 0.33);
    ctx.font = '400 18px -apple-system,"PingFang TC",sans-serif';
    ctx.fillStyle = score >= best && score > 0 ? '#4ade80' : '#9aa3b2';
    ctx.fillText(score >= best && score > 0 ? '新紀錄' : '最高 ' + best,
                 cv.width / 2, cv.height * 0.33 + 38);
    // 講清楚是怎麼結束的 —— 不然會以為只有炸彈才會死
    ctx.font = '400 15px -apple-system,"PingFang TC",sans-serif';
    ctx.fillStyle = '#f87171';
    ctx.fillText('砍到 ' + LIVES + ' 次炸彈', cv.width / 2, cv.height * 0.33 + 64);
  }

  function restart() {
    // 注意：不重設校正。那是這個人的身形，不會因為重玩就變。
    clearRuntime();
    beginPlay();
  }

  function showResult(rows, verdict, tone) {
    const dl = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    const cls = tone ? ' class="' + tone + '"' : '';
    ui.result.innerHTML = '<h3>fp16 與 uint8 的差異</h3><dl>' + dl + '</dl>'
      + '<div class="verdict"' + cls + '>' + verdict + '</div>';
    ui.result.hidden = false;
  }

  ui.again.addEventListener('click', restart);

  // 同一批影格、三組設定，把數字印出來比。
  // 「分數低」跟「位置找錯」是兩件事，所以除了分數也要記下手腕落在哪。
  ui.probe.addEventListener('click', async () => {
    if (!video.videoWidth) { setStatus('要先按「開啟相機」。', true); return; }
    ui.probe.disabled = true;
    const JOINTS = ['left_shoulder','right_shoulder','left_elbow','right_elbow',
                    'left_wrist','right_wrist'];
    const dets = [];
    try {
      setStatus('載入三組模型…');
      const mk = (type, url) => poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { modelType: poseDetection.movenet.modelType[type],
          modelUrl: url, enableSmoothing: false, minPoseScore: 0.001 });

      // 正方形置中裁切：MoveNet 內部會把輸入補成正方形，
      // 4:3 的畫面補完之後人會偏小、也可能變形
      const side = Math.min(video.videoWidth, video.videoHeight);
      const crop = document.createElement('canvas');
      crop.width = side; crop.height = side;
      const cg = crop.getContext('2d');
      const ox = (video.videoWidth - side) / 2, oy = (video.videoHeight - side) / 2;

      const CFG = [
        { name: 'A Lightning 完整畫面',
          det: await mk('SINGLEPOSE_LIGHTNING', 'models/movenet-lightning/model.json'),
          input: () => video, sx: 1, sy: 1, dx: 0, dy: 0 },
        { name: 'B Thunder 完整畫面',
          det: await mk('SINGLEPOSE_THUNDER', 'models/movenet-thunder/model.json'),
          input: () => video, sx: 1, sy: 1, dx: 0, dy: 0 },
        { name: 'C Lightning 正方裁切',
          det: await mk('SINGLEPOSE_LIGHTNING', 'models/movenet-lightning/model.json'),
          input: () => { cg.drawImage(video, ox, oy, side, side, 0, 0, side, side); return crop; },
          sx: 1, sy: 1, dx: ox, dy: oy },
      ];
      for (const c of CFG) dets.push(c.det);

      const acc = CFG.map(() => ({ scores: {}, wrist: [], n: 0, none: 0 }));
      setStatus('舉起一隻手停著，正在比較三組設定（5 秒）…');
      const until = performance.now() + 5000;
      while (performance.now() < until) {
        for (let i = 0; i < CFG.length; i++) {
          const p = (await CFG[i].det.estimatePoses(CFG[i].input(),
                      { flipHorizontal: false }))[0];
          acc[i].n++;
          if (!p) { acc[i].none++; continue; }
          for (const k of p.keypoints) {
            if (!JOINTS.includes(k.name)) continue;
            (acc[i].scores[k.name] = acc[i].scores[k.name] || []).push(k.score);
          }
          // 分數最高的那隻手腕落在畫面的哪個位置（用比例表示，方便比較）
          const lw = p.keypoints.find((k) => k.name === 'left_wrist');
          const rw = p.keypoints.find((k) => k.name === 'right_wrist');
          const best = (lw && rw) ? (lw.score >= rw.score ? lw : rw) : (lw || rw);
          if (best) acc[i].wrist.push({
            x: +((best.x + CFG[i].dx) / video.videoWidth).toFixed(3),
            y: +((best.y + CFG[i].dy) / video.videoHeight).toFixed(3),
            s: +best.score.toFixed(3) });
        }
      }

      const med = (v) => { if (!v.length) return null;
        const a = [...v].sort((x,y)=>x-y); return +a[a.length>>1].toFixed(3); };
      const rows = CFG.map((c, i) => {
        const r = { 設定: c.name, 幀數: acc[i].n, 沒偵測到: acc[i].none };
        for (const j of JOINTS) r[j] = med(acc[i].scores[j] || []);
        const w = acc[i].wrist;
        r['最佳手腕分數'] = med(w.map((p) => p.s));
        r['手腕位置x'] = med(w.map((p) => p.x));
        r['手腕位置y'] = med(w.map((p) => p.y));
        return r;
      });

      console.log('%c=== 三組偵測設定比較 ===', 'font-weight:bold');
      console.table(rows);
      console.log('手腕位置是畫面比例：x 0=左 1=右，y 0=上 1=下（未鏡像，相機原始座標）');
      console.log(JSON.stringify(rows, null, 2));

      showResult(rows.map((r) => [r.設定.slice(0, 16),
        '腕 ' + (r.最佳手腕分數 ?? '—') + '　(' + (r.手腕位置x ?? '?') + ', '
        + (r.手腕位置y ?? '?') + ')']),
        '完整數字在主控台（F12 → Console），用 console.table 印成表格了。'
        + '手腕位置若落在畫面下緣（y 接近 1），就表示模型把人認錯位置，不是分數問題。');
      setStatus('比較完成，數字在下面與主控台。');
    } catch (e) {
      setStatus('比較失敗：' + e.message, true);
      console.error(e);
    } finally {
      for (const d of dets) if (d && d.dispose) d.dispose();
      ui.probe.disabled = false;
    }
  });

  ui.reset.addEventListener('click', () => {
    reenter();
    setStatus('數字已歸零，重新揮一輪。');
  });

  ui.model.addEventListener('change', syncBladeOptions);

  // 信心門檻只影響取點，不用重建模型，所以單獨接線
  ui.stable.addEventListener('change', () => {
    for (const k of Object.keys(joint)) delete joint[k];
    for (const k of Object.keys(boneMed)) delete boneMed[k];
    setStatus(ui.stable.checked ? '關節穩定化已開啟。' : '關節穩定化已關閉，可以比較差異。');
  });

  ui.scoreSel.addEventListener('change', () => {
    if (autoScore()) {
      setStatus('信心門檻改回自動，會跟著光線調整。');
    } else {
      // 手動選值視為覆寫，自動調整停止
      MIN_SCORE = parseFloat(ui.scoreSel.value);
      setStatus('信心門檻固定在 ' + MIN_SCORE.toFixed(2) + '，不再自動調整。');
    }
    reenter();
  });

  for (const node of [ui.backendSel, ui.model, ui.bladeSel, ui.smooth]) {
    node.addEventListener('change', async () => {
      if (!running) return;
      running = false;
      setStatus('正在重新設定…');
      try {
        await buildDetector();
        reenter();
        running = true; lastVideoTime = -1;
        startLoops();
        setStatus('換好了（' + tf.getBackend() + '），數字已歸零。');
      } catch (e) {
        // 失敗也要把迴圈開回來。原本只寫狀態列就結束，running 永遠停在
        // false、兩條迴圈都不再排程，畫面凍在舊幀而且看起來完全正常。
        setStatus('換不過去：' + (e.message || e) + '，維持原本的設定。', true);
        try { await buildDetector(); } catch (e2) { /* 連舊的都建不回來 */ }
        running = true; lastVideoTime = -1;
        startLoops();
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) { lastT = 0; lastFrameAt = 0; lastBladeAt = performance.now(); }
  });

  best = loadBest();
  probeBackends();
  syncBladeOptions();
  if (location.protocol === 'file:') {
    setStatus('這個頁面要從 http://localhost 開才能用相機。', true);
    ui.start.disabled = true;
  }
})();
