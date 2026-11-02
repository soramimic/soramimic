import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Parser } from "../frontend/src/lib/wordList.js";
import { facetClause } from "../frontend/src/convertControls.js";

const setting = JSON.parse(readFileSync(new URL("../conf/setting.json", import.meta.url)));
const biology = setting.wordlist.find((entry) => entry.label === "生物");
assert.ok(biology, "生物グループが存在する");

const marine = biology.items.find((entry) => entry.value === "MARINE_LIFE");
assert.ok(marine, "海の動物リストが存在する");
assert.equal(marine.text, "海の動物");

const vertebrates = biology.items.find((entry) => entry.value === "SEKITSUI");
assert.ok(vertebrates, "脊椎動物リストが存在する");
assert.equal(vertebrates.text, "脊椎動物");
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

// Each creator belongs to exactly one subscriber band, including unknown counts.
// Combining a band with image availability must select the intersection.
for (const name of ["YOUTUBER", "VTUBER"]) {
  const entry = setting.wordlist.find((item) => item.value === name);
  const lines = readFileSync(new URL(`../${entry.filepath}`, import.meta.url), "utf8").split(/\r?\n/);
  const header = lines.shift().split(",");
  const rows = lines.filter(Boolean).map((line) => line.split(","));
  const bands = entry.facets.find((facet) => facet.column === "subscriber_band");
  const images = entry.facets.find((facet) => facet.column === "has_image");
  const parser = Parser();
  assert.equal(bands.values.reduce((sum, value) =>
    sum + parser.filter(facetClause(bands, value), header, rows).length, 0), rows.length);
  assert.ok(bands.values.every((value) => value.default));
  assert.ok(images.values.every((value) => value.default));
  const band = bands.values.find((value) => value.v === "100k_plus");
  const image = images.values.find((value) => value.v === "yes");
  const filtered = parser.filter(`${facetClause(bands, band)} and ${facetClause(images, image)}`, header, rows);
  assert.ok(filtered.length > 0);
  assert.deepEqual(filtered, rows.filter((row) =>
    Number(row[header.indexOf("subscribers")]) >= 100000 && row[header.indexOf("has_image")] === "yes"));
}

console.log("setting wordlists: OK");
