// 水果與炸彈的飛行。
//
// 炸彈要飛得比水果慢，但**軌跡形狀不能變** —— 玩家靠落點預期決定手往哪躲，
// 形狀變了就等於換了一種物件，反而更容易誤砍。
// 做法是等價的時間縮放：速度 ×k、重力 ×k²。
const H = require('./_harness.js');
const { t, section, near, done } = H;

const GRAVITY_F = H.num('GRAVITY_F');
const BOMB_SLOW = H.num('BOMB_SLOW');
const CANVAS_W = 640, CANVAS_H = 480;
const px = (r) => r * CANVAS_W;

// 照 app.js 的 spawn + stepFruits 跑一顆物件的彈道
function fly(slow, vy0, vx0) {
  const g = px(GRAVITY_F) * slow * slow;
  let x = 320, y = CANVAS_H, vx = vx0 * slow, vy = vy0 * slow;
  let tt = 0, apexY = y;
  const dt = 1 / 480;
  while (y < CANVAS_H + 60 && tt < 20) {
    vy += g * dt; x += vx * dt; y += vy * dt; tt += dt;
    if (y < apexY) apexY = y;
  }
  return { air: tt, apexRise: CANVAS_H - apexY, landX: x };
}

const VY0 = -px(1.19), VX0 = 80;
const fruit = fly(1, VY0, VX0);
const bomb  = fly(BOMB_SLOW, VY0, VX0);

console.log('k = ' + BOMB_SLOW);
console.log('  水果：滯空 ' + fruit.air.toFixed(2) + 's　最高點 '
          + fruit.apexRise.toFixed(0) + 'px　落點 x ' + fruit.landX.toFixed(0));
console.log('  炸彈：滯空 ' + bomb.air.toFixed(2) + 's　最高點 '
          + bomb.apexRise.toFixed(0) + 'px　落點 x ' + bomb.landX.toFixed(0));

section('軌跡形狀不可以變');
t('最高點高度一樣（v²/2g 與 k 無關）', near(bomb.apexRise, fruit.apexRise, 2), true);
t('落點一樣（水平距離 vx·t 與 k 無關）', near(bomb.landX, fruit.landX, 3), true);

section('但要變慢');
const ratio = bomb.air / fruit.air;
console.log('  滯空倍率 ' + ratio.toFixed(2) + '　多出 '
          + ((ratio - 1) * 100).toFixed(0) + '% 的反應時間');
t('滯空時間正好是 1/k 倍', near(ratio, 1 / BOMB_SLOW, 0.02), true);
t('反應時間至少多三成', ratio >= 1.3, true);
t('但不要慢過兩倍（在畫面上待越久，被亂揮的刀掃到的機會也越多）', ratio <= 2.0, true);

section('引信聲要跟著拉長');
t('引信長度有除以 k（不然聲音先停了炸彈還在飛）',
  H.src.includes('startFuse(2.2 / slow)'), true);
console.log('  引信 ' + (2.2 / BOMB_SLOW).toFixed(2) + 's　炸彈滯空 '
          + bomb.air.toFixed(2) + 's');
t('引信不短於滯空時間', 2.2 / BOMB_SLOW >= bomb.air - 0.1, true);

done();
