// 極簡 Gherkin 執行器（零相依）。
//
// 為什麼自己寫：這個專案刻意沒有 node_modules —— 整個 MVP 是一個 HTML
// 加一個 JS，拉進 cucumber 會比被測的東西還大。這裡只需要
// 功能／場景／場景大綱／例子／假設-當-那麼，兩百行寫得完。
//
// 分工：
//   features/*.feature        驗收條件，用領域語言寫，人看得懂
//   features/steps/*.steps.js 把每一句話接到 app.js 真正的函式
//   tests/*.test.js           函式層的單元測試（邊界、數值、不變量）
//
// 兩層都要有。Gherkin 保證「我們在做對的事」，單元測試保證「我們把事做對」。

const fs = require('fs');
const path = require('path');

// 繁中關鍵字（Gherkin 官方 zh-TW）
const KW = {
  feature:  ['功能'],
  background: ['背景'],
  scenario: ['場景', '劇本'],
  outline:  ['場景大綱', '劇本大綱'],
  examples: ['例子', '例'],
  given:    ['假設', '假如', '假定'],
  when:     ['當'],
  then:     ['那麼'],
  and:      ['而且', '並且', '同時'],
  but:      ['但是'],
};
const starts = (line, list) => list.find((k) => line.startsWith(k + ':') || line.startsWith(k + '：'));
const after = (line, kw) => line.slice(kw.length).replace(/^[:：]\s*/, '').trim();
const stepKw = (line) => {
  for (const kind of ['given', 'when', 'then', 'and', 'but']) {
    for (const k of KW[kind]) if (line.startsWith(k)) return { kind, text: line.slice(k.length).trim() };
  }
  return null;
};

function parse(text) {
  const feature = { name: '', background: [], scenarios: [] };
  let cur = null, mode = null, examples = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    let k;
    if ((k = starts(line, KW.feature)))    { feature.name = after(line, k); mode = 'feature'; continue; }
    if ((k = starts(line, KW.background))) { mode = 'background'; continue; }
    if ((k = starts(line, KW.outline)))    {
      cur = { name: after(line, k), steps: [], examples: [] };
      feature.scenarios.push(cur); mode = 'scenario'; continue;
    }
    if ((k = starts(line, KW.scenario)))   {
      cur = { name: after(line, k), steps: [], examples: null };
      feature.scenarios.push(cur); mode = 'scenario'; continue;
    }
    if ((k = starts(line, KW.examples)))   { mode = 'examples'; examples = []; cur.examples = examples; continue; }

    if (mode === 'examples' && line.startsWith('|')) {
      examples.push(line.split('|').slice(1, -1).map((c) => c.trim()));
      continue;
    }
    const st = stepKw(line);
    if (!st) continue;
    (mode === 'background' ? feature.background : cur.steps).push(st);
  }
  return feature;
}

// 把 <欄位> 換成例子表格那一列的值
const fill = (text, header, row) =>
  header.reduce((s, h, i) => s.split('<' + h + '>').join(row[i]), text);

// ── 步驟註冊 ──
const steps = [];
const define = (pattern, fn) => steps.push({ pattern, fn });
function match(text) {
  for (const s of steps) {
    const m = typeof s.pattern === 'string'
      ? (s.pattern === text ? [] : null)
      : text.match(s.pattern);
    if (m) return { fn: s.fn, args: m.slice ? m.slice(1) : [] };
  }
  return null;
}

// ── 執行 ──
const C = { dim:'\x1b[2m', g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', b:'\x1b[1m', 0:'\x1b[0m' };

function runFeature(file) {
  const feature = parse(fs.readFileSync(file, 'utf8'));
  console.log('\n' + C.b + '功能：' + feature.name + C[0] + C.dim + '  ' + path.basename(file) + C[0]);
  let pass = 0, fail = 0;

  const runOne = (name, stepList) => {
    console.log('  ' + C.b + '場景：' + name + C[0]);
    const world = {};
    let broken = false;
    for (const st of [...feature.background, ...stepList]) {
      const label = { given:'假設', when:'當', then:'那麼', and:'而且', but:'但是' }[st.kind];
      if (broken) { console.log('    ' + C.dim + '- ' + label + ' ' + st.text + C[0]); continue; }
      const hit = match(st.text);
      if (!hit) {
        console.log('    ' + C.y + '? ' + label + ' ' + st.text + '   ← 沒有對應的步驟定義' + C[0]);
        broken = true; fail++; continue;
      }
      try {
        hit.fn.call(world, ...hit.args, world);
        console.log('    ' + C.g + '✓ ' + C[0] + label + ' ' + st.text);
      } catch (e) {
        console.log('    ' + C.r + '✗ ' + label + ' ' + st.text + C[0]);
        console.log('      ' + C.r + (e && e.message ? e.message : String(e)) + C[0]);
        broken = true; fail++;
      }
    }
    if (!broken) pass++;
  };

  for (const sc of feature.scenarios) {
    if (sc.examples && sc.examples.length > 1) {
      const [header, ...rows] = sc.examples;
      for (const row of rows) {
        runOne(fill(sc.name, header, row),
               sc.steps.map((s) => ({ kind: s.kind, text: fill(s.text, header, row) })));
      }
    } else {
      runOne(sc.name, sc.steps);
    }
  }
  return { pass, fail };
}

function main() {
  const dir = path.join(__dirname, '..', 'features');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.feature')).sort();
  const stepsDir = path.join(dir, 'steps');
  for (const f of fs.readdirSync(stepsDir).filter((f) => f.endsWith('.js')).sort()) {
    require(path.join(stepsDir, f))(define);
  }
  let pass = 0, fail = 0;
  for (const f of files) {
    const r = runFeature(path.join(dir, f));
    pass += r.pass; fail += r.fail;
  }
  console.log('\n' + (fail ? C.r + fail + ' 個場景失敗，' + pass + ' 個通過' + C[0]
                           : C.g + pass + ' 個場景全部通過' + C[0]));
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main();
module.exports = { parse, define, runFeature };
