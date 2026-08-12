import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUDFLARE_PAGES_FILE_LIMIT,
	SCHOOL_DELIVERY_COLUMNS,
	findOversizedFiles,
	projectSchoolCsv,
	schoolConfigColumns,
} from "../scripts/prepare-static-assets.mjs";

const sourcePath = new URL("../../wordlists/school.csv", import.meta.url);
const deliveryPath = new URL("../dist/wordlists/school.csv", import.meta.url);
const [sourceText, deliveryText] = await Promise.all([
	readFile(sourcePath, "utf8"),
	readFile(deliveryPath, "utf8"),
]);
const sourceLines = sourceText.trimEnd().split(/\r?\n/);
const deliveryLines = deliveryText.trimEnd().split(/\r?\n/);
const sourceHeader = sourceLines[0].split(",");

assert.deepEqual(deliveryLines[0].split(","), SCHOOL_DELIVERY_COLUMNS,
	"配信用school.csvの列が想定と異なる");
assert(!deliveryText.endsWith("\n"), "配信用school.csvに不要な末尾改行がある");
assert.equal(deliveryLines.length, sourceLines.length,
	"配信用school.csvの行数が原本と異なる");

const indexes = SCHOOL_DELIVERY_COLUMNS.map((column) => sourceHeader.indexOf(column));
for (let line = 1; line < sourceLines.length; line += 1) {
	const source = sourceLines[line].split(",");
	assert.equal(deliveryLines[line], indexes.map((index) => source[index]).join(","),
		`配信用school.csvの${line + 1}行目が原本と異なる`);
}

const deliveryBytes = Buffer.byteLength(deliveryText);
assert(deliveryBytes < CLOUDFLARE_PAGES_FILE_LIMIT,
	`配信用school.csvが25 MiB以上: ${deliveryBytes}`);
const oversized = await findOversizedFiles(fileURLToPath(new URL("../dist", import.meta.url)));
assert.deepEqual(oversized, [], "distにCloudflare Pagesの上限超過ファイルがある");

assert.deepEqual([...schoolConfigColumns({
	where: "status=current",
	facets: [{
		columns: ["type1", "type2"],
		values: [{ v: "国立", where: "founder=国立 and prefecture!=東京都" }],
	}],
})].sort(), [
	"founder", "id", "original", "prefecture", "pronunciation", "status",
	"surface", "type1", "type2",
], "学校設定のwhere・複数列facetから依存列を抽出できない");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "soramimic-school-assets-"));
try {
	const input = join(temporaryDirectory, "input.csv");
	const output = join(temporaryDirectory, "output.csv");
	await writeFile(output, "既存の内容", "utf8");
	await writeFile(input, "id,original,surface,pronunciation,type,school_type\n1,学校,学校,ガッコウ,name,大学", "utf8");
	await assert.rejects(projectSchoolCsv(input, output), /status/,
		"必要列がないCSVを受理した");
	assert.equal(await readFile(output, "utf8"), "既存の内容",
		"射影失敗時に既存ファイルを変更した");
	await assert.rejects(readFile(`${output}.tmp`, "utf8"), { code: "ENOENT" },
		"射影失敗時の一時ファイルが残っている");

	await writeFile(input,
		'id,original,surface,pronunciation,type,school_type,status\n1,"学校",学校,ガッコウ,name,大学,current',
		"utf8");
	await assert.rejects(projectSchoolCsv(input, output), /未対応の文字/,
		"引用符を含むCSVを受理した");
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`[ok] static assets test passed (school.csv: ${(deliveryBytes / 1024 / 1024).toFixed(1)} MiB)`);
