// 量測覆蓋層有沒有畫到畫面外。
//
// 這個專案踩過：診斷畫在 y = 0.90 × 高，最關鍵那一行超出下緣被切掉，
// 白白多一輪而且使用者沒辦法複製貼上（CLAUDE.md §3.5）。
// 所以凡是新增的畫面元素，都要用程式確認它在可見範圍內 ——
// 而且要在最小的畫布上確認（4:3 的 640×480，以及 16:9 的 640×360）。
const H = require('./_harness.js');
const { t, section, done } = H;

// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());

const cv = { width: 640, height: 480 };
const px = (r) => r * cv.width;
const py = (r) => r * cv.height;
const fs = (n) => n * (cv.width / 640);
const video = { readyState: 0 };     // 沒有影像 → 走純色底那條路
const drawMirroredVideo = () => {};

// 記下每一次繪製的垂直範圍
let marks = [];
const ctx = {
  fillStyle: '', font: '', textAlign: '', textBaseline: '',
  save() {}, restore() {}, translate() {}, scale() {},
  fillRect(x, y, w, h) { marks.push({ kind: 'rect', x, y, w, h }); },
  fillText(s, x, y) { marks.push({ kind: 'text', s, x, y }); },
  measureText() { return { width: 0 }; },
};

eval(H.fn('drawMeasuring'));

function run(w, h, label) {
  cv.width = w; cv.height = h;
  marks = [];
  // 刻意不用一半 —— 剩 2500/5000 的時候 `1 - 剩/全` 和 `剩/全` 都是 0.5，
  // 填反了也看不出來（跑變異時實際漏掉過）。
  drawMeasuring('正在比對 fp16 / uint8', 1000, 5000, 17);
  // 底色那一塊是整張畫布，不算
  const items = marks.filter((m) => !(m.kind === 'rect' && m.x === 0 && m.y === 0));
  const texts = items.filter((m) => m.kind === 'text');
  const bars = items.filter((m) => m.kind === 'rect');

  section(label + '（' + w + '×' + h + '）');
  t('有畫標題與提示與倒數', texts.length >= 3, true);
  t('有進度條（底 + 填充）', bars.length >= 2, true);
  // 文字的 baseline 是 middle，所以留半行的餘量
  const pad = 0.5 * (16 * (w / 640));
  const lowest = Math.max(...items.map((m) => m.kind === 'rect' ? m.y + m.h : m.y + pad));
  const highest = Math.min(...items.map((m) => m.y - (m.kind === 'rect' ? 0 : pad)));
  t('最低的東西沒有超出下緣（' + Math.round(lowest) + ' <= ' + h + '）', lowest <= h, true);
  t('最高的東西沒有超出上緣', highest >= 0, true);
  // 水平方向：進度條要在畫面裡
  const widest = Math.max(...bars.map((m) => m.x + m.w));
  const leftmost = Math.min(...bars.map((m) => m.x));
  t('進度條沒有超出右緣', widest <= w, true);
  t('進度條沒有超出左緣', leftmost >= 0, true);
  t('進度條水平置中', Math.abs((leftmost + widest) / 2 - w / 2) < 1, true);
  // 進度要真的反映剩下的時間（剩一半 → 填一半）
  const fill = bars[bars.length - 1], base = bars[bars.length - 2];
  // 剩 1000/5000 ⇒ 已經過了 80%，條子要填 80%（不是 20%）
  t('填的是「已經過了多少」而不是「還剩多少」',
    Math.abs(fill.w / base.w - 0.8) < 0.01, true);
}

run(640, 480, '4:3');
run(640, 360, '16:9（Continuity Camera 會給這個）');
run(1280, 720, '高解析');

done();
