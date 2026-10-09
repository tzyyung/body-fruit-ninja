// 出框的關節點要直接消失。
//
// 使用者回報：「手已經放下來在螢幕外了，卻仍然被判定有手刀可以切」。
//
// 模型不會告訴你出框了 —— MoveNet 永遠回傳 17 個點，出框的會被壓在邊界上，
// 位置看起來合法、只是分數低。所以規則是「在邊界上**而且**信心不夠」
// 才當作沒有這個點。真手確實會揮到畫面邊緣，但那時分數是高的。
const H = require('./_harness.js');
const { t, section, done } = H;

const SIDES = ['left', 'right'];
const ARM = ['shoulder', 'elbow', 'wrist'];
const ELBOW_SCORE_MUL = H.num('ELBOW_SCORE_MUL');
const FORE_OVER_SHOULDER = H.num('FORE_OVER_SHOULDER');
const EDGE_MARGIN = H.num('EDGE_MARGIN');
const EDGE_SCORE_MUL = H.num('EDGE_SCORE_MUL');
let MIN_SCORE = 0.20;
const cv = { width: 640, height: 480 };
const px = (r) => r * cv.width;
let calib = { forearm: 150 };
let joint = {};
let stats = { offFrame: 0 };
// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());
eval(H.fn('shoulderWidth'));
eval(H.fn('bodyScale'));
const { atLeast, below } = H;   // 跟 app.js 同一組容差比較
eval(H.fn('scoreNeed'));
eval(H.fn('dropOffFrame'));

const M = calib.forearm * EDGE_MARGIN;   // 邊緣帶的寬度
console.log('畫面 ' + cv.width + 'x' + cv.height + '　前臂 ' + calib.forearm
          + 'px　邊緣帶 ' + M.toFixed(0) + 'px'
          + '　門檻 ' + MIN_SCORE + '（邊緣要 ×' + EDGE_SCORE_MUL + '）');

const P = (x, y, score) => ({ x, y, score });
// 一副完整的、在畫面中央的骨架
const base = () => ({
  left_shoulder:  P(240, 200, 0.80), right_shoulder: P(400, 200, 0.80),
  left_elbow:     P(220, 300, 0.70), right_elbow:    P(420, 300, 0.70),
  left_wrist:     P(200, 380, 0.60), right_wrist:    P(440, 380, 0.60),
});
const run = (kp) => { stats.offFrame = 0; joint = {}; dropOffFrame(kp); return kp; };

section('手放下到畫面外 —— 模型把手腕壓在下緣，分數低');

{
  const kp = base();
  kp.left_wrist = P(205, 476, 0.18);        // 貼著下緣、低分
  run(kp);
  t('出框的手腕被刪掉', kp.left_wrist === undefined, true);
  t('同一隻手的肩膀留著（它還在畫面裡）', kp.left_shoulder !== undefined, true);
  t('另一隻手完全不受影響', kp.right_wrist !== undefined, true);
  t('有記到次數', stats.offFrame, 1);
}

section('真手揮到畫面邊緣 —— 位置一樣，但分數是高的');

{
  const kp = base();
  kp.left_wrist = P(205, 476, 0.75);        // 同一個位置，高分
  run(kp);
  t('高分的邊緣點要留著（真手會揮到邊緣）', kp.left_wrist !== undefined, true);
  t('沒有誤刪', stats.offFrame, 0);
}

section('邊界剛好的那一刀');

for (const [name, y, score, keep] of [
  ['剛好在邊緣帶外、低分', M + 1, 0.18, true],
  ['剛好在邊緣帶內、低分', M - 1, 0.18, false],
  ['邊緣帶內、剛好到門檻×1.5（容差要讓它過）', M - 1, MIN_SCORE * EDGE_SCORE_MUL, true],
  ['邊緣帶內、差一點點', M - 1, MIN_SCORE * EDGE_SCORE_MUL - 0.01, false],
]) {
  const kp = base();
  kp.left_wrist = P(205, y, score);
  run(kp);
  t(name, kp.left_wrist !== undefined, keep);
}

section('四個邊都要擋');

for (const [name, x, y] of [
  ['上緣', 320, 5], ['下緣', 320, 475], ['左緣', 5, 240], ['右緣', 635, 240],
]) {
  const kp = base();
  kp.left_wrist = P(x, y, 0.18);
  run(kp);
  t(name + '的低分點要刪掉', kp.left_wrist === undefined, true);
}

section('手肘的門檻比手腕嚴（掌刀算式會放大手肘誤差）');

{
  const kp = base();
  // 剛好 0.30：過得了手腕的邊緣門檻（0.20×1.5），
  // 過不了手肘的（0.20×1.15×1.5＝0.345）。
  // 「剛好等於門檻」要算通過 —— 這是容差比較存在的理由：
  // 0.20 * 1.5 === 0.30000000000000004，直接用 < 比的話這一條會紅。
  kp.left_wrist = P(205, 476, 0.30);
  kp.left_elbow = P(215, 476, 0.30);
  run(kp);
  t('剛好在門檻上（0.30）：手腕留著', kp.left_wrist !== undefined, true);
  t('同樣 0.30：手肘被刪（門檻多乘 ' + ELBOW_SCORE_MUL + '）',
    kp.left_elbow === undefined, true);
}

section('沒有校正值時，尺度退回當幀肩寬換算');

{
  calib = null;
  const kp = base();
  const sw = Math.hypot(400 - 240, 0);
  console.log('  肩寬 ' + sw + 'px × ' + FORE_OVER_SHOULDER
            + ' = ' + (sw * FORE_OVER_SHOULDER).toFixed(0) + 'px，邊緣帶 '
            + (sw * FORE_OVER_SHOULDER * EDGE_MARGIN).toFixed(0) + 'px');
  kp.left_wrist = P(205, 476, 0.18);
  run(kp);
  t('未校正時一樣擋得住', kp.left_wrist === undefined, true);
  calib = { forearm: 150 };
}

done();
