// 測試共用樣板。
//
// 這些測試的做法是：用 regex 從 app.js 抽出函式原始碼，在測試檔裡 eval。
// 測的是**正在跑的那一份**，不是一份會跟著漂走的複本。
//
// 樣板集中在這裡，不要每個測試檔各抄一份 —— 抄出去的會各自漂走，
// app.js 的函式多一個相依就有某幾檔無聲壞掉。
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

const die = (msg) => { console.error('harness: ' + msg); process.exit(2); };

// 取 `  function name(...) {...}` 的原始碼。
// 回傳字串讓呼叫端自己 eval —— eval 出來的 function 宣告會綁在呼叫端的
// 作用域，才看得到測試檔裡準備的替身（stub）。
function fn(name) {
  // async 也要配得到 —— 漏掉的話錯誤訊息是「抽不到函式 X」，
  // 看起來像名字打錯，實際上是 harness 的洞（踩過：pullFile）。
  const re = new RegExp('  (?:async )?function ' + name + '\\([\\s\\S]*?\\n  \\}');
  const m = src.match(re);
  if (!m) die('抽不到函式 ' + name);
  return m[0].replace(/^ {2}(?:async )?function/, (x) => x.trim() === 'function' ? 'function' : 'async function');
}

// 取 `  const name = <運算式>;` 的右手邊，回傳**原始碼字串**（已包好括號）。
//
// 跟 fn() 一樣要由呼叫端自己 eval —— 在這裡 eval 的話，取出來的函式會閉包到
// harness 的作用域，看不到測試檔準備的替身（踩過：llr 參照的 EV 抓不到）。
// const 在 eval 裡又是 eval 自己的區塊作用域，所以不能直接照搬 fn() 的寫法，
// 要取右手邊的運算式。用法：const llr = eval(H.expr('llr'));
function expr(name) {
  const re = new RegExp('  const ' + name + ' = ([\\s\\S]*?\\n  \\};)');
  const m = src.match(re);
  if (!m) die('抽不到運算式 ' + name);
  return '(' + m[1].replace(/;\s*$/, '') + ')';
}

// app.js 裡「每個人都會用到」的基本運算（TAU / dist / dtSec）。
//
// 抽出來的函式只要用到其中一個，測試檔就會 ReferenceError —— 實測過：
// linkInfo 改用 dtSec() 之後 motion 和 stroke 兩檔同時紅。
// 與其每個測試檔各自補一行，不如在這裡給一個統一入口：
//   eval(H.core());
//
// 為什麼要把 const 換成 var：直接 eval 裡的 const/let 是 eval 自己的
// 區塊作用域，外面拿不到（harness 開頭那段註解講的就是這件事）。
// var 會掛到呼叫端的函式／模組作用域，所以取得出來。
const CORE = ['TAU', 'dist', 'dtSec'];
function core() {
  return CORE.map((name) => {
    const m = src.match(new RegExp('\\n  const ' + name + ' = (.*?);\\n'));
    if (!m) die('抽不到基本運算 ' + name);
    return 'var ' + name + ' = ' + m[1] + ';';
  }).join('\n');
}

// 取數字常數
function num(name) {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*([\\d.]+)'));
  if (!m) die('抽不到常數 ' + name);
  return Number(m[1]);
}

// ── 斷言 ──
let fails = 0, total = 0;

function section(title) { console.log('\n' + title); }

function t(name, got, want) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  期望 ' + want + ' 得到 ' + got);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 跟 app.js 同一組容差比較。測試與程式用不同的比較規則，
// 就會在邊界上得到不同結論，而那正是最需要測的地方。
const EPS = 1e-9;
const atLeast = (v, min) => v >= min - EPS;
const below   = (v, min) => v <  min - EPS;

let finished = false;
function done() {
  finished = true;
  console.log(fails ? '\n' + fails + '/' + total + ' 項失敗'
                    : '\n全部通過（' + total + ' 項）');
  process.exit(fails ? 1 : 0);
}

// 非同步測試如果 await 到一個永遠不 settle 的 promise，事件迴圈會空掉，
// node 就靜靜地以 0 離開 —— 整個檔變成「靜默通過」。
// 跑變異時實際踩到：把 raceSources 的「全部失敗就 reject」拿掉之後，
// 測試完全沒有反應，而且是綠的。
// 只有「用了斷言但沒收尾」才算 —— bdd.js 借 harness 取原始碼，
// 但它有自己的輸出與離開碼，不走 done()。
process.on('exit', (code) => {
  if (finished || code !== 0 || total === 0) return;
  console.log('\n沒有跑到 done() —— 有 promise 沒有 settle，或是中途 return 了');
  process.exitCode = 1;
});

module.exports = { src, fn, expr, core, num, section, t, near, atLeast, below, done };
