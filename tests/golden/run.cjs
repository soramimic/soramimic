'use strict';
// アルゴリズム出力のゴールデンテスト(kuromojiトークナイザ、完全オフライン)。
//   実行:   node tests/golden/run.cjs
//   再記録: node tests/golden/run.cjs --record   (期待値を更新する。オフライン)
const fs = require('fs');
const path = require('path');
const cases = require('./cases.cjs');

const ROOT = path.resolve(__dirname, '../..');

const RECORD = process.argv.includes('--record');

// harness-lib がグローバルconsoleを黙らせるため、本物をここで確保しておく
const print = console.log.bind(console);
const printError = console.error.bind(console);
const EXPECTED_DIR = path.join(__dirname, 'expected');

function loadLyricLines(rel, maxLines) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return text
    .split(/\r\n|\n|\r/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, maxLines);
}

// キー順を固定して安定した JSON 表現にする
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k]);
    return out;
  }
  return value;
}

async function main() {
  const { buildApp } = await import('./harness-lib.mjs');
  const harness = await buildApp();
  let failed = 0;

  for (const c of cases) {
    const phrases = c.inlinePhrases || loadLyricLines(c.lyric, c.maxLines);
    const db = harness.buildWordlist(c.wordlist);
    const started = Date.now();
    const results = await harness.generate(phrases, db, { ...c.param });
    const elapsed = Date.now() - started;

    const actual = JSON.stringify(normalize({ phrases, results }), null, 1) + '\n';
    const expectedPath = path.join(EXPECTED_DIR, c.name + '.json');

    if (RECORD) {
      fs.mkdirSync(EXPECTED_DIR, { recursive: true });
      fs.writeFileSync(expectedPath, actual);
      print(`[record] ${c.name} (${elapsed}ms)`);
      continue;
    }

    const expected = fs.readFileSync(expectedPath, 'utf8');
    if (actual === expected) {
      print(`[ok] ${c.name} (${elapsed}ms)`);
    } else {
      failed += 1;
      const actualPath = path.join(EXPECTED_DIR, c.name + '.actual.json');
      fs.writeFileSync(actualPath, actual);
      printError(`[FAIL] ${c.name}: 出力が期待値と一致しません。`);
      printError(`  diff ${path.relative(ROOT, expectedPath)} ${path.relative(ROOT, actualPath)}`);
    }
  }

  if (failed > 0) {
    printError(`${failed}/${cases.length} 件失敗`);
    process.exit(1);
  }
  print(`全${cases.length}件一致`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
