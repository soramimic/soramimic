import { syllableVariations } from "./lib/kanaToSyllable.js";

// Use the same pronunciation variants, distances and note weights as replacement.
// Bound the query's variant expansion before allocating its one-word dictionary.
export async function findPlacements(app, kana, unitsList, param, weightsList, signal) {
	if (!kana || kana.length > 100 || !/^[ァ-ヴー]+$/.test(kana)) {
		throw new Error("読みをかなで入力してください（100文字まで）");
	}
	const syllables = app.textAnalyzer.yomiToSyllable(kana);
	let count = 1;
	for (const syllable of syllables) {
		count *= syllableVariations(syllable).length;
		if (count > 4096) throw new Error("読みが複雑すぎるため、短い単語で検索してください");
	}
	const db = {};
	for (const pronunciation of app.textAnalyzer.yomiToVariation(kana)) {
		if (!pronunciation.length) continue;
		(db[pronunciation.length] ||= []).push({
			id: "search", kana, pronunciation, vcost: pronunciation.vcost || 0,
		});
	}
	const maximum = Math.max(0, ...Object.keys(db).map(Number));
	const search = app.soramimiMaker.createCandidateSearch(db, param);
	const matches = [];
	let yielded = performance.now();
	for (let line = 0; line < unitsList.length; line++) {
		const units = unitsList[line] || [];
		const minimums = units.map((unit) => Math.min(...syllableVariations(unit.pronunciation)
			.map(({ u }) => u.filter(Boolean).length)));
		const boundary = (i) => i === 0 || i === units.length || units[i].char_index === undefined
			|| units[i - 1].char_index !== units[i].char_index;
		const lineMatches = [];
		for (let start = 0; start < units.length; start++) {
			if (!boundary(start)) continue;
			let minimum = 0;
			for (let end = start + 1; end <= units.length; end++) {
				minimum += minimums[end - 1];
				if (minimum > maximum) break;
				if (performance.now() - yielded > 12) {
					await new Promise((resolve) => setTimeout(resolve, 0));
					yielded = performance.now();
				}
				if (signal?.aborted) return [];
				if (!boundary(end)) continue;
				const target = units.slice(start, end).map((unit) => unit.pronunciation);
				const candidate = search(target, 1,
					weightsList?.[line]?.slice(start, end))[0];
				if (!candidate || !Number.isFinite(candidate.sim)) continue;
				lineMatches.push({ line, start, end,
					score: candidate.sim / Math.max(target.length, candidate.pronunciation.length),
					lengthDifference: Math.abs(target.length - syllables.length),
				});
			}
		}
		// Keep distinct ranges so overlapping variations do not fill the shortlist.
		lineMatches.sort(compare);
		const distinct = [];
		for (const match of lineMatches) {
			if (distinct.some((other) => match.start < other.end && other.start < match.end)) continue;
			distinct.push(match);
			if (distinct.length === 10) break;
		}
		matches.push(...distinct);
	}
	return matches.sort(compare).slice(0, 10);
}

function compare(a, b) {
	return a.score - b.score || a.lengthDifference - b.lengthDifference
		|| a.line - b.line || a.start - b.start || a.end - b.end;
}

// Only mark exact surface offsets. Host-provided spellings may differ from units;
// in that case highlight the line and show the precise reading range separately.
export function highlightOriginal(node, units, matches) {
	if (!matches.length) return;
	const source = units.map((unit) => unit.surface_form).join("");
	if (source !== node.textContent) {
		node.classList.add("reverse-line-match");
		return;
	}
	const offsets = [0];
	for (const unit of units) offsets.push(offsets.at(-1) + unit.surface_form.length);
	let cursor = 0;
	node.textContent = "";
	for (const match of [...matches].sort((a, b) => a.start - b.start)) {
		const start = offsets[match.start], end = offsets[match.end];
		node.append(document.createTextNode(source.slice(cursor, start)));
		const mark = document.createElement("mark");
		mark.textContent = source.slice(start, end);
		node.append(mark);
		cursor = end;
	}
	node.append(document.createTextNode(source.slice(cursor)));
}
