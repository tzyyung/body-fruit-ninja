// 把 .feature 裡的句子接到 app.js 真正的函式。
//
// 這裡組的是一條**迷你管線**：用的是從 app.js 抽出來的真函式
// （shoulderWidth → bodyScale → updateTracks → armsDistinct → weakerArm
// → palmPoint），只有 DOM 相關的東西（ui / cv / video / stats）用替身。
// 所以這些場景驗的是「這些函式接起來之後的行為」，不是某一支的邊界。
const assert = require('assert');
const H = require('../../tests/_harness.js');

// ── app.js 的全域（替身）──
let MIN_SCORE = 0.17;
const ELBOW_SCORE_MUL      = H.num('ELBOW_SCORE_MUL');
const LR_SCORE_MARGIN      = H.num('LR_SCORE_MARGIN');
const FORE_OVER_SHOULDER   = H.num('FORE_OVER_SHOULDER');
const FORE_VS_SHOULDER_HI  = H.num('FORE_VS_SHOULDER_HI');
const UPPER_VS_SHOULDER_HI = H.num('UPPER_VS_SHOULDER_HI');
const DIR_MIN_FOREARM      = H.num('DIR_MIN_FOREARM');
const CHAIN_MEM_MS         = H.num('CHAIN_MEM_MS');
const CHAIN_MOVE           = H.num('CHAIN_MOVE');
const PALM_K               = H.num('PALM_CM') / H.num('FOREARM_CM');
const SPRT_ALPHA = 0.01, SPRT_BETA = 0.05;
const SPRT_A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);
const SPRT_B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));
const SIDES = ['left', 'right'];
const ARM = ['shoulder', 'elbow', 'wrist'];

let CANVAS_W = 640;
const px = (r) => r * CANVAS_W;
let calib = null;

const track = { left: 0, right: 0 };
const confirmed = { left: false, right: false };
const chainHist = { left: null, right: null };
const evLast = { left: null, right: null };
const chainWhy = { left: null, right: null };
const noBlade = { left: '', right: '' };
const stats = { lrRejects: 0, chainBroken: 0, armHidden: 0, forearm: 0 };

// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());
const EV  = eval(H.expr('EV'));
const llr = eval(H.expr('llr'));
const { atLeast, below } = H;   // 跟 app.js 同一組容差比較
eval(H.fn('shoulderWidth'));
eval(H.fn('bodyScale'));
eval(H.fn('scoreNeed'));
eval(H.fn('chainOK'));
eval(H.fn('armsDistinct'));
eval(H.fn('weakerArm'));
eval(H.fn('continuity'));
eval(H.fn('rememberChain'));
eval(H.fn('latch'));
eval(H.fn('updateTracks'));
eval(H.fn('palmPoint'));

// ── 一個人站在鏡頭前的預設姿勢（640x480，前臂約 200px）──
// 左手舉起、右手垂在身側。座標是模型座標系（未鏡像）。
const posture = () => ({
  left_shoulder:  { x: 240, y: 240 }, right_shoulder: { x: 400, y: 240 },
  left_elbow:     { x: 210, y: 350 }, right_elbow:    { x: 430, y: 350 },
  left_wrist:     { x: 190, y: 160 }, right_wrist:    { x: 445, y: 455 },
});

// bladeFor 的刀刃部分（鏡像 + 門檻 + 鏈確認），用真函式組起來
function bladeOf(side, kp) {
  const mirror = (k) => ({ x: CANVAS_W - k.x, y: k.y, score: k.score });
  const get = (n) => {
    const k = kp[side + '_' + n];
    return k && k.score >= scoreNeed(n) ? mirror(k) : null;
  };
  const wrist = get('wrist');
  if (!wrist) return null;
  const eb = get('elbow'), sh = get('shoulder');
  if (!(eb && sh && confirmed[side])) return null;
  const pt = palmPoint(wrist, eb, sh, PALM_K, bodyScale(kp));
  return { x: pt.x, y: pt.y, wrist, eb, foreLen: pt.foreLen, off: pt.off };
}

module.exports = (define) => {

  define(/^相機畫面是 (\d+)x(\d+)$/, function (w, h) {
    CANVAS_W = Number(w);
    this.kp = posture();
    for (const s of SIDES) { track[s] = 0; confirmed[s] = false; chainHist[s] = null; }
    stats.lrRejects = 0;
  });

  define(/^身形已經校正，前臂 (\d+)px$/, function (len) {
    calib = { forearm: Number(len) };
  });

  define(/^(左|右)手三點都清楚，分數 ([\d.]+) \/ ([\d.]+) \/ ([\d.]+)$/,
    function (zh, sh, eb, wr) {
      const side = zh === '左' ? 'left' : 'right';
      this.kp[side + '_shoulder'].score = Number(sh);
      this.kp[side + '_elbow'].score    = Number(eb);
      this.kp[side + '_wrist'].score    = Number(wr);
    });

  define(/^(左|右)手是模型的猜測，分數 ([\d.]+) \/ ([\d.]+) \/ ([\d.]+)$/,
    function (zh, sh, eb, wr) {
      const side = zh === '左' ? 'left' : 'right';
      this.kp[side + '_shoulder'].score = Number(sh);
      this.kp[side + '_elbow'].score    = Number(eb);
      this.kp[side + '_wrist'].score    = Number(wr);
    });

  define(/^兩隻手腕靠到相距 (\d+)px$/, function (d) {
    const mid = (this.kp.left_wrist.x + this.kp.right_wrist.x) / 2;
    const half = Number(d) / 2;
    this.kp.left_wrist.x  = mid - half;
    this.kp.right_wrist.x = mid + half;
    this.kp.left_wrist.y  = this.kp.right_wrist.y = 300;
  });

  define('右手的猜測疊在左手臂上', function () {
    // MoveNet 對出框的手臂會把點猜在畫面裡別的地方，常常疊在真手臂上
    this.kp.right_elbow.x = this.kp.left_elbow.x + 8;
    this.kp.right_elbow.y = this.kp.left_elbow.y + 5;
    this.kp.right_wrist.x = this.kp.left_wrist.x + 10;
    this.kp.right_wrist.y = this.kp.left_wrist.y + 6;
  });

  define(/^兩把掌刀相距 (\d+) 到 (\d+)px 之間$/, function (lo, hi) {
    const b = this.blades;
    assert.ok(b.left && b.right, '有一邊沒有掌刀，量不到距離');
    const d = Math.hypot(b.left.x - b.right.x, b.left.y - b.right.y);
    assert.ok(d >= Number(lo) && d <= Number(hi),
      '兩把掌刀相距 ' + d.toFixed(0) + 'px，不在 ' + lo + '–' + hi + ' 之間');
  });

  define(/^被剔除的是(左|右)手$/, function (zh) {
    const side = zh === '左' ? 'left' : 'right';
    const other = side === 'left' ? 'right' : 'left';
    // 真的疊在一起時「刪哪一邊」才是關鍵 ——
    // 刪錯邊就是使用者看到的「手掌不見了而且一直不回來」。
    assert.ok(this.lastKp[side + '_wrist'] === undefined,
      side + ' 應該被剔除，但它還在');
    assert.ok(this.lastKp[other + '_wrist'] !== undefined,
      other + ' 不該被剔除，卻被刪掉了');
  });

  define('左手的軌跡信用已經被打到下界', function () {
    track.left = SPRT_B; confirmed.left = false; chainHist.left = null;
  });

  define(/^追蹤 (\d+) 幀$/, function (n) {
    let now = 1000;
    for (let i = 0; i < Number(n); i++) {
      const kp = JSON.parse(JSON.stringify(this.kp));   // 每幀一份新的，模擬推論輸出
      noBlade.left = noBlade.right = '';
      updateTracks(kp, now);
      if (!armsDistinct(kp)) {
        const weak = weakerArm(kp, track);
        for (const part of ARM) delete kp[weak + '_' + part];
        chainHist[weak] = null;
        track[weak] = Math.max(SPRT_B, track[weak] - 2);
        confirmed[weak] = false;
        stats.lrRejects++;
      }
      const blades = { left: bladeOf('left', kp), right: bladeOf('right', kp) };
      this.blades = blades;
      this.lastKp = kp;
      now += 33;
    }
  });

  define(/^(左|右)手要有掌刀$/, function (zh) {
    const side = zh === '左' ? 'left' : 'right';
    assert.ok(this.blades[side],
      side + ' 沒有掌刀：Λ=' + track[side].toFixed(2)
      + ' confirmed=' + confirmed[side]
      + ' 證據=' + JSON.stringify(evLast[side])
      + ' 原因=' + (noBlade[side] || '—'));
  });

  define(/^(左|右)手不可以有掌刀$/, function (zh) {
    const side = zh === '左' ? 'left' : 'right';
    assert.ok(!this.blades[side],
      side + ' 不該有掌刀，卻算出 (' + (this.blades[side] || {}).x + ')');
  });

  define(/^(左|右)手掌刀離手腕的距離是前臂的 ([\d.]+) 倍$/, function (zh, k) {
    const side = zh === '左' ? 'left' : 'right';
    const b = this.blades[side];
    assert.ok(b, side + ' 沒有掌刀，無法檢查距離');
    const d = Math.hypot(b.x - b.wrist.x, b.y - b.wrist.y);
    const want = b.foreLen * Number(k);
    assert.ok(Math.abs(d - want) < 0.001,
      '偏移 ' + d.toFixed(2) + 'px，應為前臂 ' + b.foreLen.toFixed(2)
      + ' × ' + k + ' = ' + want.toFixed(2));
  });

  define(/^(左|右)手掌刀在手腕的延長線上$/, function (zh) {
    const side = zh === '左' ? 'left' : 'right';
    const b = this.blades[side];
    assert.ok(b, side + ' 沒有掌刀');
    // 手肘→手腕 與 手腕→掌刀 必須同向（內積為正、叉積接近 0）
    const v1 = { x: b.wrist.x - b.eb.x, y: b.wrist.y - b.eb.y };
    const v2 = { x: b.x - b.wrist.x,    y: b.y - b.wrist.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const cross = Math.abs(v1.x * v2.y - v1.y * v2.x);
    assert.ok(dot > 0, '掌刀的方向跟前臂反了（內積 ' + dot.toFixed(1) + '）');
    assert.ok(cross < 1e-6, '掌刀偏離前臂延長線（叉積 ' + cross.toFixed(4) + '）');
  });
};
