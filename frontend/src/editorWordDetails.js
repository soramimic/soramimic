import { fetchText } from "./api.js";
import { isCurrentWord, wordlistKey } from "./editorWordIdentity.js";

const labels = {
	team: "所属チーム", position: "ポジション", prefecture: "都道府県", city: "市区町村",
	lines: "路線", operator: "運営会社", opened_year: "開業年", station_code: "駅番号",
	capital: "首都", continent: "大陸", population: "人口", population_year: "人口の調査年",
	area_km2: "面積（km²）", established_year: "成立年", ended_year: "終了年",
	parent: "所属自治体", municipality_type: "自治体の種類", school_type: "校種", founder: "設置者",
	class: "分類", order: "目", family: "科",
	genus: "属・分類", scientific_name: "学名", type1: "タイプ1", type2: "タイプ2",
	height_m: "高さ（m）", weight_kg: "重さ（kg）", evolves_from: "進化前",
	field: "分野", era: "時代", birth_year: "生年", death_year: "没年", country: "国",
	nationality: "国籍", org: "所属", debut_year: "デビュー年", subject: "教科", year: "年",
	achievement: "業績", title: "作品", org_name: "所属", role_in_org: "役割",
	first_year: "初登場年", cv_name: "声優", description: "説明",
};

// Keep only the current list's CSV; details do not expand the pronunciation DB
// or become part of saved lyrics and undo history.
let cachedList;
async function listText(entry) {
	if (typeof entry?.csvText === "string") return entry.csvText;
	if (entry?.dbtype !== "tidy" || !entry.filepath) return "";
	const key = wordlistKey(entry);
	if (cachedList?.key !== key) {
		const pending = { key, text: fetchText(entry.filepath) };
		cachedList = pending;
		pending.text.catch(() => { if (cachedList === pending) cachedList = null; });
	}
	return cachedList.text;
}

function findRow(text, word) {
	// Published and normalized custom CSVs have no quoted commas or newlines.
	// Iterate lines without allocating an array for a whole large word list.
	const lines = text.matchAll(/[^\r\n]+/g);
	const header = lines.next().value?.[0].split(",").map((value) => value.trim()) || [];
	const id = header.indexOf("id"), surface = header.indexOf("surface"), original = header.indexOf("original");
	if (id < 0 || surface < 0) return null;
	for (const [line] of lines) {
		const cells = line.split(",").map((value) => value.trim());
		if (cells[id] !== String(word.id) || cells[surface] !== word.surface) continue;
		if (word.original && original >= 0 && cells[original] !== word.original) continue;
		return Object.fromEntries(header.map((column, index) => [column, cells[index]]));
	}
	return null;
}

export async function wordDetails(word, entry, source) {
	const rows = [];
	if (word.original && word.original !== word.surface) rows.push(["正式名称", word.original]);
	if (String(word.id).startsWith("custom-")) return [...rows, ["入力方法", "自由入力"]];
	// The same ID in a newly selected list must not describe a retained old word.
	if (!isCurrentWord(word, source)) return rows;
	const record = findRow(await listText(entry), word);
	if (!record) return rows;
	for (const [column, label] of Object.entries(labels)) {
		const value = record[column];
		if (value && !/^(?:na|n\/a|unknown)$/i.test(value)) rows.push([label, value]);
	}
	for (const facet of entry.facets || []) {
		if (labels[facet.column]) continue;
		const value = facet.values?.find((item) => item.v === record[facet.column]);
		if (value) rows.push([facet.label, value.label]);
	}
	return rows;
}

export function appendWordDetails(selected, word, entry, source) {
	if (!word || word.filler) return;
	const section = document.createElement("details");
	section.className = "review-word-details";
	section.hidden = true;
	selected.append(section);
	wordDetails(word, entry, source).then((rows) => {
		if (!section.isConnected) return;
		if (!rows.length) {
			section.remove();
			return;
		}
		const summary = document.createElement("summary");
		const preview = document.createElement("span");
		preview.className = "review-word-summary";
		preview.textContent = rows.slice(0, 3).map(([, value]) => value).join(" · ");
		summary.setAttribute("aria-label", `${word.surface}の詳細：${preview.textContent}`);
		summary.append(preview);
		const list = document.createElement("dl");
		for (const [label, value] of rows) {
			const term = document.createElement("dt");
			term.textContent = label;
			const detail = document.createElement("dd");
			detail.textContent = value;
			list.append(term, detail);
		}
		section.append(summary, list);
		section.hidden = false;
	}).catch(() => section.remove());
}
