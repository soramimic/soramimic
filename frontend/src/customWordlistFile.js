import { countWordlistInputRows } from "./wordlistInput.js";

// Soramimic Video の自作リストCSVと同じ既定上限。
export const CUSTOM_WORDLIST_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CUSTOM_WORDLIST_FILE_MAX_ROWS = 10000;

function decode(bytes) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("文字コードを読めません。UTF-8かShift_JISで保存してください");
		}
	}
}

export function countCustomWordlistRows(text) {
	return countWordlistInputRows(text);
}

export function wordlistNameFromFilename(filename) {
	return String(filename || "").replace(/\.(csv|txt)$/i, "").trim();
}

export async function readCustomWordlistFile(file) {
	if (!file) throw new Error("ファイルが選択されていません");
	if (file.size > CUSTOM_WORDLIST_FILE_MAX_BYTES) {
		throw new Error(
			`ファイルが大きすぎます(${(file.size / 1024 / 1024).toFixed(1)}MB)。`
			+ `${CUSTOM_WORDLIST_FILE_MAX_BYTES / 1024 / 1024}MBまでにしてください`);
	}
	const text = decode(await file.arrayBuffer());
	const rows = countCustomWordlistRows(text);
	if (rows === 0) throw new Error("単語が入っていません");
	if (rows > CUSTOM_WORDLIST_FILE_MAX_ROWS) {
		throw new Error(
			`行数が多すぎます(${rows.toLocaleString()}行)。`
			+ `${CUSTOM_WORDLIST_FILE_MAX_ROWS.toLocaleString()}行までにしてください`);
	}
	return {
		text,
		rows,
		name: wordlistNameFromFilename(file.name),
	};
}
