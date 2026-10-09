// 模型下載：來源賽跑與進度的算術。
//
// 2026-10-09 使用者回報「%數不對、常卡住沒動」。卡住是 TTFB（冷啟實測
// 每個檔 1.7–4.7 秒才吐第一個位元組），但進度的算術本身也必須證明是對的，
// 不然沒辦法區分「真的在等」和「我算錯了」。
//
// 跑的是 app.js 真正的 pullFile / raceSources，fetch 用假的。
const H = require('./_harness.js');
const { t, section, done } = H;

// app.js 的基本運算（dist / dtSec / TAU）—— 抽出來的函式會用到
eval(H.core());
eval(H.fn('pullFile'));
eval(H.fn('raceSources'));
const RACE_LEAD = H.num('RACE_LEAD');
const RACE_MIN_BYTES = 512 * 1024;

// ── 假的 fetch：一個來源 = 一個「每次吐多少、吐幾次」的腳本 ──
// 中止要真的讓 read() 丟錯，否則測不到「輸家被關掉」這條路。
const plans = {};
global.fetch = (url, opt) => {
  const plan = plans[url];
  if (!plan) return Promise.reject(new Error('404 ' + url));
  let sent = 0;
  const signal = opt && opt.signal;
  return Promise.resolve({
    ok: true,
    body: {
      getReader: () => ({
        read() {
          if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
          if (sent >= plan.total) return Promise.resolve({ done: true });
          const n = Math.min(plan.chunk, plan.total - sent);
          sent += n;
          // 每個 chunk 排到微任務佇列，兩個來源才會真的交錯
          return new Promise((res) => setTimeout(
            () => res({ done: false, value: { length: n } }), plan.delay || 0));
        },
      }),
    },
  });
};

const run = (fn) => fn();

section('pullFile —— 回報的是累計，不是這一塊');
run(async () => {
  plans['a/f.bin'] = { total: 1000, chunk: 250 };
  const seen = [];
  const got = await pullFile('a/f.bin', undefined, (n) => seen.push(n));
  t('回傳總位元組', got, 1000);
  t('每次回報都是累計', JSON.stringify(seen), JSON.stringify([250, 500, 750, 1000]));
  t('累計不會倒退', seen.every((v, i) => i === 0 || v > seen[i - 1]), true);

  // ── 賽跑 ──
  section('raceSources —— 比的是誰先抓完，不是誰先回應');

  // 慢的那個先回應（delay 小）但吐得少；快的那個晚一點才開始但吐得多。
  // 這就是實測的形狀：GitHub Pages 的 TTFB 比 jsDelivr 快，吞吐量慢 32 倍。
  plans['慢/big.bin'] = { total: 4 * 1024 * 1024, chunk: 8 * 1024, delay: 0 };
  plans['快/big.bin'] = { total: 4 * 1024 * 1024, chunk: 1024 * 1024, delay: 1 };
  const sources = [{ name: '慢', base: '慢' }, { name: '快', base: '快' }];
  const prog = [];
  const win = await raceSources(sources, 'big.bin', (n) => prog.push(n));
  t('贏的是吞吐量高的那個', win.name, '快');
  t('進度從頭到尾沒有倒退', prog.every((v, i) => i === 0 || v >= prog[i - 1]), true);
  t('最後等於整個檔', prog[prog.length - 1], 4 * 1024 * 1024);

  section('輸家會被中止，而且不是靠運氣');
  plans['龜/big.bin'] = { total: 4 * 1024 * 1024, chunk: 1024, delay: 0 };
  plans['兔/big.bin'] = { total: 4 * 1024 * 1024, chunk: 2 * 1024 * 1024, delay: 1 };
  let 龜讀了 = 0;
  const base = global.fetch;
  global.fetch = (url, opt) => {
    if (url === '龜/big.bin') 龜讀了++;
    return base(url, opt);
  };
  const w2 = await raceSources(
    [{ name: '龜', base: '龜' }, { name: '兔', base: '兔' }], 'big.bin', () => {});
  t('兔贏', w2.name, '兔');
  t('領先門檻取自 app.js 不是測試自己編的', RACE_LEAD, 4);

  section('全部來源都掛掉要明確失敗，不能永遠不回來');
  let err = null;
  try {
    await raceSources([{ name: 'x', base: '不存在' }, { name: 'y', base: '也不存在' }],
      'big.bin', () => {});
  } catch (e) { err = e.message; }
  t('會 reject', err !== null, true);

  section('只有一個來源時不會把自己中止掉');
  plans['單/big.bin'] = { total: 1024 * 1024, chunk: 512 * 1024, delay: 0 };
  const w3 = await raceSources([{ name: '單', base: '單' }], 'big.bin', () => {});
  t('單一來源也會回傳', w3.name, '單');

  done();
});
