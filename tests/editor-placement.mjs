import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildApp } from "./golden/harness-lib.mjs";
import { findPlacements, originalHighlightRanges } from "../frontend/src/reverseSearch.js";
import { lineRegenerationInput } from "../frontend/src/editorRegeneration.js";
import { generatedWords } from "../frontend/src/editorWordIdentity.js";

const print = console.log.bind(console);
const { app } = await buildApp();
const param = { DUPLICATE: false, VARIATION_COST: 16, VOWEL_RATIO: .8 };
const tokens = app.textAnalyzer.tokenizeTogether(["あ空", "空", "", "風", "東京", "畑"]);
const units = tokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row));
const matches = await findPlacements(app, "ソラ", units, param);
assert.deepEqual(matches.slice(0, 2).map(({ line, start, end, score }) => ({ line, start, end, score })), [
	{ line: 0, start: 1, end: 3, score: 0 }, { line: 1, start: 0, end: 2, score: 0 },
]);
// Search reading units independently of how many sounds each kanji represents.
const sunsetLines = readFileSync(new URL("../sample_lyric/akatombo.txt", import.meta.url), "utf8").split("\n");
const sunsetTokens = app.textAnalyzer.tokenizeTogether(sunsetLines);
const sunsetUnits = sunsetTokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row));
const sunsetMatches = await findPlacements(app, "ユウヤ", sunsetUnits, param);
assert.deepEqual(sunsetMatches.slice(0, 2).map(({ line, start, end, score }) => ({ line, start, end, score })), [
	{ line: 0, start: 0, end: 2, score: 0 }, { line: 9, start: 0, end: 2, score: 0 },
], "a reading ending inside 焼 must rank ahead of other similar sounds");
assert.deepEqual(originalHighlightRanges(sunsetLines[0], sunsetUnits[0], [sunsetMatches[0]], sunsetTokens[0]), [[0, 2]]);
for (const [kana, start, end] of [["ハタ", 0, 2], ["タケ", 1, 3], ["タ", 1, 2]]) {
	const [best] = await findPlacements(app, kana, [units[5]], param);
	assert.deepEqual(best, { line: 0, start, end, score: 0, lengthDifference: 0 });
	assert.deepEqual(originalHighlightRanges("畑", units[5], [best], tokens[5]), [[0, 1]],
		"a match inside a kanji must highlight that kanji even when its unit has no surface text");
}
const longVowels = await findPlacements(app, "トーキョー", units, param);
assert.equal(longVowels[0].line, 4);
assert.equal(longVowels[0].score, 0);
assert.deepEqual(await findPlacements(app, "ソラ", [[], units[1].slice(0, 1)], param), []);
await assert.rejects(findPlacements(app, "123", units, param), /かな/);
await assert.rejects(findPlacements(app, "ン".repeat(30), units, param), /複雑/);
assert.deepEqual(await findPlacements(app, "ソラ", units, param, null, { aborted: true }), []);

const original = "負われて見たのは、いつの日か";
const corrected = app.textAnalyzer.tokenizeTogether([original])[0];
corrected[0].pronunciation = "コトーゲ";
const correctedUnits = app.textAnalyzer.getYomiAndPhraseBreak(corrected);
const correctedMatches = await findPlacements(app, "コトーゲ", [correctedUnits], param);
assert.equal(correctedMatches[0].score, 0);
assert.deepEqual(originalHighlightRanges(original, correctedUnits, [correctedMatches[0]], corrected), [[0, 2]],
	"a changed reading may highlight its token, never the entire line as a fallback");
assert.deepEqual(originalHighlightRanges("別表記の元歌詞", correctedUnits, correctedMatches, corrected), [],
	"unmapped host spellings must not be highlighted as a whole line");
assert.deepEqual(originalHighlightRanges("あ空", units[0], [matches[0]], tokens[0]), [[1, 2]]);

const db = await app.wordList.parsePlain("空,ソラ\n風,カゼ\n花,ハナ\n宇宙,ソラ");
const search = app.soramimiMaker.createCandidateSearch(db, param);
for (const target of [["ソ", "ラ"], ["トー", "キョー"], ["カ", "ゼ"]]) {
	for (const weights of [null, target.map((_, i) => i + 1)]) {
		assert.deepEqual(search(target, 4, weights), app.soramimiMaker.getCandidates(db, target, param, 4, weights));
	}
}
const beforeDb = JSON.stringify(db);
const sourceWord = search(["ソ", "ラ"], 1)[0];
const locked = { id: "custom-fixed", surface: "あ", kana: "ア", pronunciation: ["ア"], period: [0, 1], locked: true };
const data = {
	param, tokensList: tokens,
	results: [[locked], [{ ...sourceWord, period: [0, 2] }], [], [], [], []],
};
const before = JSON.stringify(data);
const weights = units.map((row) => row.map((_, i) => i + 1));
const input = lineRegenerationInput(data, db, 0, weights);
assert.deepEqual(input.weights, [weights[0]]);
assert(input.db !== db);
assert(Object.values(input.db).flat().every((word) => word.id !== sourceWord.id));
const generated = await new Promise((resolve) => app.soramimiMaker.generateFromTokens(
	input.tokens, input.db, param, null, resolve, input.locks, input.weights));
assert.equal(generated.length, 1);
assert.equal(generated[0][0].id, locked.id);
assert(generated[0].some((word) => !word.filler && word.id !== locked.id));
assert(generated[0].every((word) => word.id !== sourceWord.id));
assert.equal(JSON.stringify(data), before, "generation must not mutate existing locks before committing");
assert.equal(JSON.stringify(db), beforeDb);
assert.equal(JSON.stringify(lineRegenerationInput(JSON.parse(before), db, 0, weights).tokens), JSON.stringify([tokens[0]]));
assert.equal(lineRegenerationInput({ ...data, param: { ...param, DUPLICATE: true } }, db, 0).db, db);
const foreign = { ...locked, id: sourceWord.id, original_surface: "あ", wordlistSource: "previous-list" };
const switched = { ...data, wordlistSource: "current-list", results: [[foreign],
	[{ ...sourceWord, wordlistSource: "previous-list", period: [0, 2] }], [], [], [], []] };
const switchedInput = lineRegenerationInput(switched, db, 0, weights);
assert(Object.values(switchedInput.db).flat().some((word) => word.id === sourceWord.id),
	"old list IDs must not exclude unrelated words from the selected list");
const switchedResults = await new Promise((resolve) => app.soramimiMaker.generateFromTokens(
	switchedInput.tokens, switchedInput.db, param, null, resolve, switchedInput.locks, switchedInput.weights));
const restored = generatedWords(switchedResults[0], switched.wordlistSource);
assert.deepEqual(restored[0], foreign, "retained locks preserve their identity after generation");
assert(restored.slice(1).some((word) => word.id === sourceWord.id), "same IDs in different lists can coexist");
print("[ok] reverse ranking, partial kanji readings and highlights, variants, validation, cancellation, reusable scoring, isolated line regeneration");
