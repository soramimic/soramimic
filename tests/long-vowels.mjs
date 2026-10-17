// Tokenizer boundaries must not detach a prolonged vowel from its syllable.
// Run with: node tests/long-vowels.mjs
import assert from "node:assert/strict";
import { buildApp } from "./golden/harness-lib.mjs";

const print = console.log.bind(console);
const { app } = await buildApp();
const { textAnalyzer, soramimiMaker, wordList } = app;

function tokens(parts) {
	return parts.map((part, i) => ({
		surface_form: part, pronunciation: part, reading: part, basic_form: part,
		pos: "名詞", pos_detail_1: "一般", pos_detail_2: "*", pos_detail_3: "*",
		conjugated_form: "*", conjugated_type: "*", word_position: i + 1, phrase: i,
	}));
}

const cases = [
	[["コ", "ーラ"], ["コー", "ラ"]],
	[["キャ", "ーンディ"], ["キャーン", "ディ"]],
	[["カ", "ーット"], ["カーッ", "ト"]],
	[["コ", "ー", "ヒ", "ー"], ["コー", "ヒー"]],
	[["ン", "ー"], ["ンー"]],
	[["カイ", "ー"], ["カ", "イー"]],
	// Other vowel boundaries are preserved; line-leading marks are not discarded.
	[["コ", "ウラ"], ["コ", "ウ", "ラ"]],
	[["ーラ"], ["ー", "ラ"]],
];
for (const [parts, expected] of cases) {
	const units = textAnalyzer.getYomiAndPhraseBreak(tokens(parts));
	assert.deepEqual(units.map(u => u.pronunciation), expected, parts.join(" / "));
	assert.equal(units.map(u => u.surface_form).join(""), parts.join(""));
	assert.equal(units.map(u => u.pronunciation).join(""), parts.join(""));
}
const units = textAnalyzer.getYomiAndPhraseBreak(tokens(["ネコ", "ーラ"]));
assert.deepEqual(units.map(u => u.pronunciation), ["ネ", "コー", "ラ"]);
assert.deepEqual(units.map(u => u.char_index), [0, 1, 3]);
assert.deepEqual(units.map(u => u.token_index), [0, 0, 1]);
assert.deepEqual(units.map(u => u.phrase), [0, 0, 1]);
print("[ok] Long vowels cross subword boundaries without losing surface or reading positions");

const db = await wordList.parseTidy("id,original,surface,pronunciation\n1,コーラ,コーラ,コーラ", "");
for (const duplicate of [false, true]) {
	const prepared = textAnalyzer.formatTokensList([tokens(["コ", "ーラ"])]);
	const [words] = await new Promise(resolve => {
		soramimiMaker.generateFromTokens(prepared, db, { DUPLICATE: duplicate }, null, resolve);
	});
	assert.equal(words.length, 1);
	assert.equal(words[0].surface, "コーラ");
	assert.deepEqual(words[0].period, [0, 2]);
	assert.equal(words[0].original_surface, "コーラ");
	assert.ok(!words[0].filler);
}
print("[ok] Cross-token long vowels use dictionary words with or without duplicate words");

// Repeated marks consume source characters just like their vowel spellings.
const repeated = [
	[["カー", "ー"], ["カー", "ア"]],
	[["カ", "ー", "ー"], ["カー", "ア"]],
	[["カ", "ーー"], ["カー", "ア"]],
	[["カ", "ーー", "ーラ"], ["カー", "アア", "ラ"]],
	[["ドーーー"], ["ドー", "オオ"]],
	[["シェ", "ー", "ーラ"], ["シェー", "エ", "ラ"]],
	[["ヲー", "ー"], ["ヲー", "オ"]],
];
for (const [parts, expected] of repeated) {
	for (const format of [false, true]) {
		const input = tokens(parts);
		const prepared = format ? textAnalyzer.formatTokensList([input])[0] : input;
		assert.equal(prepared.map(t => t.surface_form).join(""), parts.join(""));
		const units = textAnalyzer.getYomiAndPhraseBreak(prepared);
		assert.deepEqual(units.map(u => u.pronunciation), expected, parts.join(" / "));
		assert.equal(units.map(u => u.surface_form).join(""), parts.join(""));
		assert.equal(units.map(u => u.pronunciation).join("").length, parts.join("").length);
		assert.ok(units.every(u => u.pronunciation !== "ー"));
	}
}
const repeatedPositions = textAnalyzer.getYomiAndPhraseBreak(
	textAnalyzer.formatTokensList([tokens(["カ", "ー", "ー"])])[0]);
assert.deepEqual(repeatedPositions.map(u => u.char_index), [0, 2]);
assert.equal(textAnalyzer.formatTokensList([tokens(["ー"])])[0][0].surface_form, "ー");

// Normalization follows character alignment so a manual assignment stays valid.
const manual = {
	...tokens(["甲乙"])[0], pronunciation: "カーーラ",
	manualAlign: [["甲", "カーー"], ["乙", "ラ"]],
};
const aligned = textAnalyzer.getYomiAndPhraseBreak([manual]);
assert.deepEqual(aligned.map(u => u.pronunciation), ["カー", "ア", "ラ"]);
assert.deepEqual(aligned.map(u => u.char_index), [0, 0, 1]);
assert.equal(aligned.map(u => u.surface_form).join(""), "甲乙");

for (const spelling of ["カーー", "カーア"]) {
	assert.equal(textAnalyzer.formatKana(spelling), "カーア");
	const db = await wordList.parseTidy(
		`id,original,surface,pronunciation\n1,長音語,長音語,${spelling}`, "");
	for (const duplicate of [false, true]) {
		const prepared = textAnalyzer.formatTokensList([tokens(["カ", "ー", "ー"])]);
		const [words] = await new Promise(resolve => {
			soramimiMaker.generateFromTokens(prepared, db, { DUPLICATE: duplicate }, null, resolve);
		});
		assert.equal(words.length, 1);
		assert.equal(words[0].surface, "長音語");
		assert.deepEqual(words[0].period, [0, 2]);
		assert.equal(words[0].original_surface, "カーー");
		assert.ok(!words[0].filler);
	}
}
print("[ok] Repeated long vowels retain their characters, alignments and dictionary matches");
