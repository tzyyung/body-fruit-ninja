// 從 app.js 抽出 SPRT 的軌跡確認（updateTracks / latch / rememberChain / llr），
// 用假的幾何與連續性餵它，看它會不會確認。
//
// 這支測的是 2026-10-09 的死鎖：
// 原本「Λ 掉到下界就清掉 chainHist」，而 continuity 又依賴 chainHist ——
// 沒有歷史 → 續=0 → 鏈✓續✗強✓ = −0.385（負的）→ Λ 釘死在下界 → 歷史再被清掉。
// 使用者端實測 32 筆取樣全部 續=false(0.00)、Λ=−2.99 一動也不動，
// 幾何完全正確也永遠爬不出來。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.error('抽不到 ' + name); process.exit(1); }
  return m[0].replace(/^  function/, 'function');
};
const rhs = (re, name) => {
  const code = grab(re, name);
  return eval('(' + code.slice(code.indexOf('=') + 1).replace(/;\s*$/, '') + ')');
};

const SPRT_ALPHA = 0.01, SPRT_BETA = 0.05;
const SPRT_A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);
const SPRT_B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));
const EV = rhs(/  const EV = \{[\s\S]*?\n  \};/, 'EV');
const llr = rhs(/  const llr = \(k, yes\) => \{[\s\S]*?\n  \};/, 'llr');
const SIDES = ['left', 'right'];
const ARM = ['shoulder', 'elbow', 'wrist'];
const CHAIN_MEM_MS = Number(src.match(/const CHAIN_MEM_MS = (\d+)/)[1]);
let MIN_SCORE = 0.2;

const track = { left: 0, right: 0 };
const confirmed = { left: false, right: false };
const chainHist = { left: null, right: null };
const evLast = { left: null, right: null };
const chainWhy = { left: null, right: null };

// 這一輪的情境由測試決定
let scenario = { chain: true, still: true };
const chainOK = () => scenario.chain;
const shoulderWidth = () => 200;
// 真實的 continuity 只在「有歷史且位置接近」時才 > 0.25。
// 人站著不動 → 有歷史就接得上；沒有歷史一定是 0。
const continuity = (side) => (chainHist[side] && scenario.still) ? 0.95 : 0;

eval(grab(/  function latch\(side\) \{[\s\S]*?\n  \}/, 'latch'));
eval(grab(/  function rememberChain\(side, kp, now\) \{[\s\S]*?\n  \}/, 'rememberChain'));
eval(grab(/  function updateTracks\(kp, now\) \{[\s\S]*?\n  \}\n/, 'updateTracks'));

const kpGood = () => {
  const o = {};
  for (const sd of SIDES) for (const pt of ARM) o[sd + '_' + pt] = { x: 100, y: 100, score: 0.6 };
  return o;
};

let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  期望 ' + want + ' 得到 ' + got);
};
const reset = () => {
  track.left = track.right = 0;
  confirmed.left = confirmed.right = false;
  chainHist.left = chainHist.right = null;
};
const run = (frames) => {
  let now = 1000;
  for (let i = 0; i < frames; i++) { updateTracks(kpGood(), now); now += 33; }
};

console.log('SPRT 上界 ' + SPRT_A.toFixed(2) + '　下界 ' + SPRT_B.toFixed(2));
console.log('一幀的證據增量：');
for (const c of [true, false]) for (const o of [true, false]) for (const g of [true, false]) {
  const d = llr('chain', c) + llr('cont', o) + llr('strong', g);
  console.log('  鏈' + (c ? '✓' : '✗') + ' 續' + (o ? '✓' : '✗') + ' 強' + (g ? '✓' : '✗')
            + '  ' + (d >= 0 ? '+' : '') + d.toFixed(3));
}

console.log('\n站著不動、幾何完全正確 —— 一定要確認得了');
reset(); scenario = { chain: true, still: true };
run(10);
console.log('  10 幀後 Λ=' + track.left.toFixed(2) + ' confirmed=' + confirmed.left);
t('10 幀內要確認', confirmed.left, true);

console.log('\n從下界起步（上一輪被判掉過）—— 還是要爬得出來');
reset(); scenario = { chain: true, still: true };
track.left = track.right = SPRT_B;
confirmed.left = confirmed.right = false;
run(10);
console.log('  10 幀後 Λ=' + track.left.toFixed(2) + ' confirmed=' + confirmed.left);
t('被打到下界之後仍能恢復', confirmed.left, true);

console.log('\n幾何一直不成立 —— 要往丟棄端走，不能確認');
reset(); scenario = { chain: false, still: true };
run(30);
console.log('  30 幀後 Λ=' + track.left.toFixed(2) + ' confirmed=' + confirmed.left);
t('幾何不成立不該確認', confirmed.left, false);

console.log('\n確認之後揮一刀（連續性斷掉幾幀）—— 不可以當場失去身分');
reset(); scenario = { chain: true, still: true };
run(10);
scenario = { chain: true, still: false };
run(8);
console.log('  揮 8 幀後 Λ=' + track.left.toFixed(2) + ' confirmed=' + confirmed.left);
t('揮擊期間維持確認', confirmed.left, true);

console.log('\n歷史不可以被清掉（死鎖的來源）');
reset(); scenario = { chain: true, still: true };
track.left = SPRT_B;
updateTracks(kpGood(), 1000);
t('Λ 在下界時仍要記下歷史', chainHist.left !== null, true);

console.log(fails ? '\n' + fails + ' 項失敗' : '\n全部通過');
process.exit(fails ? 1 : 0);
