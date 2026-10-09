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
]) {
  t(caller + '() 裡有呼叫 ' + gate + '()',
    body(caller).includes(gate + '('), true);
}

section('自適應量一律走 Tracked，不要手刻 band/dwell');

// CLAUDE.md §2 的規定。手刻一套就會多一組沒人維護的遲滯邏輯。
t('Tracked 只有一個實作', count('function Tracked('), 1);
t('CUSUM 的決策界限只算一次', count('o.dwell * o.band'), 1);

done();
