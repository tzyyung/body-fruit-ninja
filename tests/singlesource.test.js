// 單一來源的機械檢查。
//
// 「同一段運算式只能有一個權威定義」靠紀律守不住 —— 複製出去的那幾份
// 一定會各自漂走，而且改的時候只會改到其中幾處，其他測試還是綠的。
// 所以直接掃原始碼數次數。
//
// 2026-10-09 的三個致命 bug 都是這條被違反的直接後果：
//   - 同一個估計器被兩隻手餵（校正前臂鎖在 40px）
//   - 顯示用的 kp 跟管線用的不是同一份（手臂被刪了畫面還顯示三個綠分數）
//   - calib fallback 在五個地方各寫一次，其中兩處的預設值還不一樣
const H = require('./_harness.js');
const { t, section, done } = H;

// 把註解和字串拿掉再數，不然文件裡提到的名字會被算進去
const code = H.src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

const count = (needle) => code.split(needle).length - 1;

function only(label, needle, max, who) {
  const c = count(needle);
  const ok = c <= max;
  t(label + '（' + who + '）', ok ? c : c + ' 處，應 ≤ ' + max, ok ? c : '≤ ' + max);
}

section('尺度與門檻只能有一個權威定義');

// bodyScale() 是「這個人現在有多大」的唯一答案。
// 例外：chainWhy 的診斷要特地回報「相對校正值」的比值，那是它的本意。
only('校正前臂的 fallback', 'calib.forearm > 4', 2, 'bodyScale + chainWhy 診斷');
only('畫面比例的保底值', 'px(0.09)', 1, '只能在 bodyScale 裡');

// scoreNeed() 是「這個點可不可信」的唯一答案
only('手肘信心門檻', 'MIN_SCORE * ELBOW_SCORE_MUL', 1, '只能在 scoreNeed 裡');

section('這一幀的關節只有兩份，而且只組一次');

// 顯示用的程式碼自己從 lastPose 再組一份，就會看不到管線後面做的刪除 ——
// 手臂已經被剔除，畫面上還顯示三個漂亮的綠色分數。
t('沒有任何地方自己從 lastPose 重建 kp', count('lastPose.keypoints'), 0);
// 按「行」算，不要按「出現次數」算 —— 宣告那一行同時有兩個名字。
const writeLines = code.split('\n').filter((l) => /\b(rawKp|pipeKp)\s*=[^=]/.test(l));
t('rawKp / pipeKp 只有三行會寫到（宣告 + 各一次指派）', writeLines.length, 3);
t('其中剛好一行是宣告',
  writeLines.filter((l) => /^\s*let\s/.test(l)).length, 1);

section('關鍵判斷只能有一個入口');

// 這些函式如果被繞過去（有人自己手刻一份同樣的判斷），
// 規則就只會生效一部分，而測試照樣綠。
for (const f of ['bodyScale', 'scoreNeed', 'chainOK', 'armsDistinct',
                 'weakerArm', 'palmPoint', 'shoulderWidth', 'continuity', 'dropOffFrame', 'activeSide']) {
  t('函式 ' + f + ' 只定義一次',
    count('function ' + f + '('), 1);
}

section('門檻比較一律走容差函式');

// 門檻幾乎都是算出來的（0.20 × 1.15 × 1.5 …），而
// 0.20 * 1.5 === 0.30000000000000004 —— 直接用 < 比，「剛好到門檻」
// 會隨算式寫法落在兩邊，同一個分數在兩個地方得到不同結論。
// 這種毛病的症狀是「偶爾有一幀沒有刀」，查不出來。
{
  const raw = code.split('\n')
    .map((l, i) => [i + 1, l])
    // 兩個分數互比（挑比較高的那個）不是門檻比較，不在此限
    .filter(([, l]) => /\.score\s*[<>]=?[^=]/.test(l) && !/\.score\s*[<>]=?\s*\w+\.score/.test(l))
    .map(([i, l]) => i + ': ' + l.trim().slice(0, 60));
  t('沒有直接拿 .score 跟門檻比的地方（要用 atLeast / below）',
    raw.length ? raw.join(' ｜ ') : 0, 0);
}
t('容差只有一個定義', count('const EPS ='), 1);

t('浮動文字只能從 popText 出', count('pops.push('), 1);
t('「持續多久」只有一份實作', count('function heldFor('), 1);
t('沒有人自己記 heldSince（要走 heldFor）',
  count('heldSince') - count('const heldSince') - count('heldSince[key]') * 1, 0);

section('用到 now 的函式一定要有 now');

// 2026-10-09 踩過：把 stepFruits 裡的 performance.now() 統一成一個 now 時，
// 字串取代連隔壁的 stepEffectsOnly 一起改了，但那支沒有 now ——
// ReferenceError 直接殺掉整條 requestAnimationFrame 鏈，畫面定格。
// 語法檢查抓不到（它是合法的識別字），只有真的跑起來才會炸。
{
  const bad = [];
  const re = /\n  function (\w+)\(([^)]*)\) \{([\s\S]*?)\n  \}/g;
  let m;
  while ((m = re.exec(code))) {
    const [, name, args, body] = m;
    // performance.now() / Date.now() 裡的 now 不算，要先拿掉
    const b2 = body.replace(/\b(performance|Date)\.now\b/g, 'TIMEFN');
    if (!/\bnow\b/.test(b2)) continue;
    const hasParam = /\bnow\b/.test(args);
    const hasLocal = /\b(const|let|var)\s+now\b/.test(b2);
    // 巢狀函式自己帶 now 參數的也算（例如 (now) => …）
    const nested = /\(\s*now\s*[,)]/.test(b2);
    if (!hasParam && !hasLocal && !nested) bad.push(name);
  }
  t('沒有函式用到未定義的 now', bad.length ? bad.join('、') : 0, 0);
}

section('接線：每一道關卡都要真的被呼叫');

// 「測得到函式」不等於「函式有被接上」。
// 2026-10-09 實測：把 dropOffFrame 從 stabilize 拿掉，它自己的 17 條測試
// 全部照樣綠 —— 因為那些測試是直接呼叫它的。
// 這是「規則只生效 1/N 而測試還是綠的」那一族，要用機械檢查擋。
const body = (name) => {
  const m = code.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  return m ? m[0] : '';
};
for (const [gate, caller] of [
  ['dropOffFrame',  'stabilize'],      // 出框的點要消失
  ['fixSides',      'stabilize'],      // 左右身分
  ['gateJumps',     'stabilize'],      // 跳動閘門
  ['gateBones',     'stabilize'],      // 骨長閘門
  ['forearmSampleOK', 'feedCalib'],    // 校正樣本的閘門
  ['chainOK',       'updateTracks'],   // 骨鏈幾何
  ['continuity',    'updateTracks'],   // 時間連續性
  ['latch',         'updateTracks'],   // SPRT 鎖存
  ['armsDistinct',  'ingestPose'],     // 兩條鏈不共用點
  ['weakerArm',     'ingestPose'],     // 重疊時刪哪一邊
  ['sweepOf',       'computeStroke'],  // 揮擊量
  ['segments',      'sweepLen'],       // 分段
  ['liftChain',     'palm3D'],         // Taylor 逐段還原
  ['onScaleChange', 'sizeCanvas'],     // 尺度變了，像素存的東西要作廢
  ['resetCalib',    'onScaleChange'],  // 校正值是像素，首當其衝
  ['btnAt',         'stepHover'],      // 命中判定要用這一幀的尺寸
  ['btnAt',         'drawHoverBtns'],  // 畫的也是
]) {
  t(caller + '() 裡有呼叫 ' + gate + '()',
    body(caller).includes(gate + '('), true);
}

section('基本運算只能有一個定義，不准各自內聯');

// 2026-10-09 掃出來的：dist(a,b) 被定義了兩次（armsDistinct 裡一份、
// 關節穩定化那一節一份），另外還有十幾處各自寫 Math.hypot(a.x-b.x, a.y-b.y)。
// 更糟的是 linkInfo 裡有一個叫 dist 的「數字」把外層的 dist() 遮掉 ——
// 之後在那支函式裡寫 dist(a,b) 會變成「不是函式」。
t('dist 只定義一次', count('const dist ='), 1);
t('TAU 只定義一次', count('const TAU ='), 1);
t('dtSec 只定義一次', count('const dtSec ='), 1);
// 1 = dist 自己的定義。多出來的每一個都是複製貼上。
t('兩點距離只在 dist 的定義裡出現',
  (code.match(/Math\.hypot\(\w+\.x - \w+\.x, \w+\.y - \w+\.y\)/g) || []).length, 1);
t('沒有人再寫 6.3 當整圓', count('6.3)'), 0);
// 1 = dtSec 自己的定義
t('幀間秒數只在 dtSec 的定義裡出現',
  (code.match(/Math\.max\(\([\w. -]+\) \/ 1000, 1e-3\)/g) || []).length, 1);

// 正規式換字串時把定義本身也換掉 → const f = (a,b) => f(a,b)
// 語法合法、node --check 過，但一呼叫就 RangeError。實際踩過兩次（dist、dtSec）。
{
  const bad = [...code.matchAll(/const (\w+) = \([^)]*\) => ([\s\S]*?);\n/g)]
    .filter((m) => new RegExp('\\b' + m[1] + '\\(').test(m[2]))
    .map((m) => m[1]);
  t('沒有自己呼叫自己的一行定義', bad.length ? bad.join('、') : 0, 0);
}

// 測試抽出來的函式會用到這些基本運算，少一行就整檔 ReferenceError。
// 入口統一在 H.core()，不要每個測試檔各自補一份。
{
  const fs2 = require('fs'), path2 = require('path');
  const roots = [path2.join(__dirname), path2.join(__dirname, '..', 'features', 'steps')];
  const missing = [];
  for (const dir of roots) {
    for (const f of fs2.readdirSync(dir)) {
      if (!/\.(test|steps)\.js$/.test(f)) continue;
      const body = fs2.readFileSync(path2.join(dir, f), 'utf8');
      if (!/H\.(fn|expr)\(/.test(body)) continue;      // 沒抽原始碼的不需要
      if (!body.includes('H.core()')) missing.push(f);
    }
  }
  t('每個抽原始碼的測試都接上 H.core()', missing.length ? missing.join('、') : 0, 0);
}

section('detector 要等暖機完才掛上去；畫面問的是圓圈不是 detector');

// 2026-10-09 Android 實測回報：推論更新 10/秒、但沒有開始圓圈。
// 原因是 buildDetector 建好就指派、再暖機：
//   detector 一有值 → 已經在跑的 inferLoop 立刻開始推論（跟首次著色器
//   編譯搶 GPU），而且 drawReady 的守衛是 if (!detector)，於是畫面顯示
//   「把手停在圓圈上」—— 可是建立圓圈的 enterReady() 要等 buildDetector
//   回來才跑。使用者被叫去停一個不存在的圓圈。
t('warmup 收參數，不吃全域 detector', /async function warmup\(det\)/.test(code), true);
t('沒有不帶參數的 warmup() 呼叫', count('warmup()'), 0);
t('detector 不是直接從 createDetector 指派的',
  (code.match(/detector = await poseDetection\.createDetector/g) || []).length, 0);
t('warmup 的內文不碰全域 detector', /\bdetector\b/.test(body('warmup')), false);
// 「畫面上有沒有圓圈」的唯一依據就是圓圈本身
t('drawReady 不拿 detector 當有沒有圓圈的依據',
  /\bdetector\b/.test(body('drawReady')), false);
t('drawReady 問的是 hoverBtns', /hoverBtns/.test(body('drawReady')), true);

section('量測期間畫面不准沉默');

// 2026-10-09 使用者回報「按下去卡住 5 秒、沒有手部圈圈」。
// 那 5 秒是設計好的量測窗，手部圈圈不出現也是對的（跑的是量測用的臨時
// 模型，遊戲自己的追蹤沒在更新）—— 但它跟「壞掉」長得一模一樣。
// 會佔住 GPU 的量測都必須：停掉遊戲迴圈、自己畫、而且在 finally 裡復原。
{
  const probe = code.slice(code.indexOf("ui.probe.addEventListener"));
  for (const [name, blk] of [['比較三組設定', probe]]) {
    t(name + ' 會停掉遊戲迴圈', /const resume = pauseForMeasure\(\);/.test(blk), true);
    t(name + ' 迴圈裡每一輪都畫', /while \(performance\.now\(\) < until\) \{\s*\n\s*drawMeasuring\(/.test(blk), true);
    // 中途丟錯的話迴圈就再也不會回來，所以復原一定要在 finally
    t(name + ' 在 finally 裡復原', /finally \{[\s\S]*?resume\(\);/.test(blk), true);
  }
  t('pauseForMeasure 只有一個定義', count('function pauseForMeasure('), 1);
  t('drawMeasuring 只有一個定義', count('function drawMeasuring('), 1);
  // 鏡像畫影像只能有一份，不然量測的覆蓋層會跟遊戲中左右相反
  t('鏡像畫影像只有一個定義', count('function drawMirroredVideo('), 1);
  t('沒有人再自己鏤一次鏡像',
    (code.match(/ctx\.translate\(cv\.width, 0\); ctx\.scale\(-1, 1\)/g) || []).length, 1);
}

section('模型網址只能從一個地方來');

// 面板上的比較按鈕原本寫死 'models/xxx/model.json'，繞過來源賽跑 ——
// 在 GitHub Pages 上那是 43KB/s，「比較三組偵測設定」要抓 17MB
//（含 12MB 的 thunder）。等於按下去就當掉。
t('modelHref 只有一個定義', count('const modelHref ='), 1);
// MODELS 的 dir 是三筆；除此之外不准再出現寫死的模型路徑
t('沒有寫死的 model.json 路徑',
  (code.match(/'models\/[\w-]+\/model\.json'/g) || []).length, 0);
// null 代表「所有來源都抓不到」。null 不能丟給 tfjs —— 它會當成網址去抓。
// 所以每一處 modelUrl: url 都必須包在守衛裡，數量要一樣多。
{
  const all = (code.match(/modelUrl: url/g) || []).length;
  const guarded = (code.match(/url \? \{ modelUrl: url \} : null/g) || []).length;
  t('每個 modelUrl: url 都在守衛裡', all - guarded, 0);
  t('比較按鈕的 modelUrl 有守衛', guarded, 1);
}

section('懸停圓圈用比例存，不要存像素');

// 2026-10-09 Android 回報「出現圓圈但很快就又消失了」，WebGPU 不會、
// WebGL 會 —— 差別在幀率有沒有跨過高解析看門狗那條線（fps 連續 3 秒
// < 45 就把 renderScale 降回 1、重設 cv.width/height）。
// 圓圈存絕對像素的話，就留在舊尺寸算出來的位置上。
// 接線檢查是比對字串，所以 `if (false) onScaleChange();` 照樣會過 ——
// 跑變異時實際踩到。守衛本身也要鎖，不能只鎖「有沒有提到這個名字」。
t('尺度改變的守衛比的是前後值',
  /if \(renderScale !== was\) onScaleChange\(\);/.test(code), true);

t('btnAt 只有一個定義', count('const btnAt ='), 1);
t('建立圓圈時不寫入 x/y/r 像素',
  (code.match(/hoverBtns = \[\{ x:/g) || []).length, 0);
t('建立圓圈用的是比例', (code.match(/hoverBtns = \[\{ rx:/g) || []).length, 2);
// 滑鼠點的那條路也要走同一個圓，不能自己算一份
t('滑鼠點擊走 btnAt', /const box = btnAt\(b\);\n      if \(Math\.hypot/.test(code), true);

section('模型檔同時抓，不要排隊');

// 冷啟實測每個檔要等 1.7–4.7 秒才吐第一個位元組（jsDelivr）。
// 一個一個抓的話那幾段 TTFB 會疊加，使用者看到的是好幾段「進度完全不動」。
t('其餘的檔用 Promise.all 同時抓',
  /Promise\.all\(m\.files/.test(code), true);
// 舊的寫法是「上一個檔的累計 + 這個檔的目前」，那只在排隊抓時成立
t('沒有殘留循序累加的寫法', /base \+= await pullFile/.test(code), false);

section('三種尺度一律走 px / py / fs');

// §4.3：絕對像素、畫面寬比例、身體尺度是三種不同的東西，用錯會無聲壞掉。
// px()/py()/fs() 就是這三者的入口，但原本有 45 處直接寫 cv.width * 0.28、
// cv.height * 0.30、cv.width / 2 —— 等於入口形同虛設，而且下一個人很容易
// 把垂直錨點寫成 cv.width * r（4:3 下看起來還「差不多對」，16:9 下整個歪）。
//
// 允許的例外只有四處：fs 的定義、兩處長寬比、滑鼠座標對應。
{
  const raw = (H.src.match(/cv\.(?:width|height) ?[*/] ?[0-9.]+/g) || [])
    .filter((x) => !/\/ ?640$/.test(x));
  t('沒有人直接拿 cv.width/height 乘除數字', raw.length ? raw.join('、') : 0, 0);
}

section('localStorage 只能有一個出入口');

// §4.8：localStorage 在無痕視窗會**丟錯**而不是回 null。
// 原本五個呼叫點各自包一次 try/catch，第六個忘了包的話整頁當場死掉。
t('localStorage 只在 store 裡被碰到', count('localStorage.'), 2);
t('store 的讀有 try', /get\(key\) \{ try \{/.test(code), true);
t('store 的寫有 try', /set\(key, val\) \{ try \{/.test(code), true);

section('記住偏好只能在使用者真的選了之後');

// 2026-10-09 量到的：setPanel 無條件寫 localStorage，於是「還沒選過」
// 這個憑據（null）在第一次載入就被寫掉，下面那條「沒設定過就跟著斷點走」
// 從此永遠跑不到 —— 在桌機開再轉直式，面板還是展開，畫布被擠成 272px 高、
// 整頁多出 1448px 捲動。跟 §4.2b 同一族：判斷要不要套預設的依據，
// 被套預設的動作自己摧毀。
{
  t('setPanel 有 remember 參數', /function setPanel\(show, remember\)/.test(code), true);
  only('寫入面板偏好的地方', 'localStorage.setItem(PANEL_KEY', 1, '只能在 setPanel 裡');
  // 括號要真的配對 —— setPanel(saved === null ? !narrow() : …) 裡有巢狀的 ()，
  // 用 /setPanel\([^;]*?\)/ 只會配到第一個右括號（實測只抓到 0 個 remember=true）
  const calls = [];
  for (let i = code.indexOf('setPanel('); i >= 0; i = code.indexOf('setPanel(', i + 1)) {
    // 宣告那一行不算呼叫
    if (/function\s+$/.test(code.slice(Math.max(0, i - 10), i))) continue;
    let d = 0, j = i + 'setPanel'.length;
    for (; j < code.length; j++) {
      if (code[j] === '(') d++;
      else if (code[j] === ')' && --d === 0) break;
    }
    calls.push(code.slice(i, j + 1));
  }
  const remembering = calls.filter((c) => /,\s*true\s*\)$/.test(c));
  t('setPanel(..., true) 只有一個呼叫點', remembering.length, 1);
  t('那個呼叫點是按鈕的 click',
    /addEventListener\('click', \(\) => setPanel\([^;]*?,\s*true\s*\)\)/.test(code), true);
  // 套預設的兩處都不准記住，否則 null 又會被寫掉
  t('每個 setPanel 呼叫都明寫 remember',
    calls.filter((c) => !/,\s*(true|false)\s*\)$/.test(c)).length, 0);
}

section('自適應量一律走 Tracked，不要手刻 band/dwell');

// CLAUDE.md §2 的規定。手刻一套就會多一組沒人維護的遲滯邏輯。
t('Tracked 只有一個實作', count('function Tracked('), 1);
t('CUSUM 的決策界限只算一次', count('o.dwell * o.band'), 1);

done();
