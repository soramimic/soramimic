import assert from "node:assert/strict";
import { buildApp } from "./golden/harness-lib.mjs";
import { findPlacements } from "../frontend/src/reverseSearch.js";
import { lineRegenerationInput } from "../frontend/src/editorRegeneration.js";

const print = console.log.bind(console);
const { app } = await buildApp();
const param = { DUPLICATE: false, VARIATION_COST: 16, VOWEL_RATIO: .8 };
const tokens = app.textAnalyzer.tokenizeTogether(["あ空", "空", "", "風", "東京", "畑"]);
const units = tokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row));
const matches = await findPlacements(app, "ソラ", units, param);
assert.deepEqual(matches.slice(0, 2).map(({ line, start, end, score }) => ({ line, start, end, score })), [
	{ line: 0, start: 1, end: 3, score: 0 }, { line: 1, start: 0, end: 2, score: 0 },
]);
assert(matches.every(({ line, start, end }) => start === 0 || units[line][start - 1].char_index !== units[line][start].char_index));
assert(matches.every(({ line, end }) => end === units[line].length || units[line][end - 1].char_index !== units[line][end].char_index));
const longVowels = await findPlacements(app, "トーキョー", units, param);
assert.equal(longVowels[0].line, 4);
assert.equal(longVowels[0].score, 0);
assert.deepEqual(await findPlacements(app, "ソラ", [[], units[1].slice(0, 1)], param), []);
await assert.rejects(findPlacements(app, "123", units, param), /かな/);
await assert.rejects(findPlacements(app, "ン".repeat(30), units, param), /複雑/);
assert.deepEqual(await findPlacements(app, "ソラ", units, param, null, { aborted: true }), []);

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
print("[ok] reverse ranking, character boundaries, variants, validation, cancellation, reusable scoring, isolated line regeneration");
