// kanasim の monophone(単音素)距離テーブル(mono_hmm)から、soramimic 本番の
// 類似度行列 data/simVowelsMonoTie.json / data/simConsonantsMonoTie.json を生成する。
//
// ねらい(#102):
//   既存の simVowelsSimple / simConsonantsSimple は biphone(文脈依存)音素ベースで、
//   「同じ母音・違う文脈」と「違う母音」の分布が重なる。このため母音ロックは
//   getParam() の SAME_VOWEL_REWARD 掛け算ハックに頼るしかなく、スライダー
//   (vowelRatio)の直感性を壊していた。
//   ここでは行列のキー(文脈ラベル)はそのままに、値を「コア音素タイブレーク」方式へ
//   差し替える:
//     - コア音素が一致(母音= split("-").pop() / 子音= split("+")[0])→ 0
//     - 母音のみ: 長短同一母音ペア(例 "a" vs "a:")と N↔q(ン↔ッ)、両方向 → 20(準一致帯)
//     - 不一致 → 70 + norm10(hmm距離)  (norm10: 各行列の異コアペア距離を[0,10]へ線形正規化)
//   値域が {0} ∪ {20} ∪ [70,80] になるので「まず一致個数、質は同数時のタイブレーク」
//   という意味論が母音・子音で統一され、appCore の ×2r/×2(1-r) スケーリングで
//   vowelRatio が純粋な母音/子音の重みになる。lib は無改変(鉄則1)。
//
// 長短母音の準一致帯 20 について(#102 実機診断):
//   当初は長短母音(a↔a:)も完全な別母音と同格(70+ε)にしていたが、旧実装では
//   bigram距離+isSameVowel割引により「イ vs ニー」が~13と近く、長音の多い語彙
//   (ポケモン等)で母音ロックが壊れる劣化が実機で発覚した(シタイ→ヒバニーでなく
//   オタチが1位になる等)。長短同一母音をコスト20の準一致帯に置くことで
//   「完全一致(0) > 長短違い(20) > 別母音(70+)」の3段構えになり、実測で母音一致率が
//   回復する(プレースホルダ文で90→95〜100%、umi_baseball は劣化ゼロ+定性良化)。
//
// hmm距離は非対称(d[p1][p2] ≠ d[p2][p1])なのでそのまま使う。
//
// 使い方: node tools/build-mono-similarity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data/source/kanasim');

const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// コア音素の取り出し(元行列のキーラベルから)
const vCore = (label) => label.split('-').pop();   // "b-a:" -> "a:"
const cCore = (label) => label.split('+')[0];       // "ch+a" -> "ch"

// kanasim monophone CSV(phonome1,phonome2,distance)を core\tcore -> 距離 の Map に読む
function loadMonoCsv(file) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lines = text.trim().split('\n').slice(1); // ヘッダを飛ばす
  const d = new Map();
  for (const line of lines) {
    const [p1, p2, dist] = line.split(',');
    d.set(p1 + '\t' + p2, Number(dist));
  }
  return d;
}

// 異コアペア距離の[min,max](対角=同一コアは除く)
function offDiagRange(d) {
  let mn = Infinity, mx = -Infinity;
  for (const [k, v] of d) {
    const [a, b] = k.split('\t');
    if (a !== b) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  }
  return { mn, mx };
}

// 準一致帯(コスト20)に置く母音コアペアか(#102 実測):
// - 長短同一母音(a↔a: 等)。ベースは末尾の":"を除いた一致で判定
// - N↔q(ン↔ッ)。DPの長音変換で「カン」「カー」等が同一視される一方で
//   ン vs ッ だけ完全な別母音(70+ε)なのは一貫しないため両方向20にする。
//   実測でッ位置にン候補(マッテル→ハンテール等)が競合可能になり、他入力は劣化ゼロ。
//   ※ sp や長音・短母音との組は20にしない(N/qを母音と20にする案は
//     ン・ッ濃度の高い入力で母音一致率が20〜30pt劣化することが実測で判明し不採用)
function isSemiMatchPair(c1, c2) {
  if (c1 === c2) return false;
  if ((c1 === 'N' && c2 === 'q') || (c1 === 'q' && c2 === 'N')) return true;
  const b1 = c1.replace(/:$/, ''), b2 = c2.replace(/:$/, '');
  return b1 === b2 && 'aiueo'.includes(b1);
}

// 元行列 m(文脈ラベルのキー集合)を保ったまま、値をタイブレーク方式へ差し替える。
// semiMatchCost を渡すと(母音行列)、準一致ペア(isSemiMatchPair)をそのコストにする
function buildTie(m, coreFn, d, semiMatchCost = null) {
  const { mn, mx } = offDiagRange(d);
  const out = {};
  for (const k1 in m) {
    out[k1] = {};
    for (const k2 in m[k1]) {
      const c1 = coreFn(k1), c2 = coreFn(k2);
      if (c1 === c2) { out[k1][k2] = 0; continue; }
      if (semiMatchCost !== null && isSemiMatchPair(c1, c2)) {
        out[k1][k2] = semiMatchCost;
        continue;
      }
      const val = d.get(c1 + '\t' + c2);
      if (val === undefined) throw new Error(`kanasim CSVに距離がありません: ${c1},${c2}`);
      out[k1][k2] = 70 + ((val - mn) / (mx - mn)) * 10;
    }
  }
  return out;
}

// 生成物の検証: 対角・同一コア=0、(母音)準一致ペア(長短・N↔q)=semiMatchCost、
// その他の異コア∈[70,80]、キー集合が元行列と完全一致
function validate(name, src, out, coreFn, semiMatchCost = null) {
  const srcKeys = Object.keys(src);
  const outKeys = Object.keys(out);
  if (srcKeys.length !== outKeys.length) {
    throw new Error(`${name}: 行キー数が不一致 ${srcKeys.length} != ${outKeys.length}`);
  }
  for (const k1 of srcKeys) {
    if (!(k1 in out)) throw new Error(`${name}: 行キー欠落 ${k1}`);
    const srcCols = Object.keys(src[k1]);
    const outCols = Object.keys(out[k1]);
    if (srcCols.length !== outCols.length) {
      throw new Error(`${name}: 列キー数が不一致 (${k1})`);
    }
    for (const k2 of srcCols) {
      if (!(k2 in out[k1])) throw new Error(`${name}: 列キー欠落 ${k1},${k2}`);
      const v = out[k1][k2];
      const c1 = coreFn(k1), c2 = coreFn(k2);
      if (c1 === c2) {
        if (v !== 0) throw new Error(`${name}: 同一コアが0でない ${k1},${k2} = ${v}`);
      } else if (semiMatchCost !== null && isSemiMatchPair(c1, c2)) {
        if (v !== semiMatchCost) {
          throw new Error(`${name}: 準一致ペアが${semiMatchCost}でない ${k1},${k2} = ${v}`);
        }
      } else if (!(v >= 70 && v <= 80)) {
        throw new Error(`${name}: 異コアが[70,80]外 ${k1},${k2} = ${v}`);
      }
    }
    // 対角(自分自身)は必ず0
    if (out[k1][k1] !== 0) throw new Error(`${name}: 対角が0でない ${k1} = ${out[k1][k1]}`);
  }
  const off = [];
  let semiPairs = 0;
  for (const k1 of srcKeys) for (const k2 of Object.keys(out[k1])) {
    const c1 = coreFn(k1), c2 = coreFn(k2);
    if (c1 === c2) continue;
    if (semiMatchCost !== null && isSemiMatchPair(c1, c2)) { semiPairs++; continue; }
    off.push(out[k1][k2]);
  }
  const min = Math.min(...off), max = Math.max(...off);
  const ls = semiMatchCost !== null ? ` 準一致ペア(長短・N↔q)=${semiPairs}件(コスト${semiMatchCost})` : '';
  console.log(`  ${name}: rows=${srcKeys.length} 異コア値 min=${min.toFixed(3)} max=${max.toFixed(3)} (期待 min=70, max=80)${ls}`);
}

function main() {
  const vSrc = loadJson('data/simVowelsSimple.json');
  const cSrc = loadJson('data/simConsonantsSimple.json');
  const dV = loadMonoCsv('distance_vowels_mono_hmm.csv');
  const dC = loadMonoCsv('distance_consonants_mono_hmm.csv');

  const SEMI_MATCH_COST = 20; // 長短同一母音・N↔q の準一致帯(#102 実機診断)
  const vOut = buildTie(vSrc, vCore, dV, SEMI_MATCH_COST);
  const cOut = buildTie(cSrc, cCore, dC); // 子音は長短・ン/ッの概念がないので従来どおり

  console.log('検証:');
  validate('vowels', vSrc, vOut, vCore, SEMI_MATCH_COST);
  validate('consonants', cSrc, cOut, cCore);

  fs.writeFileSync(path.join(ROOT, 'data/simVowelsMonoTie.json'), JSON.stringify(vOut));
  fs.writeFileSync(path.join(ROOT, 'data/simConsonantsMonoTie.json'), JSON.stringify(cOut));
  console.log('書き出し: data/simVowelsMonoTie.json, data/simConsonantsMonoTie.json');
}

main();
