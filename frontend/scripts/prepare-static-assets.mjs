import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUDFLARE_PAGES_FILE_LIMIT = 25 * 1024 * 1024;
export const REQUIRED_WORDLIST_COLUMNS = ["id", "original", "surface", "pronunciation"];
export const OMITTED_WORDLIST_COLUMNS = new Set(["image", "image_page", "description", "wikidata"]);

// 変換で必須の列と、設定の絞り込みが参照する列を導出する。
// 外部ホストは設定にない属性列をwhereで参照できるため、実際の射影ではこれらに
// 加えて画像URL・説明文等の明示的な除外列以外をすべて残す。
export function wordlistConfigColumns(entry) {
	const columns = new Set(REQUIRED_WORDLIST_COLUMNS);
	const addWhereColumns = (where) => {
		if (!where) return;
		for (const match of where.matchAll(/([^\s()=!~]+)\s*(?:!~=|~=|!=|=)/g)) {
			columns.add(match[1]);
		}
	};
	addWhereColumns(entry.where);
	for (const facet of entry.facets || []) {
		for (const column of facet.columns || [facet.column]) {
			if (column) columns.add(column);
		}
		for (const item of facet.values || []) addWhereColumns(item.where);
	}
	return columns;
}

// 現行wordlist CSVは引用符・埋め込み改行を使わない契約。ビルド時だけの処理なので
// 全量を読み、検証完了後に一時ファイルへ書いてから置換する。readlineの非同期反復は
// 大きな出力のbackpressure時にNode 24でERR_USE_AFTER_CLOSEになり得るため使わない。
export async function projectWordlistCsv(inputPath, outputPath, requiredColumns, label = inputPath) {
	const temporaryPath = `${outputPath}.tmp`;

	try {
		const text = await readFile(inputPath, "utf8");
		const lines = text.split(/\r\n|\n|\r/);
		if (lines.at(-1) === "") lines.pop();
		if (lines.length === 0 || lines[0] === "") throw new Error(`${label}が空です`);
		if (lines[0].includes('"')) throw new Error(`${label}の1行目に未対応の文字があります`);
		const header = lines[0].split(",");
		if (new Set(header).size !== header.length) {
			throw new Error(`${label}のヘッダーに重複列があります`);
		}
		const columns = header.filter((column) => !OMITTED_WORDLIST_COLUMNS.has(column));
		for (const column of requiredColumns) {
			if (!columns.includes(column)) throw new Error(`${label}に必要な列がありません: ${column}`);
		}
		const indexes = columns.map((column) => header.indexOf(column));
		const outputLines = [columns.join(",")];
		for (let index = 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.includes('"')) throw new Error(`${label}の${index + 1}行目に未対応の文字があります`);
			if (line === "") throw new Error(`${label}の${index + 1}行目が空です`);
			const row = line.split(",");
			if (row.length !== header.length) {
				throw new Error(`${label}の${index + 1}行目の列数が不正です`);
			}
			for (const column of ["id", "original", "surface"]) {
				if (row[indexes[columns.indexOf(column)]] === "") {
					throw new Error(`${label}の${index + 1}行目の${column}が空です`);
				}
			}
			outputLines.push(indexes.map((columnIndex) => row[columnIndex]).join(","));
		}
		await writeFile(temporaryPath, outputLines.join("\n"), "utf8");
		await rename(temporaryPath, outputPath);
		return { rowCount: lines.length - 1, columns };
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

function configuredWordlists(config) {
	return config.wordlist.flatMap((entry) => entry.items || [entry])
		.filter((entry) => entry.dbtype === "tidy" && entry.filepath);
}

// 同じCSVを複数の設定エントリが共有しても、どちらかが使う列を落とさない。
export function wordlistProjectionPlans(config) {
	const byPath = new Map();
	for (const entry of configuredWordlists(config)) {
		let plan = byPath.get(entry.filepath);
		if (!plan) {
			plan = { filepath: entry.filepath, values: [], columns: new Set() };
			byPath.set(entry.filepath, plan);
		}
		plan.values.push(entry.value);
		for (const column of wordlistConfigColumns(entry)) plan.columns.add(column);
	}
	return [...byPath.values()].map((plan) => ({ ...plan, columns: [...plan.columns] }));
}

function assetPath(dist, filepath) {
	const path = resolve(dist, filepath);
	if (path !== dist && !path.startsWith(`${dist}${sep}`)) {
		throw new Error(`単語リストのパスが配信ディレクトリ外です: ${filepath}`);
	}
	return path;
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
	const config = JSON.parse(await readFile(resolve(dist, "conf/setting.json"), "utf8"));
	const projections = [];
	for (const plan of wordlistProjectionPlans(config)) {
		const path = assetPath(dist, plan.filepath);
		const result = await projectWordlistCsv(path, path, plan.columns, plan.filepath);
		projections.push({ values: plan.values, filepath: plan.filepath, ...result });
	}
	const oversized = await findOversizedFiles(dist);
	if (oversized.length > 0) {
		const details = oversized
			.map(({ path, size }) => `${relative(dist, path)} (${(size / 1024 / 1024).toFixed(1)} MiB)`)
			.join(", ");
		throw new Error(`Cloudflare Pagesの25 MiB上限を超えるファイルがあります: ${details}`);
	}
	return projections;
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
	const results = await prepareStaticAssets(dist);
	const rows = results.reduce((sum, result) => sum + result.rowCount, 0);
	console.log(`[assets] 単語リスト${results.length}件を計${rows.toLocaleString()}行へ射影しました`);
}
