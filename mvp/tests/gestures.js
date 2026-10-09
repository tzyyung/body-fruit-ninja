// 動作語料：把常見的手勢軌跡產生出來，用來量偵測率。
//
// 為什麼要這個：靠使用者玩一局、回報一種失效、修一種 —— 那是把人當測試機，
// 而且每次只覆蓋他剛好做過的那個動作。常見動作就那幾種，直接全部產生出來
// 一次跑完，用數據訂規則。
//
// 座標單位是像素，尺寸以「前臂長」為單位給（身體尺度，見 CLAUDE.md §4.3），
// 所以同一組語料可以在不同站位（前臂 76 / 151 / 210 px）下重跑。
//
// 不做機器學習：這是幾何判準，不是分類問題。樣本要的是「涵蓋面」，
// 訓練資料要的是「代表性分布」—— 前者產生得出來，後者產生不出來。

// ── 形狀：給 u ∈ [0,1]，回傳單位尺度下的座標 ──
const SHAPES = {
  直線上揮:   (u) => [0, -u],
  直線下砍:   (u) => [0, u],
  橫線:       (u) => [u, 0],
  斜線:       (u) => [u * 0.707, -u * 0.707],
  反斜線:     (u) => [-u * 0.707, -u * 0.707],
  '1/4圓':    (u) => [Math.cos(u * Math.PI / 2), Math.sin(u * Math.PI / 2) - 1],
  半圓:       (u) => [Math.cos(u * Math.PI), Math.sin(u * Math.PI)],
  整圈:       (u) => [Math.cos(u * 2 * Math.PI), Math.sin(u * 2 * Math.PI)],
  方形:       (u) => { const s = u * 4;
                       if (s < 1) return [s, 0];
                       if (s < 2) return [1, s - 1];
                       if (s < 3) return [3 - s, 1];
                       return [0, 4 - s]; },
  三角形:     (u) => { const s = u * 3;
                       if (s < 1) return [s, 0];
                       if (s < 2) return [1 - (s - 1) * 0.5, (s - 1) * 0.866];
                       return [0.5 - (s - 2) * 0.5, 0.866 - (s - 2) * 0.866]; },
  之字:       (u) => { const s = u * 3, k = Math.floor(s), f = s - k;
                       return [s / 3, (k % 2 ? 1 - f : f) * 0.5]; },
  戳刺:       (u) => [0, -u],          // 跟直線同形，靠 size 很小來區分
};

// 不該被判成一刀的對照組
const NEGATIVE = {
  靜止:       (u) => [0, 0],
  慢移:       (u) => [u, 0],
  微調:       (u) => [Math.sin(u * Math.PI * 2) * 0.05, 0],
};

// 固定種子的亂數。會飄的測試比沒有測試更糟 ——
// 同一份程式跑兩次結果不一樣，就沒辦法用它判斷「我剛才改壞了沒」。
// mulberry32，夠均勻而且三行寫得完。
let _seed = 0x9E3779B9;
function seed(n) { _seed = n >>> 0; }
function random() {
  _seed = (_seed + 0x6D2B79F5) >>> 0;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rnd = (a) => (random() * 2 - 1) * a;

// 產生一段軌跡。
//   shape    形狀名
//   size     尺寸，單位是前臂長
//   forearm  前臂在畫面上幾 px
//   fps      推論更新率
//   ms       這個動作花多久
//   jitter   每點的追蹤抖動（px）
//   dropout  每幀掉點機率（刀刃抓不到）
function trajectory({ shape, size, forearm, fps, ms, jitter = 6, dropout = 0 }) {
  const f = SHAPES[shape] || NEGATIVE[shape];
  if (!f) throw new Error('沒有這個形狀：' + shape);
  const n = Math.max(2, Math.round(ms / 1000 * fps));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const now = i * (1000 / fps);
    if (dropout > 0 && i > 0 && i < n - 1 && random() < dropout) continue;
    const [ux, uy] = f(i / (n - 1));
    pts.push({ x: 320 + ux * size * forearm + rnd(jitter),
               y: 240 + uy * size * forearm + rnd(jitter),
               t: now });
  }
  return pts;
}

// 常見動作的預設參數（尺寸單位＝前臂長，時間取自 README「一刀 150–250ms」）
const CASES = [
  { shape: '直線上揮', size: 1.6, ms: 200 },
  { shape: '直線下砍', size: 1.8, ms: 180 },
  { shape: '橫線',     size: 2.0, ms: 200 },
  { shape: '斜線',     size: 1.8, ms: 200 },
  { shape: '反斜線',   size: 1.8, ms: 200 },
  { shape: '1/4圓',    size: 1.2, ms: 220 },
  { shape: '半圓',     size: 1.0, ms: 260 },
  { shape: '整圈',     size: 0.8, ms: 320 },
  { shape: '方形',     size: 1.0, ms: 400 },
  { shape: '三角形',   size: 1.0, ms: 340 },
  { shape: '之字',     size: 1.6, ms: 300 },
  { shape: '戳刺',     size: 0.5, ms: 120 },
];

const NEG_CASES = [
  { shape: '靜止', size: 0,    ms: 400 },
  { shape: '慢移', size: 0.25, ms: 600 },   // 約 0.4 前臂/秒
  { shape: '微調', size: 1.0,  ms: 500 },
];

module.exports.random = random;
module.exports = Object.assign(module.exports, { SHAPES, NEGATIVE, trajectory, CASES, NEG_CASES, seed });

// ── 解剖約束：手是掛在肩膀上的 ───────────────────────────────────────────
//
// 肩膀固定，所以手腕的位置被限制在以肩為心、半徑約臂長的環帶裡，
// 揮動就是在那條弧上走。這讓動作可以預測：
//   1) 距離上限 —— 超出可及範圍的偵測值一定是錯的（比速度上限強，而且不用校正）
//   2) 揮擊量用「繞肩膀掃過的角度」—— 跟手伸多長無關，天生是身體尺度
//   3) 掉幀可以沿弧外推補點，不是只能容忍
//
// 上臂約 30cm、前臂約 25cm，所以肩→腕的距離在 [約 0.35, 1.0] × 55cm 之間
// （手肘完全彎曲時最短，伸直時最長）。
const UPPER_OVER_FOREARM = 30 / 25;

// 把一條自由平面上的軌跡，壓回「肩膀構造允許」的範圍。
// 方向保留，只夾半徑 —— 真實的手做不到的位置，語料裡也不該出現。
function anchorToShoulder(pts, shoulder, forearm) {
  const armLen = forearm * (1 + UPPER_OVER_FOREARM);   // 肩→腕伸直時
  const rMin = armLen * 0.35, rMax = armLen;
  return pts.map((p) => {
    const dx = p.x - shoulder.x, dy = p.y - shoulder.y;
    const r = Math.hypot(dx, dy) || 1;
    const k = Math.min(rMax, Math.max(rMin, r)) / r;
    return { x: shoulder.x + dx * k, y: shoulder.y + dy * k, t: p.t };
  });
}

// 繞肩膀掃過的角度總和（弧度）。分段相加，跟 sweepLen 同一個道理。
function angularSweep(pts, shoulder) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a0 = Math.atan2(pts[i-1].y - shoulder.y, pts[i-1].x - shoulder.x);
    const a1 = Math.atan2(pts[i].y   - shoulder.y, pts[i].x   - shoulder.x);
    let d = a1 - a0;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += Math.abs(d);
  }
  return total;
}

module.exports.UPPER_OVER_FOREARM = UPPER_OVER_FOREARM;
module.exports.anchorToShoulder = anchorToShoulder;
module.exports.angularSweep = angularSweep;
