import assert from "node:assert/strict";
import { wordDetails } from "../src/editorWordDetails.js";

const csvText = "id,original,surface,pronunciation,prefecture,city,lines,status\n" +
	"1,同名A,駅,エキ,岐阜県,下呂市,高山本線,current\n" +
	"1,同名B,駅,エキ,大阪府,大阪市,谷町線,former\n";
const entry = { value: "ORIGINAL", csvText, facets: [{ column: "status", label: "状態",
	values: [{ v: "current", label: "現存" }, { v: "former", label: "廃駅" }] }] };
const word = { id: "1", original: "同名B", surface: "駅", kana: "エキ" };
const details = new Map(await wordDetails(word, entry, "current-list"));
assert.equal(details.get("正式名称"), "同名B");
assert.equal(details.get("都道府県"), "大阪府", "same ID and surface still need the matching original name");
assert.equal(details.get("状態"), "廃駅");
assert.deepEqual(await wordDetails({ ...word, wordlistSource: "old-list" }, entry, "current-list"),
	[["正式名称", "同名B"]], "retained words must not inherit another list's metadata");
assert.deepEqual(await wordDetails({ id: "custom-1", original: "自由", surface: "自由" }, entry),
	[["入力方法", "自由入力"]]);
assert.deepEqual(await wordDetails({ ...word, id: "missing" }, entry), [["正式名称", "同名B"]]);

const fetchBefore = globalThis.fetch;
let requests = 0;
try {
	globalThis.fetch = async () => { requests++; return new Response(csvText); };
	const builtIn = { ...entry, value: "STATION", csvText: undefined, dbtype: "tidy", filepath: "wordlists/stations.csv" };
	assert.deepEqual(await wordDetails(word, builtIn), [...details]);
	await wordDetails(word, builtIn);
	assert.equal(requests, 1, "reopening details reuses the current list");
	globalThis.fetch = async () => { requests++; return new Response("", { status: 503 }); };
	const unavailable = { ...builtIn, filepath: "wordlists/unavailable.csv" };
	await assert.rejects(wordDetails(word, unavailable), /503/);
	globalThis.fetch = async () => { requests++; return new Response(csvText); };
	assert.deepEqual(await wordDetails(word, unavailable), [...details], "a failed request can be retried");
	assert.equal(requests, 3);
} finally {
	globalThis.fetch = fetchBefore;
}
console.log("[ok] word details: identity, source isolation, custom input, built-in CSV, caching and retry");
