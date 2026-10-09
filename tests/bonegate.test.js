// 骨長閘門。
//
// 兩個獨立的缺陷，都是「防線回報成功但其實沒在擋」：
//
// 1. 排在 gateJumps 之後 ⇒ 恆等變換。gateJumps 接受一個點時已經把那個
//    （可能錯的）座標寫進 joint[]，gateBones 再從同一筆「還原」=
//    寫回一模一樣的值。但 stats.boneGate 照樣累加。
// 2. boneLength 把它正要判定為錯誤的長度也 push 進中位數視窗 ⇒
//    連續 16 幀壞資料之後判準本身就變成錯誤長度，從此完全沉默。
const H = require('./_harness.js');
const { t, section, done } = H;

const BONE_LO = Number(H.src.match(/BONE_LO = ([\d.]+)/)[1]);
const BONE_HI = Number(H.src.match(/BONE_HI = ([\d.]+)/)[1]);
const HOLD_MAX_MS = H.num('HOLD_MAX_MS');
const BONE_RESET_MS = H.num('BONE_RESET_MS');
const SIDES = ['left', 'right'];
let boneMed = {}, joint = {}, stats = { boneGate: 0 };
const heldSince = {};
// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());
eval(H.fn('heldFor'));
eval(H.fn('boneMedian'));
eval(H.fn('pushBone'));
eval(H.fn('gateBones'));

console.log('可接受範圍 ' + BONE_LO + '–' + BONE_HI + ' 倍中位數'
          + '　沿用上一點最久 ' + HOLD_MAX_MS + 'ms'
          + '　連續被擋 ' + BONE_RESET_MS + 'ms 就認帳');

const kpWith = (foreLen) => ({
  left_shoulder: { x: 300, y: 100, score: .9, name: 'left_shoulder' },
  left_elbow:    { x: 300, y: 200, score: .9, name: 'left_elbow' },
  left_wrist:    { x: 300, y: 200 + foreLen, score: .9, name: 'left_wrist' },
});
const reset = () => {
  boneMed = {}; joint = {}; stats.boneGate = 0;
  for (const k of Object.keys(heldSince)) delete heldSince[k];
};

section('順序：排在 gateJumps 之前（不然是恆等變換）');
t('stabilize 裡 gateBones 在 gateJumps 之前',
  H.src.indexOf('gateBones(kp, now);') < H.src.indexOf('gateJumps(kp, now);'), true);

section('正常的骨長要建立判準');
{
  reset();
  let now = 0;
  for (let i = 0; i < 20; i++) { gateBones(kpWith(100), now); now += 33; }
  console.log('  20 幀 100px 之後，中位數 = ' + boneMedian('left_elbow_wrist'));
  t('中位數收斂到真實長度', boneMedian('left_elbow_wrist'), 100);
  t('沒有誤擋', stats.boneGate, 0);
}

section('突然變成兩倍 —— 要擋，而且要沿用上一個點');
{
  reset();
  let now = 0;
  for (let i = 0; i < 20; i++) { gateBones(kpWith(100), now); now += 33; }
  joint.left_wrist = { x: 300, y: 300, t: now, heldSince: 0 };
  const kp = kpWith(260);                       // 2.6 倍，超過 BONE_HI
  gateBones(kp, now);
  t('壞掉的手腕被換成上一個點', kp.left_wrist.y, 300);
  t('有記到次數', stats.boneGate, 1);
}

section('判準不可以被它要擋的東西汙染（這是第二個缺陷）');
{
  reset();
  let now = 0;
  for (let i = 0; i < 20; i++) { gateBones(kpWith(100), now); now += 33; }
  const before = boneMedian('left_elbow_wrist');
  // 連續 16 幀壞資料 —— 舊做法到這裡中位數已經變成壞的長度
  for (let i = 0; i < 16; i++) {
    joint.left_wrist = { x: 300, y: 300, t: now, heldSince: now };
    gateBones(kpWith(260), now); now += 33;
  }
  const after = boneMedian('left_elbow_wrist');
  console.log('  連續 16 幀壞資料：中位數 ' + before + ' → ' + after);
  t('中位數沒有被壞樣本帶走', after, before);
}

section('但連續被擋太久要認帳 —— 人真的走近時骨長本來就會變');
{
  reset();
  let now = 0;
  for (let i = 0; i < 20; i++) { gateBones(kpWith(100), now); now += 33; }
  // 人走近，前臂真的變成 200px，持續超過 BONE_RESET_MS
  const frames = Math.ceil(BONE_RESET_MS / 33) + 3;
  for (let i = 0; i < frames; i++) {
    joint.left_wrist = { x: 300, y: 300, t: now, heldSince: now };
    gateBones(kpWith(200), now); now += 33;
  }
  console.log('  持續 ' + (frames * 33) + 'ms 的新長度之後，中位數 = '
            + boneMedian('left_elbow_wrist'));
  t('判準換到新的長度，不會永遠擋著', boneMedian('left_elbow_wrist') > 150, true);
}

done();
