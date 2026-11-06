import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignLyricTokens, lyricAlignmentRanges, validLyricAlignment } from "../frontend/src/lyricAlignment.js";
import { syncOriginalReadingAlignments } from "../frontend/src/editorLyricAlignment.js";
import { buildApp } from "./golden/harness-lib.mjs";

const print = console.log.bind(console);
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/lyric-alignment.json", import.meta.url)));
for (const { text, reading, tokens, expected } of fixtures) {
	assert.deepEqual(alignLyricTokens(text, reading, tokens), expected);
	assert(validLyricAlignment(expected, text, reading));
	assert(!validLyricAlignment(expected, text + "x", reading));
	assert(!validLyricAlignment(expected, text, reading + "x"));
}
const { app } = await buildApp();
const phrases = ["いまだにあなたのことお", "夢は今もめぐりて"];
const tokensList = app.textAnalyzer.tokenizeTogether(phrases);
const unitsList = tokensList.map(t => app.textAnalyzer.getYomiAndPhraseBreak(t));
const data = { phrases, tokensList, unitsList, originalLines: ["未だにあなたのことを", "夢は今も めぐりて"] };
const before = JSON.stringify(data);
syncOriginalReadingAlignments(data, app);
assert.deepEqual(lyricAlignmentRanges(data.originalReadingAlignments[0], data.originalLines[0], unitsList[0],
	[{ start: 5, end: 9 }]), [[4, 8]]);
assert.deepEqual(lyricAlignmentRanges(data.originalReadingAlignments[1], data.originalLines[1], unitsList[1],
	[{ start: 0, end: 2 }]), [[0, 1]]);
const { originalReadingAlignments, ...unchanged } = data;
assert.equal(JSON.stringify(unchanged), before, "generating optional maps never alters source or reading");
const restored = JSON.parse(JSON.stringify(data));
syncOriginalReadingAlignments(restored, app);
assert.equal(JSON.stringify(restored), JSON.stringify(data), "new JSON preserves a validated map on reload");
restored.originalReadingAlignments[0].format = "future-version";
syncOriginalReadingAlignments(restored, app);
assert.equal(JSON.stringify(restored), JSON.stringify(data), "unknown optional formats can be regenerated without rejecting the file");
restored.unitsList[0][5].pronunciation = "ポ";
assert.equal(lyricAlignmentRanges(data.originalReadingAlignments[0], data.originalLines[0], restored.unitsList[0],
	[{ start: 5, end: 9 }]), null, "stale maps cannot be used with a corrected reading");
const invalid = structuredClone(originalReadingAlignments[0]);
invalid.spans[0].surface[1] = 10000;
assert(!validLyricAlignment(invalid, data.originalLines[0], unitsList[0].map(u => u.pronunciation).join("")));
const emoji = fixtures.find(f => f.name === "unicode-and-silent").expected;
assert.deepEqual(lyricAlignmentRanges(emoji, emoji.text, [{ pronunciation: "ユ" }, { pronunciation: "メ" }],
	[{ start: 0, end: 2 }]), [[2, 3]], "spans use UTF-16, keeping supplementary characters intact");
const uncertain = fixtures.find(f => f.name === "unmatched").expected;
assert.deepEqual(lyricAlignmentRanges(uncertain, uncertain.text, [{ pronunciation: "ソラ" }],
	[{ start: 0, end: 1 }]), [], "estimated subtitle timing is not asserted as an exact search highlight");
const silent = alignLyricTokens("あ、空", "アソラ", [["あ", "ア"], ["、", ""], ["空", "ソラ"]]);
assert.deepEqual(lyricAlignmentRanges(silent, silent.text,
	[{ pronunciation: "ア" }, { pronunciation: "ソ" }, { pronunciation: "ラ" }], [{ start: 0, end: 3 }]),
	[[0, 3]], "silent punctuation between aligned reading spans cannot suppress a phrase highlight");
print("[ok] shared lyric spans, old/new/unknown JSON, source preservation, stale map invalidation and UTF-16");
