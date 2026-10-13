import assert from "node:assert/strict";
import { buildApp } from "./golden/harness-lib.mjs";
import { priorityMetrics } from "../frontend/src/lib/priorityPlacement.js";

const print = console.log.bind(console);
const h = await buildApp();
const { wordList, textAnalyzer, soramimiMaker } = h.app;
const base = { VOWEL_RATIO: 0.8, VARIATION_COST: 16, SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20, WORD_NUMBER_PENALTY: 20, DUPLICATE: false };
const preferred = (id, original, surface = original, scope = "word") => ({ id, original, surface, kana: "", scope });
const generate = (phrases, db, preferences, extra = {}, locks = null, weights = null) => new Promise((resolve, reject) => {
	const handle = soramimiMaker.generateFromTokens(textAnalyzer.tokenizeTogether(phrases), db,
		{ ...base, ...extra, PRIORITY_WORDS: preferences, PRIORITY_STRATEGY: extra.PRIORITY_STRATEGY || "placement" },
		null, (results, diagnostics) => resolve({ results, diagnostics }), locks, weights);
	handle.finished?.catch(reject);
});

const db = await wordList.parsePlain("通常語,カカカカ\n前半,カカ\n後半,カカ\n優先語,ササ");
const prefs = [preferred("3", "優先語")];
const soft = await generate(["カカカカ"], db, prefs, { PRIORITY_STRATEGY: "score" });
const placed = await generate(["カカカカ"], db, prefs);
assert.equal(priorityMetrics(soft.results, prefs).included.length, 0);
assert.equal(priorityMetrics(placed.results, prefs).included.length, 1);
assert.equal(placed.diagnostics.priority.fillerUnits, 0);
assert(placed.results.flat().some(word => word.priorityPlaced));
assert(!placed.results.flat().some(word => word.locked), "automatic placement must not become a user lock");
assert(placed.results.flat().find(word => word.priorityPlaced).sim > 0, "phonetic distance is not discounted");

const joint = await wordList.parseTidy("id,original,surface,pronunciation\n0,通常,通常,カキ\n1,A,全体A,カキ\n1,A,短縮A,カ\n2,B,B,キ\n", "");
const jointPrefs = [preferred("1", "A", "全体A"), preferred("2", "B")];
const jointResult = await generate(["カキ"], joint, jointPrefs);
assert.equal(priorityMetrics(jointResult.results, jointPrefs).included.length, 2, "joint placement keeps alternatives instead of greedily consuming the whole line");
assert.deepEqual(jointResult.results[0].map(word => word.surface), ["短縮A", "B"]);
assert.equal(priorityMetrics((await generate(["カキ"], joint,
	[preferred("1", "A", "全体A", "surface"), preferred("2", "B")])).results, [preferred("1", "A", "全体A", "surface"), preferred("2", "B")]).included.length, 1, "surface scope cannot substitute a shorter spelling");

const gapDb = await wordList.parsePlain("通常,カカカ\n指定,ササ");
const gapPrefs = [preferred("1", "指定")];
const gap = await generate(["カカカ"], gapDb, gapPrefs);
assert.equal(priorityMetrics(gap.results, gapPrefs).included.length, 1, "explicit preferences outrank a cleaner remainder");
assert.equal(priorityMetrics(gap.results, gapPrefs).fillerUnits, 1, "report the unmatched remainder rather than silently dropping the requested word");

const single = await wordList.parsePlain("通常,カ\n指定,サ\n遠い,キ");
const distant = [preferred("2", "遠い")];
assert.equal(priorityMetrics((await generate(["カ"], single, distant)).results, distant).included.length, 1, "use explicitly requested words even when phonetically distant");
const distantDb = await wordList.parsePlain("通常,カ\n指定A,キ\n指定B,ク\n指定C,ケ");
const distantPrefs = [preferred("1", "指定A"), preferred("2", "指定B"), preferred("3", "指定C")];
assert.equal(priorityMetrics((await generate(["カ", "カ", "カ"], distantDb, distantPrefs)).results,
	distantPrefs).included.length, 3, "all three requested words outrank phonetic similarity when they fit");
const repeated = await generate(["カ", "カ"], single, [preferred("1", "指定")]);
assert.equal(repeated.results.flat().filter(word => word.id === "1").length, 1, "reserve a future placement's ID across lines");
assert.equal(new Set(repeated.results.flat().map(word => word.id)).size, 2);
const lock = { ...single[1].find(word => word.id === "0"), period: [0, 1], sim: 0, score: 0, locked: true };
const fixed = await generate(["カ", "カ"], single, [preferred("1", "指定")], {}, [[lock], []]);
assert.equal(fixed.results[0][0].id, "0");
assert(fixed.results[0][0].locked);
assert.equal(fixed.results[1][0].id, "1");
const covered = await generate(["カ"], single, [preferred("0", "通常")], {}, [[lock]]);
assert.equal(covered.diagnostics.priority.included.length, 1);
assert.equal(covered.results[0].length, 1);

const legacyLock = { ...lock };
delete legacyLock.score; delete legacyLock.sim;
const legacyHandle = soramimiMaker.generateFromTokens(textAnalyzer.tokenizeTogether(["カ", "カ"]), single,
	{ ...base, PRIORITY_WORDS: [preferred("1", "指定")], PRIORITY_STRATEGY: "placement" },
	null, null, [[legacyLock], []]);
assert(Number.isFinite((await legacyHandle.finished).score), "legacy locks without scores must not poison placement-plan comparison");

const weighted = await generate(["カカカカ"], db, prefs, {}, null, [[1, 1, 1, 1]]);
assert.equal(weighted.diagnostics.priority.included.length, 1);
const character = await wordList.parsePlain("全体,ハタケ\n一部,タ");
const charPrefs = [preferred("1", "一部")];
const charResult = await generate(["畑"], character, charPrefs);
assert.equal(charResult.results[0].length, 1, "automatic placement respects character boundaries");
assert.equal(charResult.results[0][0].surface, "全体");

let completed = false, updated = false;
const cancelled = soramimiMaker.generateFromTokens(textAnalyzer.tokenizeTogether(["カカカカ"]), db,
	{ ...base, PRIORITY_WORDS: prefs, PRIORITY_STRATEGY: "placement" },
	() => { updated = true; }, () => { completed = true; });
cancelled.cancel(); await cancelled.finished;
assert(!completed && !updated, "cancelling suppresses updates and completion during planning");
print("[ok] priority placement: requested-word priority, alternatives, scopes, remainder/fillers, future ID reservations, locks, weights, character boundaries and cancellation");
