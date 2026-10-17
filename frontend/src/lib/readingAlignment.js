import { expandRepeatedLongVowels } from "./kanaToSyllable.js";

// 音節が持つ表記をそのまままとめる。一文字に複数音節、複数文字に一音節の
// どちらも許し、文字数に合わせた読みの再配分はしない。
export function alignmentFromUnits(units) {
	const align = [];
	let leadingReading = "";
	for (const unit of units) {
		if (unit.surface_form) {
			align.push([unit.surface_form, leadingReading + unit.pronunciation]);
			leadingReading = "";
		} else if (align.length) {
			align[align.length - 1][1] += unit.pronunciation;
		} else {
			leadingReading += unit.pronunciation;
		}
	}
	return align;
}

// 表記・読みの両方が一致し、すべての境界が既存の音節境界にある時だけ採用する。
export function countsForAlignment(align, units) {
	if (!Array.isArray(align) || !align.length || !align.every((pair) =>
		Array.isArray(pair) && pair.length === 2 &&
		pair.every((part) => typeof part === "string" && part.length > 0))) return null;
	if (align.map(([surface]) => surface).join("") !==
		units.map((unit) => unit.surface_form).join("")) return null;
	const counts = [];
	let index = 0;
	for (const [, rawReading] of align) {
		const reading = expandRepeatedLongVowels(rawReading);
		const start = index;
		let matched = "";
		while (index < units.length && matched.length < reading.length) {
			matched += units[index++].pronunciation;
		}
		if (matched !== reading) return null;
		counts.push(index - start);
	}
	return index === units.length ? counts : null;
}

// 手動対応は音節化の後に反映する。対応を動かしても音節列を変えず、候補の
// period・音の重みを保つ。漢字かな混じりの語にも同じ保存形式を使う。
export function applyReadingAlignments(units, tokens) {
	if (!tokens.some((token) => token.manualAlign)) return units;
	const targets = new Map();
	for (const unit of units) {
		if (!tokens[unit.token_index]?.manualAlign) continue;
		if (!targets.has(unit.token_index)) targets.set(unit.token_index, []);
		targets.get(unit.token_index).push(unit);
	}
	let changed = false;
	for (const [tokenIndex, target] of targets) {
		const align = tokens[tokenIndex].manualAlign;
		const counts = countsForAlignment(align, target);
		if (!counts) continue;
		let index = 0;
		align.forEach(([surface], group) => {
			const identity = Symbol();
			for (let i = 0; i < counts[group]; i++) {
				const unit = target[index++];
				unit.surface_form = i === 0 ? surface : "";
				unit.char_index = identity;
			}
		});
		changed = true;
	}
	if (changed) {
		let previous;
		let index = -1;
		for (const unit of units) {
			if (unit.char_index !== previous) index++;
			previous = unit.char_index;
			unit.char_index = index;
		}
	}
	return units;
}
