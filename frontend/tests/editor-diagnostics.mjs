import assert from "node:assert/strict";
import { vowelSequence, wordDiagnostics } from "../src/editorVisualization.js";
import { buildApp } from "../../tests/golden/harness-lib.mjs";
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

const { app } = await buildApp({ tokenizer: "kuromoji" });
const param = { VOWEL_RATIO: .8, VARIATION_COST: 16, APPROX_CANDIDATES: 0 };
const matrix = app.kanaSimilarity.getKanaSimilarity(param);
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
