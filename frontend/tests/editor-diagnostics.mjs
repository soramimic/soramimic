import assert from "node:assert/strict";
import { vowelSequence, wordDiagnostics } from "../src/editorVisualization.js";
import { buildApp } from "../../tests/golden/harness-lib.mjs";
import { sameVowelAlignment } from "../src/editorVowelAlignment.js";
const print = console.log.bind(console);

for (const [left, right] of [["ケイ", "ケー"], ["コウ", "コー"], ["キャ", "ヤ"],
	["カン", "カ"], ["カッ", "カ"], ["ヲ", "オ"], ["ヲー", "オー"], ["こー", "コウ"]]) {
	assert.equal(vowelSequence(left), vowelSequence(right), `${left}/${right}`);
}
assert.notEqual(vowelSequence("カカ"), vowelSequence("カ"), "separate syllables must retain their vowels");
assert.notEqual(vowelSequence("コイ"), vowelSequence("コウ"));
assert.equal(vowelSequence("ジョイ"), "オイ", "small ョ must retain its vowel");
assert.equal(vowelSequence("キョー"), "オ");
for (const [kana, pronunciation, target] of [
	["ジョイ", ["ジョ", "イ"], ["オ", "イ"]],
	["チカノーバー", ["チ", "カ", "ノー", "バー"], ["シ", "カ", "ノ", "ヤ", "マ"]],
	["ドブジャンスキー", ["ド", "ブ", "ジャ", "ス", "キー"], ["コ", "ブ", "ナ", "ツ", "リ", "シ"]],
	["サツケバー", ["サ", "ツ", "ケ", "バー"], ["ワ", "ス", "レ", "ガ", "タ"]],
	["オジー", ["オ", "ジー"], ["オ", "イ", "シ"]],
	["コー", ["コー"], ["コ", "オ"]],
	["キョー", ["キョー"], ["コ", "ト"]],
	["コト", ["コ", "ト"], ["キョー"]],
]) {
	assert.equal(wordDiagnostics({ kana, pronunciation }, target).vowel, false,
		`${kana}: matching vowels must not be flagged across long-vowel expansion`);
}
assert.equal(wordDiagnostics({ kana: "チカノーバー", pronunciation: ["チ", "カ", "ノー", "バー"] },
	["シ", "カ", "ネ", "ヤ", "マ"]).vowel, true, "a real vowel mismatch must remain visible");
assert.equal(wordDiagnostics({ kana: "キョー", pronunciation: ["キョー"] }, ["カ", "ア"]).vowel, true);
assert.equal(wordDiagnostics({ kana: "カン" }, ["タン"]).single, true);
assert.equal(wordDiagnostics({ kana: "キャク" }, ["キャ", "ク"]).single, false);
assert.equal(wordDiagnostics({ kana: "タカ" }, ["タ", "コ"]).vowel, true);
assert.deepEqual(wordDiagnostics({ filler: true }, ["カ"]), { filler: true });
assert.deepEqual(wordDiagnostics({}, ["カ"]), {});
for (const [left, right] of [
	[["アン", "カ"], ["ア", "ナ", "カ"]],
	[["アッ", "カ"], ["ア", "ナ", "カ"]],
]) {
	assert.equal(sameVowelAlignment(left, right), false);
	assert.equal(sameVowelAlignment(right, left), false, "nasal/geminate lengthening must not supply a vowel in either direction");
}
assert.equal(wordDiagnostics({ kana: "アンカ", pronunciation: ["アー", "カ"], vcost: 1 }, ["ア", "ナ", "カ"]).vowel, true,
	"a selected nasal-lengthening variant must not hide a vowel mismatch");
assert.equal(sameVowelAlignment(["カーン"], ["カー"]), true, "nasal omission preserves the real vowel");
assert.equal(sameVowelAlignment(["カンッ"], ["カッ"]), true);
assert.equal(sameVowelAlignment(["セイ"], ["セー"]), true);
assert.equal(sameVowelAlignment(["コウ"], ["コー"]), true);
assert.equal(sameVowelAlignment(["コー", null], ["コウ"]), true, "phrase separators do not emit vowels");
assert.equal(sameVowelAlignment(Array(40).fill("コー"), Array(40).fill("コウ")), true,
	"spelling alternatives must use bounded graph matching, not a Cartesian product");
assert.equal(sameVowelAlignment(Array(40).fill("コー"), [...Array(39).fill("コウ"), "カ"]), false,
	"a long negative comparison must exhaust shared states, not all spelling combinations");

const { app } = await buildApp({ tokenizer: "kuromoji" });
const param = { VOWEL_RATIO: .8, VARIATION_COST: 16, APPROX_CANDIDATES: 0 };
const matrix = app.kanaSimilarity.getKanaSimilarity(param);
const diagnose = (kana, pronunciation, target, extra = {}) =>
	wordDiagnostics({ kana, pronunciation, ...extra }, target, app, param, matrix);
for (const [kana, pronunciation, target] of [
	["コー", ["コー"], ["コ", "オ"]],
	["サツケバー", ["サ", "ツ", "ケ", "バー"], ["ワ", "ス", "レ", "ガ", "タ"]],
	["コオ", ["コ", "オ"], ["コ", "オ"]],
	["コト", ["コ", "ト"], ["コー"]],
]) assert.equal(diagnose(kana, pronunciation, target).long, true, `${kana}: expansion must be highlighted`);
assert.equal(diagnose("コー", ["コー"], ["コー"]).long, false, "holding a long vowel is not expansion");
assert.equal(diagnose("カタ", ["カ", "タ"], ["サ", "ナ"]).long, false);
assert.equal(diagnose("コー", ["コー"], ["コ", "オ", "カ"]).long, false,
	"an unmatchable reading must not be called expansion");
for (const [kana, pronunciation, target, extra] of [
	["カン", ["カ"], ["カ"], { vcost: 1 }],
	["カッ", ["カ"], ["カ"], { vcost: 1 }],
	["カン", ["カー"], ["カー"], { vcost: 1 }],
	["カ", ["カ"], ["カン"], {}],
	["カッ", ["カ", "ッ"], ["カン"], {}],
]) {
	const result = diagnose(kana, pronunciation, target, extra);
	assert.equal(result.nasal, true, `${kana}: nasal/geminate changes need their own criterion`);
	assert.equal(result.vowel, false, "matching vowels do not report a nasal/geminate change");
}
assert.equal(diagnose("カン", ["カ", "ン"], ["カン"]).nasal, false);
assert.equal(diagnose("カッ", ["カ", "ッ"], ["カッ"]).nasal, false);
assert.equal(diagnose("カタ", ["カ", "タ"], ["サ", "ナ"]).nasal, false);
assert.equal(diagnose("アンカ", ["アー", "カ"], ["ア", "ナ", "カ"], { vcost: 1 }).long, false,
	"lengthening a nasal is separate from expanding a real long vowel");
for (const [kana, target] of [
	["アナカ", ["アン", "カ"]], ["アンカ", ["ア", "ナ", "カ"]],
]) {
	const db = await app.wordList.parsePlain(kana);
	const candidate = app.soramimiMaker.getCandidates(db, target, param, 1)[0];
	assert.ok(candidate);
	assert.equal(wordDiagnostics(candidate, target, app, param, matrix).vowel, true,
		`${kana}: the real generated candidate must report the missing/present vowel`);
}
for (const [kana, target, expanded] of [
	["コウ", ["コ", "ト"], true], ["セイ", ["セ", "リ"], true],
	["オウ", ["オ", "ウ"], true], ["オウ", ["オ", "オ"], true],
	["エイ", ["エ", "イ"], true], ["エイ", ["エ", "エ"], true],
	["オウ", ["オー"], false], ["エイ", ["エー"], false],
	["コウ", ["コー"], false], ["セイ", ["セー"], false],
]) {
	const db = await app.wordList.parsePlain(kana);
	const candidate = app.soramimiMaker.getCandidates(db, target, param, 1)[0];
	assert.ok(candidate);
	const result = wordDiagnostics(candidate, target, app, param, matrix);
	assert.equal(result.vowel, false, `${kana}: real long-vowel spelling remains vowel-compatible`);
	assert.equal(result.long, expanded, `${kana}: expansion must be distinguished from holding`);
}
for (const [kana, target] of [["カタ", ["タ", "カ"]], ["コー", ["コ", "オ"]], ["カン", ["タン"]]]) {
	const db = await app.wordList.parsePlain(kana);
	const word = app.soramimiMaker.getCandidates(db, target, param, 1)[0];
	assert.ok(word);
	const found = wordDiagnostics({ ...word, sim: -999, score: -999 }, target, app, param, matrix);
	assert.ok(Math.abs(found.distance - word.sim / target.length) < 1e-8, "diagnostics use the current matcher, not stale saved scores");
}
const custom = { id: "custom-1", kana: "カン", pronunciation: ["カン"] };
assert.equal(wordDiagnostics(custom, ["カン"], app, param, matrix).distance, 0);
assert.equal(wordDiagnostics({ ...custom, kana: "カタカタ" }, ["カ"], app, param, matrix).lengthMismatch, true);
const long = { id: "custom-long", kana: "カー".repeat(40) };
assert.equal(wordDiagnostics(long, Array(40).fill("カー"), app, param, matrix).distance, 0,
	"long vowel diagnostics must avoid exponential variant enumeration");
print("[ok] editor diagnostics: vowels, syllables, current distances, manual input and long vowels");
