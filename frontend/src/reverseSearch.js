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
		const lineMatches = [];
		// Match on reading units, including ranges inside a character's reading.
		// Character boundaries are only relevant when mapping matches to display text.
		for (let start = 0; start < units.length; start++) {
			let minimum = 0;
			for (let end = start + 1; end <= units.length; end++) {
				minimum += minimums[end - 1];
				if (minimum > maximum) break;
				if (performance.now() - yielded > 12) {
					await new Promise((resolve) => setTimeout(resolve, 0));
					yielded = performance.now();
				}
				if (signal?.aborted) return [];
				const target = units.slice(start, end).map((unit) => unit.pronunciation);
				const candidate = search(target, 1,
					weightsList?.[line]?.slice(start, end))[0];
				if (!candidate || !Number.isFinite(candidate.sim)) continue;
				lineMatches.push({ line, start, end,
					// Keep the total distance so longer ranges retain their variation penalties.
					score: candidate.sim,
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

// Reading edits can change the character alignment. Map each token separately,
// and leave unaligned characters unmarked instead of highlighting the whole line.
export function originalHighlightRanges(source, units, matches, tokens = []) {
	let spans = [];
	if (units.map((unit) => unit.surface_form).join("") === source) {
		let offset = 0;
		spans = units.map((unit) => {
			const start = offset;
			offset += unit.surface_form.length;
			return [start, offset];
		});
	} else if (tokens.map((token) => token.surface_form).join("") === source) {
		let offset = 0;
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			const group = units.map((unit, i) => ({ unit, i }))
				.filter(({ unit }) => unit.token_index === index);
			// If a reading no longer maps exactly to its spelling, only that token
			// is uncertain; other tokens in the line still have precise offsets.
			const aligned = group.map(({ unit }) => unit.surface_form).join("") === token.surface_form;
			let cursor = offset;
			for (const { unit, i } of group) {
				spans[i] = aligned ? [cursor, cursor + unit.surface_form.length]
					: token.surface_form.length < source.length ? [offset, offset + token.surface_form.length] : null;
				cursor += unit.surface_form.length;
			}
			offset += token.surface_form.length;
		}
	} else {
		return [];
	}
	// A kanji's spelling is stored on its first reading unit; later units can
	// have empty surfaces. Give every unit the whole character's display span.
	for (let start = 0; start < units.length;) {
		let end = start + 1;
		while (units[start].char_index !== undefined && end < units.length
			&& units[end].char_index === units[start].char_index) end++;
		if (end > start + 1) {
			const group = Array.from(spans.slice(start, end));
			if (group.length === end - start && group.every(Boolean)) {
				const span = [Math.min(...group.map(([from]) => from)), Math.max(...group.map(([, to]) => to))];
				for (let i = start; i < end; i++) spans[i] = span;
			}
		}
		start = end;
	}
	const ranges = matches.flatMap(({ start, end }) => {
		const selected = Array.from(spans.slice(start, end));
		if (selected.length !== end - start || selected.some((span) => !span)) return [];
		return [[Math.min(...selected.map((span) => span[0])), Math.max(...selected.map((span) => span[1]))]];
	}).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const range of ranges) {
		if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
		else merged.push(range);
	}
	return merged;
}

export function highlightOriginal(node, units, matches, tokens) {
	const source = node.textContent;
	const ranges = originalHighlightRanges(source, units, matches, tokens);
	if (!ranges.length) return;
	let cursor = 0;
	node.textContent = "";
	for (const [start, end] of ranges) {
		node.append(document.createTextNode(source.slice(cursor, start)));
		const mark = document.createElement("mark");
		mark.className = "reverse-highlight";
		mark.textContent = source.slice(start, end);
		node.append(mark);
		cursor = end;
	}
	node.append(document.createTextNode(source.slice(cursor)));
}
