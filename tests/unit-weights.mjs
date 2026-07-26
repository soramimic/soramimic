// ユニット位置別の重み付きスコアリングのテスト。
//
// エンジンに「行ごと・ユニット位置ごとの重み」を渡せるオプションを足した(soramimic-python と
// 意味論を揃えるためのエンジン能力。Web UI はまだ重みを渡さないので実挙動は不変)。
// 検証するのは次の4点:
//   1. 省略時(および一様な重み)は従来と完全に同じ結果になること
//   2. 重みは行内で平均1に正規化され、不正な重みは「その行だけ重みなし」に落ちること
//   3. 重みを上げた位置で音が合う候補が勝つこと(候補選択・DP の両方)
//   4. ン/ッ/ー の変種でユニット数が変わっても、重みが元の音節に正しく対応すること
//
// 実行: node tests/unit-weights.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp } from "./golden/harness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { KanaToSyllable } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/lib/kanaToSyllable.js")).href);

const print = console.log.bind(console);

const PARAM = {
	VOWEL_RATIO: 0.8,
	VARIATION_COST: 0,
	SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 0,
	WORD_NUMBER_PENALTY: 20,
	DUPLICATE: true,
};

const h = await buildApp();
const { textAnalyzer, soramimiMaker, wordList } = h.app;

// harness-lib が console.warn を黙らせているので、警告の有無を数えられるように差し替える
let warnings = [];
console.warn = (...args) => { warnings.push(args.join(" ")); };
const countWarnings = (fn) => {
	warnings = [];
	const r = fn();
	return { result: r, warnings: warnings.slice() };
};

const simOf = (db, target, weights) => {
	const cands = soramimiMaker.getCandidates(db, target, PARAM, 50, weights);
	const sim = {};
	for (const c of cands) sim[c.surface] = c.sim;
	return sim;
};
const generate = (phrases, db, param, weightsPerLine) =>
	new Promise((resolve) => {
		soramimiMaker.generate(phrases, db, param, null, resolve, weightsPerLine);
	});
const surfacesOf = (results) => results.map((ws) => ws.map((w) => w.surface).join("+")).join(" / ");

// ---- 1. 変種の由来index(srcIndex): 各出力ユニットが元の何番目の音節から来たか ----
const k2s = KanaToSyllable();
for (const [syllables, expected] of [
	[["カ", "キ"], [[0, 1]]],
	// ン/ッ/ー はユニット数が変わる。どの変種でも由来indexが元音節を指すこと
	[["カン"], [[0, 0], [0], [0]]],
	[["カン", "コ"], [[0, 0, 1], [0, 1], [0, 1]]],
	[["カッ", "コ"], [[0, 0, 1], [0, 1], [0, 1]]],
	[["カー", "コ"], [[0, 1]]],
	[["ン", "カ"], [[0, 1], [1]]],
]) {
	const variations = k2s.getVariation(syllables);
	assert.deepEqual(variations.map((v) => v.srcIndex), expected,
		`srcIndex(${syllables.join("")})`);
	for (const v of variations) {
		assert.equal(v.srcIndex.length, v.length,
			`srcIndexはユニットと同じ長さ(${syllables.join("")} → ${v.join(",")})`);
		assert.ok(v.srcIndex.every((i) => i >= 0 && i < syllables.length),
			`srcIndexは元音節の範囲内(${syllables.join("")})`);
	}
}
print("[ok] 変種の各ユニットが元音節の位置を保持する(srcIndex)");

// ---- 2. 省略時・一様重みで結果が変わらないこと ----
const db = wordList.parsePlain(["カキ", "キカ", "カナカ", "カナキ", "カンカ"].join("\n"));
const kaka = textAnalyzer.yomiToSyllable("カカ");
assert.deepEqual(kaka, ["カ", "カ"], "「カカ」は2ユニット");

const base = simOf(db, kaka, undefined);
for (const weights of [null, undefined, [1, 1], [3, 3], [0.5, 0.5]]) {
	assert.deepEqual(simOf(db, kaka, weights), base,
		`一様な重みはスコアを変えない(${JSON.stringify(weights)})`);
}
print("[ok] 省略時・一様重み(スケール違いを含む)でスコア不変");

// 実歌詞でも、重み省略と一様重みで生成結果が一致すること(ゴールデンの追加確認)
const realDb = h.buildWordlist({
	file: "tests/golden/fixtures/wordlists/pokemon.csv",
	dbtype: "tidy",
});
const REAL_PARAM = { ...PARAM, VARIATION_COST: 20 * 0.8, DUPLICATE: false };
const realPhrases = ["うさぎおいし かのやま", "こぶなつりし かのかわ"];
const realUnitCounts = textAnalyzer.tokenizeTogether(realPhrases)
	.map((tokens) => textAnalyzer.getYomiAndPhraseBreak(tokens).length);
const plain = await generate(realPhrases, realDb, REAL_PARAM, null);
const withNulls = await generate(realPhrases, realDb, REAL_PARAM, [null, null]);
const uniform = await generate(realPhrases, realDb, REAL_PARAM,
	realUnitCounts.map((n) => Array(n).fill(1)));
assert.ok(plain.length === realPhrases.length && plain.every((ws) => ws.length > 0),
	"実歌詞が変換できていること");
assert.equal(surfacesOf(withNulls), surfacesOf(plain), "重みnullの行は従来と同じ");
assert.equal(surfacesOf(uniform), surfacesOf(plain), "一様重みの行は従来と同じ");
print(`[ok] 実歌詞: 重みなし/null/一様重みで同一(${surfacesOf(plain)})`);

// ---- 3. 正規化と不正値のフォールバック ----
// 総和が同じでも比が同じなら同じスコア(平均1への正規化)
assert.deepEqual(simOf(db, kaka, [1.5, 0.5]), simOf(db, kaka, [3, 1]),
	"重みは比だけが効く(平均1に正規化)");
assert.deepEqual(simOf(db, kaka, [1.5, 0.5]), simOf(db, kaka, [0.75, 0.25]),
	"重みは比だけが効く(小さいスケールでも同じ)");
print("[ok] 重みは行内で平均1に正規化される");

for (const bad of [[1], [1, 1, 1], [0, 0], [-1, 3], [1, NaN], [1, Infinity], ["1", "1"], 1]) {
	const { result, warnings: w } = countWarnings(() => simOf(db, kaka, bad));
	assert.deepEqual(result, base, `不正な重みは重みなし扱い(${JSON.stringify(bad)})`);
	assert.equal(w.length, 1, `警告が1回出ること(${JSON.stringify(bad)})`);
}
print("[ok] 長さ不一致・総和0以下・非負の有限数でない値は警告して重みなしにフォールバック");

{
	const { warnings: w } = countWarnings(() => simOf(db, kaka, [1.5, 0.5]));
	assert.equal(w.length, 0, "正しい重みでは警告なし");
}
// 行単位のフォールバック: 不正な行だけ重みなしになり、他の行の重みは効く
{
	const twoLines = ["カカ", "カカ"];
	const twoUnit = wordList.parsePlain(["カキ", "キカ"].join("\n"));
	warnings = [];
	const results = await generate(twoLines, twoUnit, PARAM, [[1, 2, 3], [0.5, 1.5]]);
	assert.equal(warnings.length, 1, "不正な行の分だけ警告が出る");
	assert.equal(surfacesOf(results), "カキ / キカ",
		"不正な行は重みなし・正しい行は重みが効く");
}

// ---- 4. 重みで候補選択が変わる(合成ケース) ----
// 「カカ」に対し「カキ」(前が一致)と「キカ」(後ろが一致)は無重みだと同点。
assert.equal(base["カキ"], base["キカ"], "無重みでは前一致・後ろ一致が同点");
assert.ok(base["カキ"] > 0, "同点だが0ではない(片側は不一致)");

const front = simOf(db, kaka, [1.5, 0.5]); // 前を重視
assert.ok(front["カキ"] < front["キカ"], "前を重視すると前が一致する候補が勝つ");
const back = simOf(db, kaka, [0.5, 1.5]); // 後ろを重視
assert.ok(back["キカ"] < back["カキ"], "後ろを重視すると後ろが一致する候補が勝つ");
// 重み0の位置は完全に無視される
const onlyFront = simOf(db, kaka, [2, 0]);
assert.equal(onlyFront["カキ"], 0, "後ろの重みが0なら前一致だけでスコア0");
print("[ok] 重みを上げた位置で音が合う候補が勝つ(候補スコア)");

// DP(generate)でも選ばれる単語が変わること
const twoUnitDb = wordList.parsePlain(["カキ", "キカ"].join("\n"));
assert.equal(surfacesOf(await generate(["カカ"], twoUnitDb, PARAM, [[1.5, 0.5]])), "カキ",
	"前を重視した生成");
assert.equal(surfacesOf(await generate(["カカ"], twoUnitDb, PARAM, [[0.5, 1.5]])), "キカ",
	"後ろを重視した生成");
assert.equal(surfacesOf(await generate(["カカ"], twoUnitDb, PARAM, [[1, 1]])),
	surfacesOf(await generate(["カカ"], twoUnitDb, PARAM, null)),
	"一様重みは重みなしと同じ生成結果");
print("[ok] 重みで生成結果(DPの単語選択)が変わる");

// ---- 5. 変種でユニット数が変わる場合の対応づけ ----
// 「カンカ」は2ユニット(カン/カ)だが、変種["カ","ン","カ"]は3ユニットになる。
// 3ユニットの単語と比べるときも、先頭2ユニットは音節0の重み、末尾は音節1の重みを使う。
const kanka = textAnalyzer.yomiToSyllable("カンカ");
assert.deepEqual(kanka, ["カン", "カ"], "「カンカ」は2ユニット(カン/カ)");
const plainKanka = simOf(db, kanka, null);
assert.ok(plainKanka["カナカ"] > 0 && plainKanka["カナキ"] > plainKanka["カナカ"],
	"無重み: カナカ(ンとナの差のみ) < カナキ(さらに末尾も違う)");

const headHeavy = simOf(db, kanka, [2, 0]); // 音節0(=変種のカ・ンの2ユニット)だけ効く
assert.equal(headHeavy["カナカ"], headHeavy["カナキ"],
	"末尾(音節1)の重みが0なら、末尾だけ違う2語は同点になる");
assert.equal(headHeavy["カナカ"], plainKanka["カナカ"] * 2,
	"音節0由来の2ユニットに重み2がかかる(位置ずれしていたら成立しない)");

const tailHeavy = simOf(db, kanka, [0, 2]); // 音節1(=変種の末尾1ユニット)だけ効く
assert.equal(tailHeavy["カナカ"], 0,
	"音節0の重みが0なら、変種の先頭2ユニットの差はスコアに乗らない");
assert.ok(tailHeavy["カナキ"] > 0, "末尾が違えば重み2で効く");
print("[ok] 変種展開(ン/ッ/ー)を跨いでも重みが元の音節に対応する");

// ---- 6. VARIATION_COST は重みの影響を受けない(無重みのまま) ----
{
	const VC = 20 * 0.8;
	const param = { ...PARAM, VARIATION_COST: VC };
	// 「カンカ」→変種["カ","カ"](ン削除=1操作)が「カカ」に一致する。ld項は0なので
	// simはVARIATION_COST分だけになり、重みの与え方によらず一定であること
	const vdb = wordList.parsePlain(["カカ"].join("\n"));
	const simFor = (weights) => {
		const c = soramimiMaker.getCandidates(vdb, kanka, param, 10, weights);
		return c[0].sim;
	};
	assert.equal(simFor(null), VC, "変種コストがそのまま乗る");
	for (const weights of [[2, 0], [0, 2], [1.5, 0.5]]) {
		assert.equal(simFor(weights), VC,
			`VARIATION_COSTは重みで増減しない(${JSON.stringify(weights)})`);
	}
}
print("[ok] VARIATION_COSTは無重みのまま(ユニット距離だけに重みがかかる)");

print("ユニット位置別の重み付きスコアリング: 全テスト通過");
