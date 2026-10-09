// 筆畫的連接與長度。
//
// 這支測的是 2026-10-09 使用者回報的「手畫圓型時會漏揮動」：
// 掉一幀就把 prev 清成 null → 下一點 linked 必然 false →
// activeRun 從那裡切開 → 整段筆畫只剩幾個點 → fit.len 腰斬 → 揮了不算一刀。
// 而 MAX_LINK_MS / maxLink 這兩個「容忍掉點」的常數被整個繞過。
const H = require('./_harness.js');
const { t, section, done } = H;

const F = eval('(' + H.src.match(/  const F = \{[\s\S]*?\n  \}/)[0].replace(/^  const F = /, '') + ')');
const MAX_LINK_MS = H.num('MAX_LINK_MS');
let CANVAS_W = 640;
const px = (r) => r * CANVAS_W;
const maxSpeedPx = () => 151 * H.num('SPEED_FOREARM');   // 校正鎖定後的跳動上限
eval(H.fn('linkInfo'));
eval(H.fn('activeRun'));
eval(H.fn('fitLine'));

const B = (x, y) => ({ tx: x, ty: y });
const P = (x, y, t) => ({ tx: x, ty: y, t });

console.log('連線上限 ' + MAX_LINK_MS + 'ms / ' + px(F.maxLink).toFixed(0) + 'px'
          + '　揮擊門檻（未校正）' + px(F.slashMin).toFixed(0) + 'px');

section('linkInfo —— 兩道各自獨立');

t('33ms、20px → 接得上', linkInfo(P(100, 100, 0), B(120, 100), 33).linked, true);
t('隔 300ms（> 260）→ 不接', linkInfo(P(100, 100, 0), B(120, 100), 300).linked, false);
// 跳動上限現在是速度：前臂 151 × 28 = 4228px/s，33ms 內最多 140px
t('33ms 內跳 300px（> 140）→ 不接', linkInfo(P(100, 100, 0), B(400, 100), 33).linked, false);
// 掉一幀（30fps 下約 66ms）還在容忍範圍內，這正是常數存在的理由
t('掉一幀（66ms、60px）→ 要接得上', linkInfo(P(100, 100, 0), B(160, 100), 66).linked, true);
t('掉三幀（132ms、120px）→ 還是要接得上',
  linkInfo(P(100, 100, 0), B(220, 100), 132).linked, true);
t('掉八幀（264ms）→ 超過時間上限，不接',
  linkInfo(P(100, 100, 0), B(160, 100), 264).linked, false);

section('掉點不可以把整段筆畫砍斷');

// 一段 280ms、30fps 的直線揮擊：9 個點、每幀 30px、總長 240px。
// 刀刃抓到率 78% ⇒ 第 4 幀掉點。掉的那一幀不產生軌跡點，
// 但下一個點跟「掉點之前那一點」相隔 66ms / 60px，兩道都過得了。
function buildTrail(dropIdx) {
  const tr = [];
  let prev = null;
  for (let i = 0; i < 9; i++) {
    const now = i * 33;
    if (i === dropIdx) continue;                 // 這一幀沒有刀
    const b = B(100 + i * 30, 200);
    const linked = prev ? linkInfo(prev, b, now).linked : false;
    tr.push({ x: b.tx, y: b.ty, t: now, linked });
    prev = { tx: b.tx, ty: b.ty, t: now };       // ← 不清 prev
  }
  return tr;
}

const whole = buildTrail(-1);
const dropped = buildTrail(4);
const lenOf = (tr) => { const r = activeRun(tr); return { n: r.length, len: fitLine(r).len }; };
const a = lenOf(whole), b = lenOf(dropped);
console.log('  完整 9 幀：' + a.n + ' 點、fit.len ' + a.len.toFixed(0) + 'px');
console.log('  中間掉 1 幀：' + b.n + ' 點、fit.len ' + b.len.toFixed(0) + 'px');
t('掉一幀之後整段仍連著（點數只少 1）', b.n, a.n - 1);
t('掉一幀之後 fit.len 仍遠高於門檻', b.len > px(F.slashMin), true);

// 對照：舊的做法（掉點就把 prev 清掉）
function buildTrailOld(dropIdx) {
  const tr = [];
  let prev = null;
  for (let i = 0; i < 9; i++) {
    const now = i * 33;
    if (i === dropIdx) { prev = null; continue; }   // ← 舊行為
    const bb = B(100 + i * 30, 200);
    const linked = prev ? linkInfo(prev, bb, now).linked : false;
    tr.push({ x: bb.tx, y: bb.ty, t: now, linked });
    prev = { tx: bb.tx, ty: bb.ty, t: now };
  }
  return tr;
}
const old = lenOf(buildTrailOld(4));
console.log('  （舊做法：清掉 prev）' + old.n + ' 點、fit.len ' + old.len.toFixed(0) + 'px');
t('舊做法確實會把筆畫砍短（這條證明上面那兩條有意義）', old.n < b.n, true);

section('弧線的 fit.len 不會被低估到過不了門檻');

// 之前懷疑「畫圓時 fit.len 趨近 0」，模擬後不成立：
// 半徑 r 的圓，主軸投影長 = 直徑 2r。記下來免得下次又往這個方向猜。
for (const [name, mk] of [
  ['1/4 圓弧 r=150', (u) => [300 + 150 * Math.cos(u * Math.PI / 2), 300 + 150 * Math.sin(u * Math.PI / 2)]],
  ['半圓     r=150', (u) => [300 + 150 * Math.cos(u * Math.PI),     300 + 150 * Math.sin(u * Math.PI)]],
  ['整圈     r=150', (u) => [300 + 150 * Math.cos(u * 2 * Math.PI), 300 + 150 * Math.sin(u * 2 * Math.PI)]],
]) {
  const pts = [];
  for (let i = 0; i < 9; i++) { const [x, y] = mk(i / 8); pts.push({ x, y }); }
  const f = fitLine(pts);
  console.log('  ' + name + '：fit.len ' + f.len.toFixed(0)
            + 'px　直線度 ' + f.linearity.toFixed(3));
  t(name + ' 的 fit.len 過得了未校正門檻', f.len > px(F.slashMin), true);
}

done();
