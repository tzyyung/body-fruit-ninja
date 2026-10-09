// 懸停圓圈在畫布尺寸改變之後還在不在原來的地方。
//
// 2026-10-09 Android 回報：「出現圓圈但很快就又消失了」，而且
// WebGPU 不會、WebGL 會。差別在幀率 —— 高解析看門狗在 fps 連續 3 秒
// 低於 45 時會把 renderScale 降回 1、重設 cv.width/height。
// 圓圈如果存的是絕對像素，就會留在舊尺寸算出來的位置上。
const H = require('./_harness.js');
const { t, section, done, near } = H;

// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());

// 假畫布。sizeCanvas 實際做的事就是改這兩個數字。
const cv = { width: 640, height: 480 };
const px = (r) => r * cv.width;
const py = (r) => r * cv.height;

let hoverBtns = [];
const beginPlay = () => {};
eval(H.fn('showStartBtn'));
const btnAt = eval(H.expr('btnAt'));

// 手機實測的形狀：devicePixelRatio 2.6、canvas 顯示寬約 377、相機 640×480
//   → renderScale = min(2, 377×2.6/640) = 1.53
const SCALE = 1.53;
const big = { w: Math.round(640 * SCALE), h: Math.round(480 * SCALE) };

section('看門狗把畫布縮回去之後，圓圈要還在同一個相對位置');

cv.width = big.w; cv.height = big.h;
showStartBtn();
const before = btnAt(hoverBtns[0]);
t('高解析下圓心在畫面水平正中', near(before.x / cv.width, 0.5, 0.001), true);
t('高解析下圓心在畫面 58% 高', near(before.y / cv.height, 0.58, 0.001), true);

// 看門狗：renderScale 1.53 → 1
cv.width = 640; cv.height = 480;
const after = btnAt(hoverBtns[0]);

t('縮回去之後還是在水平正中', near(after.x / cv.width, 0.5, 0.001), true);
t('縮回去之後還是在 58% 高', near(after.y / cv.height, 0.58, 0.001), true);
t('圓圈整個還在畫面裡', after.y + after.r <= cv.height && after.x + after.r <= cv.width, true);
t('半徑跟著縮', near(after.r / before.r, 1 / SCALE, 0.01), true);

section('命中判定跟畫出來的是同一個圓');

// 這是「單一入口」的本意：畫跟打都問 btnAt，不能各算各的
const box = btnAt(hoverBtns[0]);
const onCenter = { x: box.x, y: box.y };
const justOutside = { x: box.x + box.r + 2, y: box.y };
t('圓心算命中', dist(onCenter, box) <= box.r, true);
t('圓外不算命中', dist(justOutside, box) <= box.r, false);

done();
