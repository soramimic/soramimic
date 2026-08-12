import { createReadStream, createWriteStream } from "node:fs";
import { readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";

export const CLOUDFLARE_PAGES_FILE_LIMIT = 25 * 1024 * 1024;
export const SCHOOL_DELIVERY_COLUMNS = [
	"id",
	"original",
	"surface",
	"pronunciation",
	"type",
	"school_type",
	"status",
];

async function writeRow(output, completion, line, first) {
	if (!output.write(`${first ? "" : "\n"}${line}`)) {
		await Promise.race([once(output, "drain"), completion]);
	}
}

// school.csvには変換で使わない画像URLなどの列があり、Cloudflare Pagesの
// 1ファイル25 MiB上限を超える。原本は維持し、配信物だけを必要列へ射影する。
export async function projectSchoolCsv(inputPath, outputPath) {
	const temporaryPath = `${outputPath}.tmp`;
	const input = createReadStream(inputPath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	const output = createWriteStream(temporaryPath, { encoding: "utf8" });
	const outputFinished = finished(output);
	let indexes;
	let sourceColumnCount = 0;
	let rowCount = 0;
	let outputRowCount = 0;

	try {
		for await (const line of lines) {
			if (line.includes('"')) {
				throw new Error(`school.csvの${rowCount + 1}行目に未対応の文字があります`);
			}
			if (!indexes) {
				const header = line.split(",");
				if (new Set(header).size !== header.length) {
					throw new Error("school.csvのヘッダーに重複列があります");
				}
				sourceColumnCount = header.length;
				indexes = SCHOOL_DELIVERY_COLUMNS.map((column) => {
					const index = header.indexOf(column);
					if (index === -1) throw new Error(`school.csvに必要な列がありません: ${column}`);
					return index;
				});
				await writeRow(output, outputFinished, SCHOOL_DELIVERY_COLUMNS.join(","), outputRowCount === 0);
				outputRowCount += 1;
				continue;
			}

			if (line === "") throw new Error(`school.csvの${rowCount + 2}行目が空です`);
			const row = line.split(",");
			if (row.length !== sourceColumnCount) {
				throw new Error(`school.csvの${rowCount + 2}行目の列数が不正です`);
			}
			for (const column of ["id", "original", "surface"]) {
				if (row[headerIndex(indexes, column)] === "") {
					throw new Error(`school.csvの${rowCount + 2}行目の${column}が空です`);
				}
			}
			await writeRow(output, outputFinished,
				indexes.map((index) => row[index]).join(","), outputRowCount === 0);
			outputRowCount += 1;
			rowCount += 1;
		}
		if (!indexes) throw new Error("school.csvが空です");
		output.end();
		await outputFinished;
		await rename(temporaryPath, outputPath);
		return { rowCount, columns: SCHOOL_DELIVERY_COLUMNS };
	} catch (error) {
		output.destroy();
		await outputFinished.catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

function headerIndex(indexes, column) {
	return indexes[SCHOOL_DELIVERY_COLUMNS.indexOf(column)];
}

export function schoolConfigColumns(school) {
	const columns = new Set(["id", "original", "surface", "pronunciation"]);
	const addWhereColumns = (where) => {
		if (!where) return;
		for (const match of where.matchAll(/([^\s()=!~]+)\s*(?:!~=|~=|!=|=)/g)) {
			columns.add(match[1]);
		}
	};
	addWhereColumns(school.where);
	for (const facet of school.facets || []) {
		for (const column of facet.columns || [facet.column]) {
			if (column) columns.add(column);
		}
		for (const item of facet.values || []) addWhereColumns(item.where);
	}
	return columns;
}

async function assertSchoolFacetColumns(dist) {
	const config = JSON.parse(await readFile(resolve(dist, "conf/setting.json"), "utf8"));
	const entries = config.wordlist.flatMap((entry) => entry.items || [entry]);
	const school = entries.find((entry) => entry.value === "SCHOOL");
	if (!school) throw new Error("conf/setting.jsonにSCHOOL設定がありません");
	for (const column of schoolConfigColumns(school)) {
		if (!SCHOOL_DELIVERY_COLUMNS.includes(column)) {
			throw new Error(`学校リストの利用列が配信対象にありません: ${column}`);
		}
	}
}

export async function findOversizedFiles(root, limit = CLOUDFLARE_PAGES_FILE_LIMIT) {
	const oversized = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				const info = await stat(path);
				if (info.size > limit) oversized.push({ path, size: info.size });
			}
		}
	}
	await visit(root);
	return oversized;
}

export async function prepareStaticAssets(distDirectory) {
	const dist = resolve(distDirectory);
	const schoolCsv = resolve(dist, "wordlists/school.csv");
	await assertSchoolFacetColumns(dist);
	const projected = await projectSchoolCsv(schoolCsv, schoolCsv);
	const oversized = await findOversizedFiles(dist);
	if (oversized.length > 0) {
		const details = oversized
			.map(({ path, size }) => `${relative(dist, path)} (${(size / 1024 / 1024).toFixed(1)} MiB)`)
			.join(", ");
		throw new Error(`Cloudflare Pagesの25 MiB上限を超えるファイルがあります: ${details}`);
	}
	return projected;
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
	const result = await prepareStaticAssets(dist);
	console.log(`[assets] school.csvを${result.rowCount.toLocaleString()}行・${result.columns.length}列へ縮小しました`);
}
