// 動作語料的偵測率。
//
// 使用者說得對：不該一直靠他玩一局、回報一種失效、修一種。
// 常見動作就那幾種，直接全部產生出來跑一遍，用數據訂規則。
//
// 跑的是 app.js 真正的函式（linkInfo → 軌跡 → activeRun → fitLine → slashing），
// 不是一份複本。
const H = require('./_harness.js');
const G = require('./gestures.js');
const { t, section, done } = H;

const F = eval('(' + H.src.match(/  const F = \{[\s\S]*?\n  \}/)[0].replace(/^  const F = /, '') + ')');
const MAX_LINK_MS = H.num('MAX_LINK_MS');
const TRAIL_MS = H.num('TRAIL_MS');
const SLASH_FOREARM = H.num('SLASH_FOREARM');
let CANVAS_W = 640;
const px = (r) => r * CANVAS_W;
eval(H.fn('linkInfo'));
eval(H.fn('activeRun'));
eval(H.fn('fitLine'));
eval(H.fn('segments'));
eval(H.fn('sweepLen'));
const maxSpeedPx = () => 151 * 28;   // 校正鎖定後的跳動上限（前臂 × SPEED_FOREARM）

// 把一段軌跡餵進管線，回傳「這段動作有沒有在任何一幀被判成一刀」
function detect(pts, forearm) {
  const slashMin = forearm * SLASH_FOREARM;      // 校正鎖定後的門檻
  const trail = [];
  let prev = null, hit = false;
  for (const p of pts) {
    const b = { tx: p.x, ty: p.y };
    const linked = prev ? linkInfo(prev, b, p.t).linked : false;
    trail.push({ x: p.x, y: p.y, t: p.t, linked });
    prev = { tx: p.x, ty: p.y, t: p.t };
    // app.js 每幀只看 TRAIL_MS 視窗內的點
    const win = trail.filter((q) => p.t - q.t <= TRAIL_MS);
    const run = activeRun(win);
    if (run.length < 2) continue;
    if (sweepLen(run) >= slashMin) hit = true;
  }
  return hit;
}

const N = 400;
function rate(c, forearm, fps, dropout, jitter) {
  // 每一格都從同一個種子開始，所以整張表是可重現的
  G.seed(0xC0FFEE);
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const pts = G.trajectory({ ...c, forearm, fps, dropout, jitter });
    if (detect(pts, forearm)) hits++;
  }
  return hits / N;
}

const pct = (r) => (r * 100).toFixed(0).padStart(3) + '%';

console.log('門檻 = 前臂 × ' + SLASH_FOREARM + '　視窗 ' + TRAIL_MS + 'ms'
          + '　連線上限 ' + MAX_LINK_MS + 'ms / ' + px(F.maxLink).toFixed(0) + 'px');

// ── 主表：應該被判成一刀的動作 ──
for (const forearm of [151]) {
  for (const dropout of [0, 0.22]) {
    section('前臂 ' + forearm + 'px　掉點率 ' + (dropout * 100).toFixed(0)
          + '%　→ 各動作的偵測率（抖動 ±6px）');
    console.log('  動作          30fps  15fps   8fps');
    const bad = [];
    for (const c of G.CASES) {
      const r30 = rate(c, forearm, 30, dropout, 6);
      const r15 = rate(c, forearm, 15, dropout, 6);
      const r8  = rate(c, forearm,  8, dropout, 6);
      console.log('  ' + c.shape.padEnd(11, '　').slice(0, 11)
                + '  ' + pct(r30) + '  ' + pct(r15) + '  ' + pct(r8));
      // 戳刺只有 0.5 個前臂（約 6cm），本來就該低於「一刀至少掃過一個前臂」。
      // 留在表上是為了看得到它確實被擋掉，不是失敗。
      if (c.shape === '戳刺') continue;
      // 門檻訂在實測水準，不灌水。三角形在 15fps 下只有 5 個取樣點、
      // 三個邊各分不到兩點，是取樣密度的硬限制，不是判準的問題。
      const need = c.shape === '三角形' ? 0.70 : 0.95;
      if (r30 < 0.95 || r15 < need) {
        bad.push(c.shape + '(30fps ' + pct(r30) + ' / 15fps ' + pct(r15) + ')');
      }
    }
    t('每個動作 30fps ≥95%、15fps ≥95%（三角形 ≥70%、戳刺不算）',
      bad.length ? bad.join('、') : 0, 0);
  }
}

// ── 對照組：不該被判成一刀 ──
section('不該算一刀的（誤判率）');
console.log('  動作          30fps  15fps   8fps');
const falsePos = [];
for (const c of G.NEG_CASES) {
  const r30 = rate(c, 151, 30, 0, 6);
  const r15 = rate(c, 151, 15, 0, 6);
  const r8  = rate(c, 151,  8, 0, 6);
  console.log('  ' + c.shape.padEnd(11, '　').slice(0, 11)
            + '  ' + pct(r30) + '  ' + pct(r15) + '  ' + pct(r8));
  if (Math.max(r30, r15, r8) > 0.01) falsePos.push(c.shape + '(' + pct(Math.max(r30, r15, r8)) + ')');
}
t('靜止／慢移／微調的誤判率都要 ≤1%', falsePos.length ? falsePos.join('、') : 0, 0);

// ── 身體尺度不變性：同一組動作在不同站位下要有同樣的偵測率 ──
section('不同站位（前臂長）下的偵測率要一致');
for (const forearm of [76, 151, 210]) {
  let sum = 0;
  const pos = G.CASES.filter((c) => c.shape !== '戳刺');
  for (const c of pos) sum += rate(c, forearm, 30, 0.22, 6);
  const avg = sum / pos.length;
  console.log('  前臂 ' + String(forearm).padStart(3) + 'px（門檻 '
            + (forearm * SLASH_FOREARM).toFixed(0) + 'px）平均偵測率 ' + pct(avg));
  t('前臂 ' + forearm + 'px 的平均偵測率 ≥95%', avg >= 0.95, true);
}

section('已知限制（寫下來，不要下次又當成 bug 查一遍）');
console.log('  戳刺（0.5 個前臂 ≈ 6cm）刻意不算一刀 —— 低於「一刀至少掃過一個前臂」。');
console.log('  8fps 下圓/方/三角約 77–79%：340–400ms 的動作只有 3 個取樣點，');
console.log('  形狀根本沒被取樣到，是推論速率的硬限制。實機推論約 31/秒。');
console.log('  三角形 15fps 約 86%：同一個原因，5 個點分不到三個邊。');

done();
