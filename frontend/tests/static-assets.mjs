import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUDFLARE_PAGES_FILE_LIMIT,
	OMITTED_WORDLIST_COLUMNS,
	REQUIRED_WORDLIST_COLUMNS,
	findOversizedFiles,
	projectWordlistCsv,
	pruneUnconfiguredWordlists,
	wordlistConfigColumns,
	wordlistProjectionPlans,
} from "../scripts/prepare-static-assets.mjs";

const config = JSON.parse(await readFile(new URL("../../conf/setting.json", import.meta.url), "utf8"));
const plans = wordlistProjectionPlans(config);
let sourceBytes = 0;
let deliveryBytes = 0;

for (const plan of plans) {
	const filename = plan.filepath.replace(/^wordlists\//, "");
	const [sourceText, deliveryText] = await Promise.all([
		readFile(new URL(`../../wordlists/${filename}`, import.meta.url), "utf8"),
		readFile(new URL(`../dist/wordlists/${filename}`, import.meta.url), "utf8"),
	]);
	const sourceLines = sourceText.trimEnd().split(/\r?\n/);
	const deliveryLines = deliveryText.trimEnd().split(/\r?\n/);
	const sourceHeader = sourceLines[0].split(",");
	const columns = sourceHeader.filter((column) => !OMITTED_WORDLIST_COLUMNS.has(column));

	assert.deepEqual(deliveryLines[0].split(","), columns,
		`配信用${filename}から重量列だけを除外できていない`);
	for (const required of plan.columns) {
		assert(columns.includes(required), `配信用${filename}に設定の依存列${required}がない`);
	}
	assert(!deliveryText.endsWith("\n"), `配信用${filename}に不要な末尾改行がある`);
	assert.equal(deliveryLines.length, sourceLines.length,
		`配信用${filename}の行数が原本と異なる`);
	const indexes = columns.map((column) => sourceHeader.indexOf(column));
	for (let line = 1; line < sourceLines.length; line += 1) {
		const source = sourceLines[line].split(",");
		assert.equal(deliveryLines[line], indexes.map((index) => source[index]).join(","),
			`配信用${filename}の${line + 1}行目が原本と異なる`);
	}
	sourceBytes += Buffer.byteLength(sourceText);
	deliveryBytes += Buffer.byteLength(deliveryText);
}

assert(deliveryBytes < sourceBytes, "単語リスト全体の配信サイズが縮小されていない");
const oversized = await findOversizedFiles(fileURLToPath(new URL("../dist", import.meta.url)));
assert.deepEqual(oversized, [], "distにCloudflare Pagesの上限超過ファイルがある");

assert.deepEqual([...wordlistConfigColumns({
	where: "status=current",
	facets: [{
		columns: ["type1", "type2"],
		values: [{ v: "国立", where: "founder=国立 and prefecture!=東京都" }],
	}],
})], [
	...REQUIRED_WORDLIST_COLUMNS, "status", "type1", "type2", "founder", "prefecture",
], "where・複数列facetから依存列を抽出できない");

assert.deepEqual(wordlistProjectionPlans({ wordlist: [
	{ value: "A", filepath: "wordlists/shared.csv", dbtype: "tidy", where: "status=current" },
	{ value: "B", filepath: "wordlists/shared.csv", dbtype: "tidy", facets: [{ column: "type" }] },
] }), [{
	filepath: "wordlists/shared.csv",
	values: ["A", "B"],
	columns: [...REQUIRED_WORDLIST_COLUMNS, "status", "type"],
}], "共有CSVを参照する全設定の依存列を保持できない");

const scientistHeader = (await readFile(
	new URL("../dist/wordlists/scientist.csv", import.meta.url), "utf8")).split(/\r?\n/, 1)[0].split(",");
assert(scientistHeader.includes("country"), "外部whereで使えるcountry列が配信物から落ちている");
assert(!scientistHeader.includes("image") && !scientistHeader.includes("description"),
	"配信物に除外対象の重量列が残っている");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "soramimic-wordlist-assets-"));
try {
	const input = join(temporaryDirectory, "input.csv");
	const output = join(temporaryDirectory, "output.csv");
	await writeFile(output, "既存の内容", "utf8");
	await writeFile(input, "id,original,surface,pronunciation,type\n1,学校,学校,ガッコウ,name", "utf8");
	await assert.rejects(
		projectWordlistCsv(input, output, [...REQUIRED_WORDLIST_COLUMNS, "status"], "test.csv"),
		/status/, "必要列がないCSVを受理した");
	assert.equal(await readFile(output, "utf8"), "既存の内容",
		"射影失敗時に既存ファイルを変更した");
	await assert.rejects(readFile(`${output}.tmp`, "utf8"), { code: "ENOENT" },
		"射影失敗時の一時ファイルが残っている");

	const dist = join(temporaryDirectory, "dist");
	const wordlists = join(dist, "wordlists");
	await mkdir(wordlists, { recursive: true });
	await writeFile(join(wordlists, "kept.csv"), "keep", "utf8");
	await writeFile(join(wordlists, "hidden.csv"), "remove", "utf8");
	await writeFile(join(wordlists, "NOTICE.md"), "keep metadata", "utf8");
	assert.deepEqual(await pruneUnconfiguredWordlists(dist, [{
		filepath: "wordlists/kept.csv",
	}]), ["hidden.csv"], "設定にないCSVを配信物から除外できない");
	assert.equal(await readFile(join(wordlists, "kept.csv"), "utf8"), "keep");
	assert.equal(await readFile(join(wordlists, "NOTICE.md"), "utf8"), "keep metadata");

	await writeFile(input,
		'id,original,surface,pronunciation,status\n1,"学校",学校,ガッコウ,current', "utf8");
	await assert.rejects(
		projectWordlistCsv(input, output, [...REQUIRED_WORDLIST_COLUMNS, "status"], "test.csv"),
		/未対応の文字/, "引用符を含むCSVを受理した");

	await writeFile(input,
		"id,original,surface,pronunciation,description\n1,学校,学校,ガッコウ,説明", "utf8");
	await assert.rejects(
		projectWordlistCsv(input, output, [...REQUIRED_WORDLIST_COLUMNS, "description"], "test.csv"),
		/description/, "設定が参照する除外対象列を黙って削除した");

	await writeFile(input,
		'id,original,surface,pronunciation,"memo"\n1,学校,学校,ガッコウ,備考', "utf8");
	await assert.rejects(
		projectWordlistCsv(input, output, REQUIRED_WORDLIST_COLUMNS, "test.csv"),
		/1行目に未対応/, "引用符を含むヘッダーを受理した");
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}

const reduction = (1 - deliveryBytes / sourceBytes) * 100;
console.log(`[ok] static assets test passed (${plans.length} lists: `
	+ `${(sourceBytes / 1024 / 1024).toFixed(1)} -> ${(deliveryBytes / 1024 / 1024).toFixed(1)} MiB, `
	+ `${reduction.toFixed(1)}% reduction)`);
