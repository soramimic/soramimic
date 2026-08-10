// filler(万能候補)のテスト(#128)。
//
// 単語が足りない(DUPLICATE=falseで使い切った)・どの単語も合わない区間があると、
// 以前は行の変換結果が丸ごと空になっていた。DPに常設した filler
// (1ユニットを必ず埋められる仮想語。表記も読みも元歌詞のかなそのまま)で
// 「変換しきれなかった部分は原曲のまま」という退化になったことを確認する:
//   1. 2語しかないリスト+DUPLICATE=false+3行 → 空行ゼロ・不足分がfiller
//   2. fillerのsurface/pronunciation/kanaが元歌詞のかなと一致し、1ユニットずつ並ぶ
//   3. 実単語が置ける位置ではfillerが勝たない(重み・ペナルティ最大でも同じ)
//   4. fillerは使用済み(単語重複なし)の対象外で、何度でも使える
//   5. 固定(locks)と共存でき、隙間がfillerで埋まる
//   6. 下流(convert.js makeResultText)がfiller混じりの結果でも壊れない
//
// 実行: node tests/filler.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp } from "./golden/harness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { makeResultText } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/convert.js")).href);

const print = console.log.bind(console);

const PARAM = {
	VOWEL_RATIO: 0.8,
	VARIATION_COST: 20 * 0.8,
	SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20,
	WORD_NUMBER_PENALTY: 20,
	DUPLICATE: false,
};

const h = await buildApp();
const { textAnalyzer, soramimiMaker, wordList } = h.app;

const generate = (phrases, db, param, weightsPerLine) =>
	new Promise((resolve) => {
		soramimiMaker.generate(phrases, db, param, null, resolve, weightsPerLine);
	});
const generateFromTokens = (tokensList, db, param, locksPerLine) =>
	new Promise((resolve) => {
		soramimiMaker.generateFromTokens(tokensList, db, param, null, resolve, locksPerLine);
	});
const showLine = (words) =>
	words.map((w) => (w.filler ? `[${w.surface}]` : w.surface)).join("+");
const unitsOf = (phrase) => textAnalyzer
	.getYomiAndPhraseBreak(textAnalyzer.tokenizeTogether([phrase])[0])
	.map((u) => u.pronunciation);

// 行が隙間なく単語で覆われていること(period が 0 から末尾まで連続する)
function assertCovered(words, unitCount, label) {
	assert.ok(words.length > 0, `${label}: 行が空`);
	let cursor = 0;
	for (const w of words) {
		assert.equal(w.period[0], cursor, `${label}: periodが連続していない`);
		cursor = w.period[1];
	}
	assert.equal(cursor, unitCount, `${label}: 行末まで覆われていない`);
}

// fillerの単語オブジェクトが仕様どおりか(1ユニット・元かなそのまま・id無し)
function assertFiller(w, kana, label) {
	assert.equal(w.filler, true, `${label}: fillerフラグ`);
	assert.equal(w.period[1] - w.period[0], 1, `${label}: fillerは1ユニット`);
	assert.equal(w.surface, kana, `${label}: surfaceが元歌詞のかな`);
	assert.equal(w.pronunciation, kana, `${label}: pronunciationが元歌詞のかな`);
	assert.equal(w.kana, kana, `${label}: kanaが元歌詞のかな`);
	assert.equal(w.originalkana, kana, `${label}: originalkanaが元歌詞のかな`);
	assert.ok(!w.id, `${label}: fillerはidを持たない`);
	assert.ok(!w.original, `${label}: fillerはoriginal(元表記)を持たない`);
}

// ---- 1. 単語を使い切っても行が空にならない ----
const twoWordDb = wordList.parsePlain(["カキ", "キカ"].join("\n"));
const phrase = "カキ";
const units = unitsOf(phrase);
assert.deepEqual(units, ["カ", "キ"], "「カキ」は2ユニット");

const shortage = await generate([phrase, phrase, phrase], twoWordDb, PARAM);
assert.equal(shortage.length, 3, "3行返ること");
shortage.forEach((words, i) => assertCovered(words, units.length, `${i}行目`));
// 1・2行目は実単語(2語しかないので1語ずつ)、3行目は在庫切れでfillerになる
assert.ok(shortage[0].every((w) => !w.filler), "1行目は実単語で埋まる");
assert.ok(shortage[1].every((w) => !w.filler), "2行目は実単語で埋まる");
assert.notEqual(shortage[0][0].id, shortage[1][0].id, "単語重複なしが効いている");
assert.ok(shortage[2].every((w) => w.filler), "在庫切れの行はすべてfiller");
shortage[2].forEach((w, i) => assertFiller(w, units[i], `3行目 filler${i}`));
print(`[ok] 単語不足でも空行なし: ${shortage.map(showLine).join(" / ")}`);

// ---- 2. 埋まる区間は実単語・埋まらない区間だけ1ユニットずつfiller ----
const oneWordDb = wordList.parsePlain(["カキ"].join("\n"));
const mixedPhrase = "カキクケ";
const mixedUnits = unitsOf(mixedPhrase);
assert.deepEqual(mixedUnits, ["カ", "キ", "ク", "ケ"], "「カキクケ」は4ユニット");
const mixed = await generate([mixedPhrase], oneWordDb, PARAM);
assertCovered(mixed[0], mixedUnits.length, "混在行");
assert.equal(showLine(mixed[0]), "カキ+[ク]+[ケ]",
	"合う区間は実単語・残りは1ユニットずつのfiller: " + showLine(mixed[0]));
assertFiller(mixed[0][1], "ク", "混在行 filler0");
assertFiller(mixed[0][2], "ケ", "混在行 filler1");
print(`[ok] 未変換区間だけfiller: ${showLine(mixed[0])}`);

// ---- 3. 実単語が置ける位置でfillerが勝たない ----
// 重みは行内で平均1に正規化されるだけなので、片側に全振りしても実単語のコストは
// たかだか「距離の最大値80×ユニット数」。fillerコスト(1e6)には遠く届かない。
// (重みの与え方で「どこに置くか」は変わりうるので、置かれる位置ではなく
//  「実単語が1つ使われ、残りだけがfillerになる」ことを見る)
const assertOneWordRest = (words, allUnits, label) => {
	assertCovered(words, allUnits.length, label);
	const real = words.filter((w) => !w.filler);
	assert.equal(real.length, 1, `${label}: 実単語が1つ使われる(` + showLine(words) + ")");
	assert.equal(real[0].surface, "カキ", `${label}: 使われるのはリスト内の単語`);
	const fillers = words.filter((w) => w.filler);
	assert.equal(fillers.length, allUnits.length - 2, `${label}: 残りは1ユニットずつのfiller`);
	for (const f of fillers) assertFiller(f, allUnits[f.period[0]], `${label} filler`);
};
const heavyParam = { ...PARAM, WORD_NUMBER_PENALTY: 60, MID_PHRASE_BREAK_PENALTY: 160 };
for (const param of [PARAM, heavyParam]) {
	for (const weights of [null, [[4, 0, 0, 0]], [[0, 0, 2, 2]], [[0.1, 0.1, 3.8, 0]]]) {
		const r = await generate([mixedPhrase], oneWordDb, param, weights);
		assertOneWordRest(r[0], mixedUnits,
			`重み ${JSON.stringify(weights)} / ペナルティ${param.WORD_NUMBER_PENALTY}`);
	}
}
print("[ok] 重み・ペナルティ最大でもfillerは実単語に勝たない");

// ---- 4. fillerは使用済み判定の対象外(重複可) ----
{
	// 同じかなの行を並べても、fillerは何行でも同じものが出る(idを持たないので
	// DUPLICATE=false の使用済み集合に入らない)。
	// 3ユニットの語しかないリストは2ユニットの行のどこにも置けない(長さが違う語は
	// 候補にすらならない)ので、行全体がfillerになる
	const noMatchDb = wordList.parsePlain(["クケコ"].join("\n"));
	const r = await generate(["カキ", "カキ", "カキ"], noMatchDb, PARAM);
	assert.equal(r.length, 3, "3行返ること");
	for (const [i, words] of r.entries()) {
		assertCovered(words, units.length, `${i}行目(全filler)`);
		assert.ok(words.every((w) => w.filler), `${i}行目はすべてfiller`);
		words.forEach((w, j) => assertFiller(w, units[j], `${i}行目 filler${j}`));
	}
	// 同一行内でも同じかなのfillerが並べる
	const same = await generate(["カカ"], noMatchDb, PARAM);
	assert.equal(showLine(same[0]), "[カ]+[カ]", "同じかなのfillerが並ぶ");
}
print("[ok] fillerは使用済み(単語重複なし)の対象外で何度でも使える");

// ---- 5. 固定(locks)との共存 ----
{
	const tokensList = textAnalyzer.tokenizeTogether([mixedPhrase]);
	const locked = {
		id: "lock-1", surface: "ソラミミ", pronunciation: "ソラ", kana: "ソラ",
		original: "ソラミミ", sim: 0, period: [1, 3],
	};
	const r = await generateFromTokens(tokensList, oneWordDb, PARAM, [[locked]]);
	assertCovered(r[0], mixedUnits.length, "固定つき");
	assert.equal(showLine(r[0]), "[カ]+ソラミミ+[ケ]",
		"固定単語はそのまま・隙間はfillerで埋まる: " + showLine(r[0]));
	assertFiller(r[0][0], "カ", "固定つき filler0");
	assertFiller(r[0][2], "ケ", "固定つき filler1");

	// 隙間に実単語が置けるなら、そちらが優先される(固定と共存しても同じ)
	const locked2 = { ...locked, period: [2, 4] };
	const r2 = await generateFromTokens(tokensList, oneWordDb, PARAM, [[locked2]]);
	assert.equal(showLine(r2[0]), "カキ+ソラミミ",
		"固定の外に実単語が置けるならfillerは出ない: " + showLine(r2[0]));
}
print("[ok] 固定単語と共存し、隙間だけfillerになる");

// ---- 6. 下流(コピー整形)がfiller混じりでも壊れない ----
{
	const withOriginal = mixed.map((line) => line.map((w) => ({ ...w })));
	for (const fmt of ["1", "2", "3", "4"]) {
		const text = makeResultText(withOriginal, fmt);
		assert.ok(!text.includes("undefined"),
			`makeResultText(${fmt})にundefinedが混ざらない:\n` + text);
		assert.ok(text.includes("ク") && text.includes("ケ"),
			`makeResultText(${fmt})に未変換のかながそのまま出る`);
	}
	// 「使用単語の元表記一覧」(editor.js copyResult)相当: fillerは混ざらない
	const originals = [];
	for (const line of withOriginal) {
		for (const w of line) {
			if (w.filler) continue;
			originals.push(w.original || w.surface);
		}
	}
	assert.deepEqual(originals, ["カキ"], "使用単語一覧にfillerが混ざらない");
}
print("[ok] コピー整形(makeResultText・使用単語一覧)がfiller混じりでも壊れない");

print("filler(万能候補): 全テスト通過");
