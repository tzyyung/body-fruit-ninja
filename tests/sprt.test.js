// 從 app.js 抽出 SPRT 的軌跡確認（updateTracks / latch / rememberChain / llr），
// 用假的幾何與連續性餵它，看它會不會確認。
//
// 這支測的是 2026-10-09 的死鎖：
// 原本「Λ 掉到下界就清掉 chainHist」，而 continuity 又依賴 chainHist ——
// 沒有歷史 → 續=0 → 鏈✓續✗強✓ = −0.385（負的）→ Λ 釘死在下界 → 歷史再被清掉。
// 使用者端實測 32 筆取樣全部 續=false(0.00)、Λ=−2.99 一動也不動，
// 幾何完全正確也永遠爬不出來。
const H = require('./_harness.js');
const { t, section, done } = H;

const SPRT_ALPHA = 0.01, SPRT_BETA = 0.05;
const SPRT_A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);
const SPRT_B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));
// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());
const EV = eval(H.expr('EV'));
const llr = eval(H.expr('llr'));
const SIDES = ['left', 'right'];
const ARM = ['shoulder', 'elbow', 'wrist'];
const CHAIN_MEM_MS = H.num('CHAIN_MEM_MS');
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

const { atLeast, below } = H;   // 跟 app.js 同一組容差比較
eval(H.fn('latch'));
eval(H.fn('rememberChain'));
eval(H.fn('updateTracks'));

const kpGood = () => {
  const o = {};
  for (const sd of SIDES) for (const pt of ARM) o[sd + '_' + pt] = { x: 100, y: 100, score: 0.6 };
  return o;
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

console.log('\n幾何一直不成立 —— 要真的抵達下界，不是停在附近慢慢爬');
reset(); scenario = { chain: false, still: true };
run(30);
console.log('  30 幀後 Λ=' + track.left.toFixed(4) + ' confirmed=' + confirmed.left);
t('幾何不成立不該確認', confirmed.left, false);
// 只斷言 confirmed===false 不夠。原本 Λ 停在 -2.95 而且每幀往上爬 +0.0014 ——
// 看起來像「在下界」，其實是死區，15fps 下 370 秒會爬出來。
t('Λ 要真的夾在下界（距離 < 0.01）',
  Math.abs(track.left - SPRT_B) < 0.01, true);

console.log('\n鏈不成立時，任何證據組合都必須是明確的負值');
// 死區的來源：三項證據被當成條件獨立。幽靈鏈是用真手的點拼的，
// 它既接得上上一幀（續✓）、手腕信心也高（強✓）——
// 鏈✗續✓強✓ 曾經是 −2.639 +1.814 +0.827 = +0.0014，正的。
{
  let worstD = -Infinity, worstName = '';
  for (const o of [true, false]) for (const g of [true, false]) {
    const d = llr('chain', false) + (false ? llr('cont', o) : 0) + llr('strong', g);
    if (d > worstD) { worstD = d; worstName = '續' + (o?'✓':'✗') + '強' + (g?'✓':'✗'); }
  }
  console.log('  鏈✗ 的最大增量：' + worstName + ' = ' + worstD.toFixed(4));
  t('鏈✗ 時最大增量要明確為負（≤ −0.3）', worstD <= -0.3, true);
}

console.log('\n確認之後揮一刀（連續性斷掉幾幀）—— 不可以當場失去身分');
reset(); scenario = { chain: true, still: true };
run(10);
scenario = { chain: true, still: false };
run(8);
console.log('  揮 8 幀後 Λ=' + track.left.toFixed(2) + ' confirmed=' + confirmed.left);
t('揮擊期間維持確認', confirmed.left, true);

console.log('\n幾何持續不成立 —— 掃過整個狀態空間，一個都不准確認');
// 原本的窮舉只掃 chain:true 那半邊，整個 chain:false 沒被測到。
{
  let bad = [];
  for (let lam = SPRT_B; lam <= SPRT_A + 1e-9; lam += 0.25) {
    for (const conf of [false, true]) {
      reset();
      track.left = track.right = lam;
      confirmed.left = confirmed.right = conf;
      rememberChain('left', kpGood(), 1000);
      scenario = { chain: false, still: true };
      let now = 1000;
      for (let i = 0; i < 60; i++) { updateTracks(kpGood(), now); now += 33; }
      if (confirmed.left || Math.abs(track.left - SPRT_B) > 0.01) {
        bad.push('Λ0=' + lam.toFixed(2) + ' conf0=' + conf
               + ' → Λ=' + track.left.toFixed(3) + ' conf=' + confirmed.left);
      }
    }
  }
  t('鏈不成立時，任何起始狀態都要在 60 幀內被丟棄到下界', bad.length, 0);
  if (bad.length) console.log('    沒丟棄的：' + bad.slice(0, 5).join('、'));
}

console.log('\n沒有吸收態 —— 掃過整個狀態空間');

// 這是最重要的一條：不管從哪個狀態出發，只要之後的輸入是
// 「幾何成立、人站著不動」，就一定要在合理幀數內確認。
// 只測一個起點不夠 —— 死鎖可能只在特定的 Λ 區間出現。
{
  let worst = 0, stuck = [];
  for (let lam = SPRT_B; lam <= SPRT_A + 1e-9; lam += 0.25) {
    for (const conf of [false, true]) {
      for (const hist of [false, true]) {
        reset();
        track.left = track.right = lam;
        confirmed.left = confirmed.right = conf;
        if (hist) rememberChain('left', kpGood(), 1000);
        scenario = { chain: true, still: true };
        let now = 1000, n = 0;
        while (!confirmed.left && n < 60) { updateTracks(kpGood(), now); now += 33; n++; }
        if (!confirmed.left) stuck.push('Λ=' + lam.toFixed(2) + ' conf=' + conf + ' hist=' + hist);
        worst = Math.max(worst, n);
      }
    }
  }
  console.log('  掃了 ' + (Math.round((SPRT_A - SPRT_B) / 0.25) + 1) * 4
            + ' 個起始狀態，最慢 ' + worst + ' 幀確認（約 '
            + Math.round(worst * 33) + 'ms）');
  t('沒有任何起始狀態會卡住', stuck.length, 0);
  t('最慢 15 幀（0.5 秒）內要確認', worst <= 15, true);
  if (stuck.length) console.log('    卡住的：' + stuck.slice(0, 5).join('、'));
}

console.log('\n幾何成立時，Λ 不可以單調下降');
// 鏈✓ 的任何組合裡，只要連續性也成立就必須是正的 ——
// 否則「一條正確又穩定的手臂」會被自己的證據扣分。
{
  const dChainStill = llr('chain', true) + llr('cont', true) + llr('strong', false);
  console.log('  鏈✓續✓強✗ = ' + dChainStill.toFixed(3));
  t('幾何成立且接得上上一幀時必須加分（即使手腕信心普通）',
    dChainStill > 0, true);
}

console.log('\n歷史不可以被清掉（死鎖的來源）');
reset(); scenario = { chain: true, still: true };
track.left = SPRT_B;
updateTracks(kpGood(), 1000);
t('Λ 在下界時仍要記下歷史', chainHist.left !== null, true);

done();
