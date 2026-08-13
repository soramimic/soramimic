import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setting = JSON.parse(readFileSync(new URL("../conf/setting.json", import.meta.url)));
const biology = setting.wordlist.find((entry) => entry.label === "生物");
assert.ok(biology, "生物グループが存在する");

const marine = biology.items.find((entry) => entry.value === "MARINE_LIFE");
assert.ok(marine, "海の生き物リストが存在する");
assert.equal(marine.text, "海の生き物");
assert.equal(marine.filepath, "wordlists/marine_life.csv");

const facets = Object.fromEntries(marine.facets.map((facet) => [facet.column, facet]));
assert.equal(facets.class.label, "分類");
assert.equal(facets.vertebrate.label, "脊椎区分");
assert.deepEqual(
  facets.class.values.map(({ v }) => v),
  ["哺乳類", "爬虫類", "魚類", "無脊椎動物"],
);
assert.deepEqual(
  facets.vertebrate.values.map(({ v }) => v),
  ["脊椎動物", "無脊椎動物"],
);
assert.ok(marine.facets.every((facet) => facet.values.every((value) => value.default)));

const myoji = setting.wordlist.find((entry) => entry.value === "MYOJI");
assert.ok(myoji, "名字リストが存在する");
assert.equal(myoji.where, "verified=yes");
assert.ok(!myoji.facets || myoji.facets.length === 0, "名字に絞り込みUIを表示しない");

console.log("setting wordlists: OK");
