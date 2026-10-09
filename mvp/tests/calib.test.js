// 從 app.js 抽出 chainOK / Tracked / pctile，在 node 裡跑。
//
// 這支測的是 2026-10-09 那個「手掌永遠不出現」的失效：
// 校正前臂被幽靈手臂的樣本汙染到 40px（真實約 200px），
// 於是 chainOK 的前臂上界變成「超過 88px 就擋」，真手臂一律不合格，
// 鏈永遠不成立 → SPRT 掉到下界 → 永遠沒有刀，而且不會自己好。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.error('抽不到 ' + name); process.exit(1); }
  return m[0].replace(/^  (function|const)/, '$1');
};
const num = (name) => {
  const m = src.match(new RegExp('const ' + name + ' = ([\\d.]+)'));
  if (!m) { console.error('抽不到常數 ' + name); process.exit(1); }
  return Number(m[1]);
};

const UPPER_VS_SHOULDER_HI = num('UPPER_VS_SHOULDER_HI');
const FORE_VS_SHOULDER_HI  = num('FORE_VS_SHOULDER_HI');
const FORE_VS_SHOULDER_LO  = num('FORE_VS_SHOULDER_LO');
let calib = null;
const chainWhy = { left: null, right: null };
eval(grab(/  function chainOK\(sh, eb, wr, shoulderW, side\) \{[\s\S]*?\n  \}/, 'chainOK'));
// const 在 eval 裡是 eval 自己的區塊作用域，外面拿不到 ——
// 所以這兩個要取右手邊的函式運算式再 eval。function 宣告沒這個問題。
const rhs = (re, name) => {
  const code = grab(re, name);
  return eval('(' + code.slice(code.indexOf('=') + 1).replace(/;\s*$/, '') + ')');
};
const median = rhs(/  const median = \(v\) => \{[\s\S]*?\n  \};/, 'median');
const pctile = rhs(/  const pctile = \(v, q\) => \{[\s\S]*?\n  \};/, 'pctile');
eval(grab(/  function Tracked\(opts\) \{[\s\S]*?\n  \}\n/, 'Tracked'));

const P = (x, y) => ({ x, y });
let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  期望 ' + want + ' 得到 ' + got);
};

console.log('上臂/肩寬上界 =', UPPER_VS_SHOULDER_HI,
            ' 前臂/肩寬 =', FORE_VS_SHOULDER_LO + '–' + FORE_VS_SHOULDER_HI);

console.log('\nchainOK —— 不能再被「學壞的校正值」關掉');

// 真實比例：肩寬 200px、上臂 130px、前臂 190px（成人前臂≈0.63 肩寬，
// 這裡故意給偏長的 0.95 代表手臂朝向鏡頭外側伸展）
const sh = P(100, 100), eb = P(120, 228), wr = P(150, 416);   // upper 130, fore 190

// 這是修掉的那個：校正值被汙染成 40px。舊版用 fore/calib.forearm > 2.2 擋，
// 190/40 = 4.75 → 擋掉。現在 chainOK 根本不看 calib，所以擋不到。
calib = { forearm: 40 };
t('校正值壞成 40px，真手臂仍要成立', chainOK(sh, eb, wr, 200), true);

calib = { forearm: 200 };
t('校正值正常時結果一樣', chainOK(sh, eb, wr, 200), true);

calib = null;
t('完全沒校正值也要成立', chainOK(sh, eb, wr, 200), true);

// 上界還是要擋得住真的錯配
t('前臂 190 但肩寬只有 100（比值 1.9）要擋', chainOK(sh, eb, wr, 100), false);
t('上臂 130 但肩寬只有 80（比值 1.63）要擋',
  chainOK(sh, eb, P(130, 180), 80), false);

// 看不到兩肩就沒有尺規，不能亂擋 —— 手伸直朝鏡頭是最常用的動作
t('沒有肩寬（單肩入鏡）時不擋', chainOK(sh, eb, wr, 0), true);
t('手伸直朝鏡頭，前臂投影剩 8px，不能擋',
  chainOK(sh, eb, P(124, 234), 200), true);

console.log('\n前臂估計量 —— 投影只會變短，所以要取高百分位不是中位數');

// 真實前臂 200px。一半的影格有前縮（120–200），再混入幽靈手臂的 30–50px。
const mk = () => {
  const v = [];
  for (let i = 0; i < 40; i++) v.push(200 - (i % 20) * 4);   // 真手，124–200
  for (let i = 0; i < 40; i++) v.push(30 + (i % 20));        // 幽靈，30–49
  return v;
};
const samples = mk();
const TRUE_LEN = 200;
const err = (v) => Math.abs(v - TRUE_LEN) / TRUE_LEN;
const med = median(samples), p80 = pctile(samples, 0.80);
console.log('  真實 ' + TRUE_LEN
          + '　中位數 ' + med + '（低估 ' + (err(med) * 100).toFixed(0) + '%）'
          + '　第80百分位 ' + p80 + '（低估 ' + (err(p80) * 100).toFixed(0) + '%）');
t('中位數被前縮與幽靈樣本系統性低估超過 3 成', err(med) > 0.30, true);
t('第80百分位誤差在 2 成以內', err(p80) < 0.20, true);

// 幽靈樣本占多數時（沒舉起的那隻手每幀都有、舉起的那隻偶爾掉點），
// 中位數會整個掉進幽靈那一群 —— 實測鎖在 40px 就是這個情形。
const ghostHeavy = [];
for (let i = 0; i < 20; i++) ghostHeavy.push(200 - (i % 20) * 4);
for (let i = 0; i < 60; i++) ghostHeavy.push(30 + (i % 20));
console.log('  幽靈占 75%：中位數 ' + median(ghostHeavy)
          + '　第80百分位 ' + pctile(ghostHeavy, 0.80));
t('幽靈占多數時中位數掉進幽靈群（<60）', median(ghostHeavy) < 60, true);

// 加上肩寬閘門之後，幽靈樣本根本進不來
const SW = 320;   // 肩寬 320 → 允許 96–512px
const gated = samples.filter((v) => v / SW >= FORE_VS_SHOULDER_LO
                                 && v / SW <= FORE_VS_SHOULDER_HI);
console.log('  過肩寬閘門後剩 ' + gated.length + '/' + samples.length
          + ' 筆，第80百分位 ' + pctile(gated, 0.80));
t('幽靈樣本全部被肩寬閘門擋掉', gated.every((v) => v >= 96), true);
t('真手樣本沒有被誤擋', gated.length, 40);

console.log('\nTracked —— 鎖定前的值不可以被權重套兩次');

const trk = Tracked({ volatility: 'static', fallback: 0,
                      estimate: (v) => pctile(v, 0.80) });
for (let i = 0; i < 30; i++) trk.push(200);
// value = fallback×(1−w) + est×w = 0 + 200×0.5 = 100，raw = 200
console.log('  n=30 權重 ' + trk.weight + '　value ' + trk.value
          + '　raw ' + trk.raw);
t('未鎖定時 value 已經含權重（所以 recalc 不能再乘一次）',
  Math.abs(trk.value - trk.raw * trk.weight) < 1e-9, true);
t('raw 不含權重，等於真值', trk.raw, 200);

console.log(fails ? '\n' + fails + ' 項失敗' : '\n全部通過');
process.exit(fails ? 1 : 0);
