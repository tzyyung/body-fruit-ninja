// 從 app.js 抽出 armsDistinct / weakerArm，在 node 裡跑。
// 這兩支決定「一隻真手會不會被另一隻（常常是模型猜出來的）手砍掉」。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.error('抽不到 ' + name); process.exit(1); }
  return m[0].replace(/^  function/, 'function');
};

let MIN_SCORE = 0.17;
const ELBOW_SCORE_MUL = 1.15;
const LR_SCORE_MARGIN = Number(src.match(/const LR_SCORE_MARGIN = ([\d.]+)/)[1]);
const px = (r) => r * 640;
let calib = { forearm: 185 };
eval(grab(/  function armsDistinct\(kp\) \{[\s\S]*?\n  \}/, 'armsDistinct'));
eval(grab(/  function weakerArm\(kp, trk2\) \{[\s\S]*?\n  \}/, 'weakerArm'));

const P = (x, y, score) => ({ x, y, score });
let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  期望 ' + want + ' 得到 ' + got);
};

console.log('LR_SCORE_MARGIN =', LR_SCORE_MARGIN, ' 前臂 =', calib.forearm,
            ' 重合門檻 =', (calib.forearm * 0.15).toFixed(1) + 'px',
            ' 肩膀門檻 =', (calib.forearm * 0.5).toFixed(1) + 'px');

console.log('\narmsDistinct —— 哪些輸入該被當成「兩條鏈共用點」');

// 截圖的情形：左手三點高分，右手是模型對沒舉起那隻手的猜測。
// 猜出來的手肘落在真手肘附近，但手腕在身側 —— 舊版 0.45 門檻會誤擋。
t('單手舉起，另一手低信心猜測，手腕相距 95px',
  armsDistinct({
    left_shoulder:  P(213, 414, 0.73), right_shoulder: P(508, 472, 0.82),
    left_elbow:     P(113, 442, 0.60), right_elbow:    P(130, 450, 0.16),
    left_wrist:     P(146, 271, 0.47), right_wrist:    P(240, 280, 0.22),
  }), true);

// 手肘 0.16 < 0.17×1.15 = 0.196 → 不可信，不該拿來否決任何東西。
// 舊版沒有這道門，兩個手肘相距 17px 就直接砍掉整隻真手臂。
t('不可信的手肘（0.16）疊在真手肘上，不該否決',
  armsDistinct({
    left_shoulder:  P(213, 414, 0.73), right_shoulder: P(508, 472, 0.82),
    left_elbow:     P(113, 442, 0.60), right_elbow:    P(130, 450, 0.16),
    left_wrist:     P(146, 271, 0.47), right_wrist:    P(240, 280, 0.22),
  }), true);

// 雙手往中間揮（切水果最基本的動作）：手腕相距 40px，兩邊都高分。
// 舊門檻 185×0.45 = 83px → 每次都砍掉一把刀。
t('雙手往中間揮，手腕相距 40px',
  armsDistinct({
    left_shoulder:  P(240, 300, 0.9), right_shoulder: P(400, 300, 0.9),
    left_elbow:     P(260, 380, 0.9), right_elbow:    P(380, 380, 0.9),
    left_wrist:     P(300, 420, 0.9), right_wrist:    P(340, 420, 0.9),
  }), true);

// 真正要擋的：兩邊都高分、而且幾乎是同一組點
t('兩邊高分但幾乎同一點（模型沒分左右）',
  armsDistinct({
    left_shoulder:  P(300, 300, 0.9), right_shoulder: P(305, 302, 0.9),
    left_elbow:     P(310, 380, 0.9), right_elbow:    P(312, 381, 0.9),
    left_wrist:     P(320, 420, 0.9), right_wrist:    P(322, 421, 0.9),
  }), false);

t('兩肩重疊（手腕分得開也不行）',
  armsDistinct({
    left_shoulder:  P(300, 300, 0.9), right_shoulder: P(320, 300, 0.9),
    left_elbow:     P(200, 380, 0.9), right_elbow:    P(420, 380, 0.9),
    left_wrist:     P(150, 420, 0.9), right_wrist:    P(480, 420, 0.9),
  }), false);

t('兩手腕都高分且重疊 15px',
  armsDistinct({
    left_shoulder:  P(240, 300, 0.9), right_shoulder: P(400, 300, 0.9),
    left_elbow:     P(260, 380, 0.9), right_elbow:    P(380, 380, 0.9),
    left_wrist:     P(300, 420, 0.9), right_wrist:    P(315, 420, 0.9),
  }), false);

calib = null;
t('未校正（尺度 = 畫面寬 9% = 57.6px）單手舉起',
  armsDistinct({
    left_shoulder:  P(213, 414, 0.73), right_shoulder: P(508, 472, 0.82),
    left_elbow:     P(113, 442, 0.60), right_elbow:    P(130, 450, 0.16),
    left_wrist:     P(146, 271, 0.47), right_wrist:    P(240, 280, 0.22),
  }), true);
calib = { forearm: 185 };

console.log('\nweakerArm —— 真的重疊時，要刪掉哪一邊');

const kpReal = { left_wrist: P(300, 420, 0.47), right_wrist: P(310, 420, 0.22) };

// 這是修掉的那個卡死狀態：幽靈先確認（SPRT 上界 4.55），
// 真手剛舉起還在爬（0.8）。舊版比軌跡信用 → 刪掉真手 → 永遠翻不了身。
t('幽靈已確認、真手剛舉起 —— 要刪幽靈，不是真手',
  weakerArm(kpReal, { left: 0.8, right: 4.55 }), 'right');

t('真手已確認、幽靈剛出現 —— 一樣刪幽靈',
  weakerArm(kpReal, { left: 4.55, right: 0.8 }), 'right');

t('兩邊信用相同 —— 還是看手腕信心',
  weakerArm(kpReal, { left: 4.55, right: 4.55 }), 'right');

// 信心相近（0.44 vs 0.40，差 1.1 倍 < 1.25）就沒有一眼可辨的差別，
// 這時才輪到軌跡信用說話
t('兩邊信心相近，改由軌跡信用決定',
  weakerArm({ left_wrist: P(300, 420, 0.40), right_wrist: P(310, 420, 0.44) },
            { left: 4.55, right: 1.0 }), 'right');

t('兩邊信心相近、信用也相同 —— 退回比分數（平手留左）',
  weakerArm({ left_wrist: P(300, 420, 0.44), right_wrist: P(310, 420, 0.44) },
            { left: 2.0, right: 2.0 }), 'right');

t('右手信心明顯較高 —— 刪左手',
  weakerArm({ left_wrist: P(300, 420, 0.18), right_wrist: P(310, 420, 0.55) },
            { left: 4.55, right: 0.0 }), 'left');

console.log(fails ? '\n' + fails + ' 項失敗' : '\n全部通過');
process.exit(fails ? 1 : 0);
