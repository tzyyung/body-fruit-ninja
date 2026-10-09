// 命中範圍跟看得見的範圍要對得上 —— 尤其是會扣命的那個。
//
// 在真瀏覽器裡量過 emoji 字形的不透明像素（從中心射 36 個方位，
// 字級 61.1px = px(fruitR) × 1.8）：
//   🍉 中位 26.0px（最小 9.5、最大 31.5）
//   💣 中位 29.0px（最小 23.5、最大 36.5）
// 數字寫在這裡當基準，改字級或換 emoji 要重量一次。
const H = require('./_harness.js');
const { t, section, near, done } = H;

const F = eval('(' + H.src.match(/  const F = \{[\s\S]*?\n  \}/)[0].replace(/^  const F = /, '') + ')');
const PALM_PAD = H.num('PALM_PAD');
const W = 640;
const px = (r) => r * W;

// 瀏覽器實測的字形可見半徑（中位）
const SEEN = { '🍉': 26.0, '💣': 29.0 };

const fruitHit = px(F.fruitR) + px(PALM_PAD);
const bombHit  = px(F.bombR)  + px(PALM_PAD);
console.log('字級 ' + (px(F.fruitR) * 1.8).toFixed(1) + 'px');
console.log('  水果：判定 ' + fruitHit.toFixed(1) + 'px　看得見 ' + SEEN['🍉']
          + 'px　比值 ' + (fruitHit / SEEN['🍉']).toFixed(2));
console.log('  炸彈：判定 ' + bombHit.toFixed(1)  + 'px　看得見 ' + SEEN['💣']
          + 'px　比值 ' + (bombHit / SEEN['💣']).toFixed(2));

section('炸彈：看到什麼就是什麼');

// 會扣命的東西不可以有「看不見的致命環」。
t('炸彈的判定不可以大於看得見的輪廓', bombHit <= SEEN['💣'] + 0.5, true);
t('但也不能小太多（否則變成「明明砍到了卻沒反應」）',
  bombHit >= SEEN['💣'] * 0.9, true);
console.log('  隱形致命環 ' + (bombHit - SEEN['💣']).toFixed(1) + 'px'
          + '（修正前 ' + (fruitHit - SEEN['💣']).toFixed(1) + 'px）');
t('修正前的隱形致命環確實存在（這條證明上面兩條有意義）',
  fruitHit - SEEN['💣'] > 10, true);

section('水果：判定寬鬆是刻意的');

// 體感追蹤本來就會抖，容錯對玩家有利 ——「差一點也切到」不會讓人生氣。
t('水果的判定比看得見的大（容錯）', fruitHit > SEEN['🍉'], true);
t('但不要寬鬆到兩倍以上（會變成隔空切）', fruitHit / SEEN['🍉'] < 2.0, true);

section('炸彈要比水果嚴');

t('炸彈的判定半徑小於水果', px(F.bombR) < px(F.fruitR), true);
console.log('  面積比：炸彈判定 / 看得見 = '
          + Math.pow(bombHit / SEEN['💣'], 2).toFixed(2)
          + '　水果 = ' + Math.pow(fruitHit / SEEN['🍉'], 2).toFixed(2));

section('畫出來的危險圈要跟判定同一個值');

// 只鎖「半徑跟判定用同一個運算式」。
// 原本連後面的角度 0, 6.3 一起鎖進去 —— 那跟這條規則無關，
// 結果把 6.3 改成 TAU（整圓的單一來源）時這條就紅了，
// 等於用測試把一個不相干的寫法釘死。
t('drawFruits 畫的半徑跟判定用同一個運算式',
  H.src.includes('ctx.arc(f.x, f.y, f.R + px(PALM_PAD),'), true);
t('testSlices 用 f.R + pad 判定',
  H.src.includes('< f.R + pad'), true);

done();
