// armsDistinct / weakerArm —— 決定「一隻真手會不會被另一隻（常常是模型猜出來的）
// 手砍掉」。2026-10-09 的失效之一：0.16 的猜測座標可以否決 0.60 的真手臂。
const H = require('./_harness.js');
const { t, section, done } = H;

// ── app.js 的相依（替身）──
let MIN_SCORE = 0.17;
const ELBOW_SCORE_MUL = H.num('ELBOW_SCORE_MUL');
const LR_SCORE_MARGIN = H.num('LR_SCORE_MARGIN');
const FORE_OVER_SHOULDER = H.num('FORE_OVER_SHOULDER');
const px = (r) => r * 640;
let calib = { forearm: 185 };
eval(H.fn('shoulderWidth'));
eval(H.fn('bodyScale'));
eval(H.fn('scoreNeed'));          // 不存在就讓 harness 報錯，不要無聲略過
eval(H.fn('armsDistinct'));
eval(H.fn('weakerArm'));

const P = (x, y, score) => ({ x, y, score });

console.log('LR_SCORE_MARGIN = ' + LR_SCORE_MARGIN
          + '　前臂 = ' + calib.forearm
          + '　重合門檻 = ' + (calib.forearm * 0.15).toFixed(1) + 'px'
          + '　肩膀門檻 = ' + (calib.forearm * 0.5).toFixed(1) + 'px');

section('armsDistinct —— 哪些輸入該被當成「兩條鏈共用點」');

// 截圖的情形：左手三點高分，右手是模型對沒舉起那隻手的猜測。
const oneArmUp = {
  left_shoulder:  P(213, 414, 0.73), right_shoulder: P(508, 472, 0.82),
  left_elbow:     P(113, 442, 0.60), right_elbow:    P(130, 450, 0.16),
  left_wrist:     P(146, 271, 0.47), right_wrist:    P(240, 280, 0.22),
};
t('單手舉起，另一手低信心猜測，手腕相距 95px', armsDistinct(oneArmUp), true);

// 手肘 0.16 < 0.17×1.15 = 0.196 → 不可信，不該拿來否決任何東西。
// 舊版沒有這道門，兩個手肘相距 17px 就直接砍掉整隻真手臂。
t('不可信的手肘（0.16）疊在真手肘上，不該否決', armsDistinct(oneArmUp), true);

// 雙手往中間揮（切水果最基本的動作）：手腕相距 40px，兩邊都高分。
// 舊門檻 185×0.45 = 83px → 每次都砍掉一把刀。
t('雙手往中間揮，手腕相距 40px', armsDistinct({
  left_shoulder:  P(240, 300, 0.9), right_shoulder: P(400, 300, 0.9),
  left_elbow:     P(260, 380, 0.9), right_elbow:    P(380, 380, 0.9),
  left_wrist:     P(300, 420, 0.9), right_wrist:    P(340, 420, 0.9),
}), true);

t('兩邊高分但幾乎同一點（模型沒分左右）', armsDistinct({
  left_shoulder:  P(300, 300, 0.9), right_shoulder: P(305, 302, 0.9),
  left_elbow:     P(310, 380, 0.9), right_elbow:    P(312, 381, 0.9),
  left_wrist:     P(320, 420, 0.9), right_wrist:    P(322, 421, 0.9),
}), false);

t('兩肩重疊（手腕分得開也不行）', armsDistinct({
  left_shoulder:  P(300, 300, 0.9), right_shoulder: P(320, 300, 0.9),
  left_elbow:     P(200, 380, 0.9), right_elbow:    P(420, 380, 0.9),
  left_wrist:     P(150, 420, 0.9), right_wrist:    P(480, 420, 0.9),
}), false);

t('兩手腕都高分且重疊 15px', armsDistinct({
  left_shoulder:  P(240, 300, 0.9), right_shoulder: P(400, 300, 0.9),
  left_elbow:     P(260, 380, 0.9), right_elbow:    P(380, 380, 0.9),
  left_wrist:     P(300, 420, 0.9), right_wrist:    P(315, 420, 0.9),
}), false);

// 沒有校正值時 bodyScale 會退回當幀肩寬 × 0.63；兩肩都在就還是有尺規
calib = null;
const sw = Math.hypot(508 - 213, 472 - 414);
console.log('  未校正：bodyScale = 肩寬 ' + sw.toFixed(0)
          + ' × ' + FORE_OVER_SHOULDER + ' = ' + (sw * FORE_OVER_SHOULDER).toFixed(0) + 'px');
t('未校正（尺度改用當幀肩寬）單手舉起', armsDistinct(oneArmUp), true);
calib = { forearm: 185 };

section('weakerArm —— 真的重疊時，要刪掉哪一邊');

const kpReal = { left_wrist: P(300, 420, 0.47), right_wrist: P(310, 420, 0.22) };

// 這是修掉的那個卡死狀態：幽靈先確認（SPRT 上界 4.55），真手剛舉起還在爬（0.8）。
// 舊版比軌跡信用 → 刪掉真手 → 永遠翻不了身。
t('幽靈已確認、真手剛舉起 —— 要刪幽靈，不是真手',
  weakerArm(kpReal, { left: 0.8, right: 4.55 }), 'right');
t('真手已確認、幽靈剛出現 —— 一樣刪幽靈',
  weakerArm(kpReal, { left: 4.55, right: 0.8 }), 'right');
t('兩邊信用相同 —— 還是看手腕信心',
  weakerArm(kpReal, { left: 4.55, right: 4.55 }), 'right');
t('兩邊信心相近（差 1.1 倍 < 1.25），改由軌跡信用決定',
  weakerArm({ left_wrist: P(300, 420, 0.40), right_wrist: P(310, 420, 0.44) },
            { left: 4.55, right: 1.0 }), 'right');
t('兩邊信心相近、信用也相同 —— 退回比分數（平手留左）',
  weakerArm({ left_wrist: P(300, 420, 0.44), right_wrist: P(310, 420, 0.44) },
            { left: 2.0, right: 2.0 }), 'right');
t('右手信心明顯較高 —— 刪左手',
  weakerArm({ left_wrist: P(300, 420, 0.18), right_wrist: P(310, 420, 0.55) },
            { left: 4.55, right: 0.0 }), 'left');

done();
