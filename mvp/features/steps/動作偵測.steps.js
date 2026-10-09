// 把動作語料接到 app.js 真正的揮擊判準。
//
// 驗收方法取自 gesture spotting 的文獻慣例：同時報偵測率與誤報率，
// 並用 reliability = 正確偵測 ÷ (動作總數 + 誤報) 當單一指標
// （Lee & Kim 1999 的 threshold model 論文用的就是這個）——
// 只報偵測率可以靠放寬門檻作弊，只報誤報率可以靠關掉功能作弊。
const assert = require('assert');
const H = require('../../tests/_harness.js');
const G = require('../../tests/gestures.js');

const TRAIL_MS      = H.num('TRAIL_MS');
const MAX_LINK_MS   = H.num('MAX_LINK_MS');
const SLASH_FOREARM = H.num('SLASH_FOREARM');
const SPEED_FOREARM = H.num('SPEED_FOREARM');
const ARM_OVER_FOREARM = H.num('ARM_OVER_FOREARM');
const LIFT_PLANAR   = H.num('LIFT_PLANAR');
const F = eval('(' + H.src.match(/  const F = \{[\s\S]*?\n  \}/)[0].replace(/^  const F = /, '') + ')');

let CANVAS_W = 640;
const px = (r) => r * CANVAS_W;
let FOREARM = 151;
let ARM = FOREARM * ARM_OVER_FOREARM;
const SH = { x: 320, y: 430 };
const maxSpeedPx = () => FOREARM * SPEED_FOREARM;

eval(H.fn('linkInfo'));
eval(H.fn('activeRun'));
eval(H.fn('fitLine'));
eval(H.fn('segments'));
eval(H.fn('sweepLen'));
eval(H.fn('liftZ'));
eval(H.fn('sweep3D'));

// app.js 的 sweepOf 會去讀 pipeKp／calib／cv，這裡用同一條規則但餵固定的肩膀。
// 規則本身（夾 z、用最小 d/L 切換、取 max）跟 app.js 逐字相同。
function sweepHere(run) {
  const flat = sweepLen(run);
  let minRatio = 1;
  for (const q of run) {
    minRatio = Math.min(minRatio, Math.hypot(q.x - SH.x, q.y - SH.y) / ARM);
  }
  if (minRatio > LIFT_PLANAR) return flat;
  return Math.max(flat, sweep3D(run, SH, ARM));
}

function detect(pts) {
  const MIN = FOREARM * SLASH_FOREARM;
  const trail = [];
  let prev = null, hit = false;
  for (const p of pts) {
    const b = { tx: p.x, ty: p.y };
    const linked = prev ? linkInfo(prev, b, p.t).linked : false;
    trail.push({ x: p.x, y: p.y, t: p.t, linked });
    prev = { tx: p.x, ty: p.y, t: p.t };
    const win = trail.filter((q) => p.t - q.t <= TRAIL_MS);
    const run = activeRun(win);
    if (run.length >= 2 && sweepHere(run) >= MIN) hit = true;
  }
  return hit;
}

// 在球面上做動作，弱透視投影成 2D。
// 不用 (方位角, 仰角) —— 極點有奇異性，方位角維度會整個塌掉。
// 改成在標稱方向的切平面上建正交基底，形狀當切平面位移再正規化回球面。
function onSphere(shapeName, size, ms, fps, dropout, ext) {
  const f = G.SHAPES[shapeName] || G.NEGATIVE[shapeName];
  if (!f) throw new Error('沒有這個動作：' + shapeName);
  const n = Math.max(2, Math.round(ms / 1000 * fps));
  const r = ARM * ext;
  const amp = size * FOREARM / ARM;
  const n0 = { x: 0.45, y: 0.55, z: 0.70 };
  const k = Math.hypot(n0.x, n0.y, n0.z);
  n0.x /= k; n0.y /= k; n0.z /= k;
  const up = { x: 0, y: 1, z: 0 };
  const e1 = { x: up.y*n0.z - up.z*n0.y, y: up.z*n0.x - up.x*n0.z, z: up.x*n0.y - up.y*n0.x };
  const e1n = Math.hypot(e1.x, e1.y, e1.z); e1.x/=e1n; e1.y/=e1n; e1.z/=e1n;
  const e2 = { x: n0.y*e1.z - n0.z*e1.y, y: n0.z*e1.x - n0.x*e1.z, z: n0.x*e1.y - n0.y*e1.x };

  const pts = [];
  for (let i = 0; i < n; i++) {
    if (dropout > 0 && i > 0 && i < n - 1 && G.random() < dropout) continue;
    const [ux, uy] = f(i / (n - 1));
    const a = ux * amp, b = uy * amp;
    let d = { x: n0.x + e1.x*a + e2.x*b, y: n0.y + e1.y*a + e2.y*b, z: n0.z + e1.z*a + e2.z*b };
    const dn = Math.hypot(d.x, d.y, d.z);
    pts.push({ x: SH.x + d.x / dn * r + (G.random()*2-1)*6,
               y: SH.y + d.y / dn * r + (G.random()*2-1)*6,
               t: i * (1000 / fps) });
  }
  return pts;
}

const SIZES = Object.fromEntries(
  [...G.CASES, ...G.NEG_CASES].map((c) => [c.shape, { size: c.size, ms: c.ms }]));

module.exports = (define) => {

  define(/^肩膀在畫面上，臂長 (\d+)px$/, function (len) {
    ARM = Number(len);
    this.ext = 1.0; this.fps = 30; this.dropout = 0;
  });

  define(/^身形已經校正，前臂 (\d+)px$/, function (len) {
    FOREARM = Number(len);
    ARM = FOREARM * ARM_OVER_FOREARM;
  });

  define(/^玩家做「(.+)」這個動作$/, function (name) {
    if (!SIZES[name]) throw new Error('語料裡沒有「' + name + '」');
    this.shape = name;
  });

  define(/^手臂伸展程度 ([\d.]+)$/, function (e) { this.ext = Number(e); });

  define(/^推論 (\d+) 幀每秒、掉點率 (\d+)%$/, function (fps, d) {
    this.fps = Number(fps); this.dropout = Number(d) / 100;
  });

  define(/^重複 (\d+) 次$/, function (n) {
    G.seed(0xC0FFEE);
    const { size, ms } = SIZES[this.shape];
    let hits = 0;
    const total = Number(n);
    for (let i = 0; i < total; i++) {
      if (detect(onSphere(this.shape, size, ms, this.fps, this.dropout, this.ext))) hits++;
    }
    this.rate = hits / total;
    this.total = total;
  });

  define(/^偵測率至少 (\d+)%$/, function (want) {
    assert.ok(this.rate * 100 >= Number(want),
      this.shape + ' 伸展 ' + this.ext + '：偵測率 '
      + (this.rate * 100).toFixed(0) + '%，要求 ≥' + want + '%');
  });

  define(/^誤報率最多 (\d+)%$/, function (want) {
    assert.ok(this.rate * 100 <= Number(want),
      this.shape + '：誤報率 ' + (this.rate * 100).toFixed(0) + '%，要求 ≤' + want + '%');
  });

  define('跑完整組動作語料', function () {
    G.seed(0xC0FFEE);
    let detected = 0, gestures = 0, falseAlarms = 0;
    for (const c of G.CASES) {
      if (c.shape === '戳刺') continue;         // 刻意不算一刀，見 motion.test.js
      // 只統計「宣稱支援的區域」（手臂七成伸展以上）。
      // 把彎手臂那段也算進去會得到 68.6% —— 那個數字下面會印出來，
      // 但不拿它當通過標準，因為我們還沒宣稱支援那個區域（見 feature 的已知缺口）。
      for (const ext of [0.75, 1.0]) {
        for (let i = 0; i < 100; i++) {
          gestures++;
          if (detect(onSphere(c.shape, c.size, c.ms, 30, 0.22, ext))) detected++;
        }
      }
    }
    for (const c of G.NEG_CASES) {
      for (let i = 0; i < 100; i++) {
        if (detect(onSphere(c.shape, c.size, c.ms, 30, 0, 1.0))) falseAlarms++;
      }
    }
    this.reliability = detected / (gestures + falseAlarms);
    console.log('      支援區域（伸展 ≥0.75）：動作 ' + gestures + ' 次、偵測到 '
              + detected + '、誤報 ' + falseAlarms
              + ' → reliability ' + (this.reliability * 100).toFixed(1) + '%');
    // 連彎手臂一起算的全域數字，只印不斷言 —— 這是已知缺口的量化版本
    let d2 = 0, g2 = 0;
    for (const c of G.CASES) {
      if (c.shape === '戳刺') continue;
      for (const ext of [0.4, 0.6]) {
        for (let i = 0; i < 100; i++) {
          g2++;
          if (detect(onSphere(c.shape, c.size, c.ms, 30, 0.22, ext))) d2++;
        }
      }
    }
    console.log('      彎手臂（伸展 0.4–0.6）：' + d2 + '/' + g2
              + ' → ' + (d2 / g2 * 100).toFixed(1) + '%　← 已知缺口，待逐段 lifting');
  });

  define(/^reliability 至少 (\d+)%$/, function (want) {
    assert.ok(this.reliability * 100 >= Number(want),
      'reliability ' + (this.reliability * 100).toFixed(1) + '%，要求 ≥' + want + '%');
  });
};
