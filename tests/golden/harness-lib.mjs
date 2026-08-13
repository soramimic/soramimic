// frontend/src/lib/ (ES modules) をゴールデンテストのインターフェースで
// 動かすハーネス。トークナイザは本番と同じ kuromoji(完全オフライン)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export async function buildApp() {
  // 移植元のコードは console.log を多用するのでテスト中は黙らせる
  const silent = () => {};
  for (const k of ['log', 'time', 'timeEnd', 'timeLog', 'warn']) console[k] = silent;

  const libUrl = pathToFileURL(path.join(ROOT, 'frontend/src/lib/index.js')).href;
  const { createSoramimic } = await import(libUrl);

  const frontendRequire = createRequire(
    pathToFileURL(path.join(ROOT, 'frontend/package.json')).href);
  const kuromoji = frontendRequire('kuromoji');
  const dicPath = path.join(ROOT, 'frontend/node_modules/kuromoji/dict');
  const rawTokenizer = await new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, tk) => (err ? reject(err) : resolve(tk)));
  });
  const { KuromojiTokenizer } = await import(
    pathToFileURL(path.join(ROOT, 'frontend/src/lib/kuromojiTokenizer.js')).href);
  const mecab = KuromojiTokenizer(rawTokenizer);

  // 本番(appCore.js)と同じ配線: monophoneタイブレーク行列(#102)を読み、
  // 「音の合わせ方」(param.VOWEL_RATIO = r)ごとに 母音×2r・子音×2(1-r) へ
  // スケールしたappを作る。r未指定は本番既定の 0.8。
  const baseInputs = {
    kanjiDict: loadJson('data/kanjiyomi.json'),
    englishDict: loadJson('data/english-kana.json'),
    romanTree: loadJson('data/tree_roma2kana.json'),
    kana2phonon: loadJson('data/kana2phonon.json'),
    tokenizeSentenses: mecab.tokenize,
    getYomi: mecab.getYomi,
  };
  const vowelSimilarity = loadJson('data/simVowelsMonoTie.json');
  const consonantSimilarity = loadJson('data/simConsonantsMonoTie.json');

  function scaleMatrix(m, f) {
    const out = {};
    for (const k1 in m) {
      out[k1] = {};
      for (const k2 in m[k1]) out[k1][k2] = m[k1][k2] * f;
    }
    return out;
  }
  const apps = new Map();
  function appFor(vowelRatio = 0.8) {
    const r = Math.min(0.9, Math.max(0.1, Number(vowelRatio) || 0.8));
    const key = r.toFixed(2);
    if (!apps.has(key)) {
      apps.set(key, createSoramimic({
        ...baseInputs,
        vowelSimilarity: scaleMatrix(vowelSimilarity, 2 * r),
        consonantSimilarity: scaleMatrix(consonantSimilarity, 2 * (1 - r)),
      }));
    }
    return apps.get(key);
  }
  const baseApp = appFor(0.8); // 単語リストのパースはどのappでも同じ

  function buildWordlist(spec) {
    const text = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
    if (spec.dbtype === 'tidy') {
      return baseApp.wordList.parseTidy(text, spec.where);
    }
    return baseApp.wordList.parsePlain(text);
  }

  function generate(phrases, db, param, weightsPerLine = null) {
    const app = appFor(param && param.VOWEL_RATIO);
    return new Promise((resolve) => {
      app.soramimiMaker.generate(phrases, db, param, null, resolve, weightsPerLine);
    });
  }

  return { app: baseApp, buildWordlist, generate };
}
