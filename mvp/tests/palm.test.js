// 掌刀的幾何：掌刀 = 手腕 + 0.4 × 前臂投影長 × (手腕−基準點 的單位向量)
// 0.4 = 10cm ÷ 25cm 前臂。這是整個遊戲最核心的一條式子。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.error('抽不到 ' + name); process.exit(1); }
  return m[0].replace(/^  function/, 'function');
};
const num = (name) => {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*([\\d.]+)'));
  if (!m) { console.error('抽不到常數 ' + name); process.exit(1); }
  return Number(m[1]);
};

const FOREARM_CM = num('FOREARM_CM'), PALM_CM = num('PALM_CM'), TIP_CM = num('TIP_CM');
const PALM_K = PALM_CM / FOREARM_CM, TIP_K = TIP_CM / FOREARM_CM;
const DIR_MIN_FOREARM = num('DIR_MIN_FOREARM');
eval(grab(/  function palmPoint\(wrist, eb, sh, K, ref\) \{[\s\S]*?\n  \}/, 'palmPoint'));

const P = (x, y) => ({ x, y });
let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  期望 ' + want + ' 得到 ' + got);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('前臂 ' + FOREARM_CM + 'cm　掌刀 +' + PALM_CM + 'cm　K = ' + PALM_K.toFixed(2)
          + '　指尖 +' + TIP_CM + 'cm　K = ' + TIP_K.toFixed(2));
t('掌刀 K 就是 10/25', near(PALM_K, 0.40, 1e-9), true);

console.log('\n基本幾何 —— 偏移量與方向');

// 前臂垂直向上 200px：手肘 (300,400)、手腕 (300,200)、肩膀 (250,500)
const ref = 200;
let r = palmPoint(P(300, 200), P(300, 400), P(250, 500), PALM_K, ref);
console.log('  前臂 ' + r.foreLen + 'px　偏移 ' + r.off + 'px　掌刀 ('
          + r.x.toFixed(1) + ', ' + r.y.toFixed(1) + ')　用手肘=' + r.useElbow);
t('偏移量 = 0.4 × 前臂投影長', near(r.off, 80, 1e-9), true);
t('方向從手肘指向手腕再往前（y 變小 80）', near(r.y, 120, 1e-9), true);
t('垂直前臂不該有水平位移', near(r.x, 300, 1e-9), true);
t('前臂夠長時用手肘當基準', r.useElbow, true);

// 水平前臂：手肘 (100,300) → 手腕 (300,300)
r = palmPoint(P(300, 300), P(100, 300), P(50, 400), PALM_K, ref);
t('水平前臂：掌刀往右 80px', near(r.x, 380, 1e-9) && near(r.y, 300, 1e-9), true);

// 45 度
r = palmPoint(P(300, 300), P(200, 400), P(150, 450), PALM_K, ref);
const d45 = Math.hypot(r.x - 300, r.y - 300);
console.log('  45度：前臂 ' + r.foreLen.toFixed(1) + '　偏移 ' + d45.toFixed(1));
t('45 度時偏移仍是 0.4 倍前臂', near(d45, r.foreLen * PALM_K, 1e-9), true);

console.log('\n自動縮放 —— 人走遠走近不用重新調參數');

const far  = palmPoint(P(300, 250), P(300, 350), P(280, 400), PALM_K, 100);  // 前臂 100
const nearR = palmPoint(P(300, 200), P(300, 400), P(260, 500), PALM_K, 200); // 前臂 200
console.log('  站遠（前臂 100）偏移 ' + far.off + '　站近（前臂 200）偏移 ' + nearR.off);
t('站近時偏移剛好是站遠的兩倍', near(nearR.off, far.off * 2, 1e-9), true);

console.log('\n手伸直指向鏡頭 —— 前臂投影縮短');

// 前臂投影只剩 20px（< ref 200 × 0.3 = 60）→ 方向改用肩膀，但偏移量仍用投影長
r = palmPoint(P(300, 300), P(300, 320), P(300, 460), PALM_K, ref);
console.log('  前臂投影 ' + r.foreLen + 'px　用手肘=' + r.useElbow
          + '　偏移 ' + r.off + 'px');
t('前臂投影太短時改用肩膀當方向基線', r.useElbow, false);
t('偏移量仍跟著投影縮短（真實 10cm 投影後本來就該變短）', near(r.off, 8, 1e-9), true);
t('方向仍是從身體往外（y 變小）', r.y < 300, true);

// 完全朝向鏡頭：前臂投影 0 → 掌刀疊在手腕上，不可以是 NaN
r = palmPoint(P(300, 300), P(300, 300), P(300, 450), PALM_K, ref);
console.log('  前臂投影 0：掌刀 (' + r.x + ', ' + r.y + ')');
t('前臂投影 0 時掌刀落在手腕上', near(r.x, 300, 1e-9) && near(r.y, 300, 1e-9), true);
t('不可以出現 NaN', Number.isFinite(r.x) && Number.isFinite(r.y), true);

// 三點完全重合（模型完全崩潰）也不可以是 NaN
r = palmPoint(P(300, 300), P(300, 300), P(300, 300), PALM_K, ref);
t('三點重合也不可以是 NaN', Number.isFinite(r.x) && Number.isFinite(r.y), true);

console.log('\n方向基線的切換點');
const sw = ref * DIR_MIN_FOREARM;
console.log('  切換門檻 = 校正前臂 ' + ref + ' × ' + DIR_MIN_FOREARM + ' = ' + sw + 'px');
t('剛好在門檻上用手肘',
  palmPoint(P(300, 300), P(300, 300 + sw), P(300, 500), PALM_K, ref).useElbow, true);
t('差 1px 就改用肩膀',
  palmPoint(P(300, 300), P(300, 300 + sw - 1), P(300, 500), PALM_K, ref).useElbow, false);

console.log('\n指尖模式');
r = palmPoint(P(300, 200), P(300, 400), P(250, 500), TIP_K, ref);
t('指尖偏移 = 18/25 × 前臂', near(r.off, 200 * TIP_K, 1e-9), true);
t('指尖比掌刀遠', TIP_K > PALM_K, true);

console.log(fails ? '\n' + fails + ' 項失敗' : '\n全部通過');
process.exit(fails ? 1 : 0);
