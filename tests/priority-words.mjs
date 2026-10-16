import assert from "node:assert/strict";
import { buildApp } from "./golden/harness-lib.mjs";
import { normalizePriorityWords } from "../frontend/src/lib/priorityWords.js";

const print = console.log.bind(console);
const h = await buildApp();
const { wordList, textAnalyzer, soramimiMaker } = h.app;
const param = { VOWEL_RATIO: 0.8, VARIATION_COST: 16, SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20, WORD_NUMBER_PENALTY: 20, DUPLICATE: false };
const csv = "id,original,surface,pronunciation,type\n0,通常,通常,カ,family\n1,指定語,近い表記,サ,family\n1,指定語,別表記,カ,full\n1,指定語,近い表記,サー,family\n2,遠い語,遠い語,キ,given\n";
const db = await wordList.parseTidy(csv, "");
const preferred = { id: "1", original: "指定語", surface: "近い表記", kana: "サ", scope: "word" };
const generate = (phrases, preferences, extra = {}, weights = null) => h.generate(phrases, db,
	{ ...param, ...extra, PRIORITY_WORDS: preferences }, weights);

assert.equal((await generate(["カ"], []))[0][0].id, "0");
assert.equal((await generate(["カ"], [preferred]))[0][0].surface, "別表記", "word scope covers other surfaces");
const surface = { ...preferred, scope: "surface" };
for (const duplicate of [false, true]) {
	const result = await generate(["カ", "カ"], [surface], { DUPLICATE: duplicate });
	assert.equal(result[0][0].surface, "近い表記");
	assert(result[0][0].sim > 0, "phonetic distance must remain truthful");
	assert.equal(result[0][0].score, result[0][0].sim, "placement keeps the actual phonetic cost");
	assert.equal(result[1][0].id, "0", "place the requested word once, then fit the remaining lyrics");
}
assert.equal((await generate(["カ"], [surface], {}, [[1]]))[0][0].surface, "近い表記", "weighted path honors preferences");
assert.equal((await generate(["カ"], [{ ...surface, original: "unrelated" }]))[0][0].id, "0", "stale identities must not match");
const far = { id: "2", original: "遠い語", surface: "遠い語", kana: "キ", scope: "word" };
assert.equal((await generate(["カ"], [far]))[0][0].id, "2", "explicit preferences take priority over phonetic similarity");
const filtered = await wordList.parseTidy(csv, "type=full");
const filteredResult = await h.generate(["カ"], filtered, { ...param, PRIORITY_WORDS: [surface] });
assert.equal(filteredResult[0][0].surface, "別表記", "preference does not reintroduce filtered surfaces");

const units = textAnalyzer.yomiToSyllable("カ");
const candidates = soramimiMaker.getCandidates(db, units, { ...param, PRIORITY_WORDS: [surface] }, 3);
assert.equal(candidates[0].surface, "近い表記");
assert(candidates[0].sim > 0);
const many = await wordList.parseTidy("id,original,surface,pronunciation\n"
	+ Array.from({ length: 10 }, (_, i) => `${i},通常${i},通常${i},カ`).join("\n")
	+ "\np,指定語,近い表記,サ\n", "");
const approximate = soramimiMaker.getCandidates(many, units, { ...param, DUPLICATE: true,
	APPROX_CANDIDATES: 1, PRIORITY_WORDS: [{ ...surface, id: "p" }] }, 1);
assert.equal(approximate[0].id, "p", "preferred IDs survive approximate shortlist pruning");
const tokens = textAnalyzer.tokenizeTogether(["カカ"]);
const lock = { ...db[1].find(word => word.id === "1"), period: [1, 2], sim: 0, score: 0 };
const locked = await new Promise(resolve => soramimiMaker.generateFromTokens(tokens, db,
	{ ...param, PRIORITY_WORDS: [surface] }, null, resolve, [[lock]]));
assert.deepEqual(locked[0].map(word => word.id), ["0", "1"], "future locks reserve preferred IDs");

const catalog = await wordList.entriesTidy(csv, "type=family");
assert.deepEqual(catalog.map(word => [word.id, word.surface, word.kana]),
	[["0", "通常", "カ"], ["1", "近い表記", "サ"], ["1", "近い表記", "サー"]]);
assert(catalog.every(word => word.pronunciation === undefined), "search catalog does not expand pronunciation variants");
assert.deepEqual(normalizePriorityWords([null, {}, preferred, preferred, surface]), [preferred, surface]);
print("[ok] priority words: word/surface scope, placement, raw distance, duplicates, filters, weights, locks, candidate search and unexpanded catalog");
