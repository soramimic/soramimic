// Portable display-text / confirmed-reading correspondence. All offsets are
// UTF-16, half-open ranges, matching JavaScript strings and the editor JSON.
export const LYRIC_ALIGNMENT_FORMAT = "soramimic-lyric-alignment/1";

const vowels = ["アカサタナハマヤラワガザダバパァャヮ", "イキシチニヒミリギジヂビピィ",
	"ウクスツヌフムユルグズヅブプヴゥュ", "エケセテネヘメレゲゼデベペェ", "オコソトノホモヨロヲゴゾドボポォョ"];
export function normalizeAlignmentReading(text) {
	const kata = text.replace(/[\s、。,.!?!?・「」『』()〜~-]/g, "")
		.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/ヲ/g, "オ");
	let out = "";
	for (const c of kata) {
		const previous = out.at(-1);
		const vowel = vowels.findIndex(row => row.includes(previous || "\0"));
		out += previous !== "ー" && ((c === "ウ" && [2, 4].includes(vowel))
			|| (c === "イ" && [1, 3].includes(vowel)) || "アイウエオ"[vowel] === c) ? "ー" : c;
	}
	return out;
}

// SequenceMatcher's longest contiguous matches, with autojunk disabled, as in
// Video's subtitle alignment. Keep the same earliest-source/target tie breaks.
export function readingPositions(source, target, support = {}) {
	support.aligned = !!source && source === target;
	if (!source) return [0];
	if (source === target) return Array.from({ length: source.length + 1 }, (_, i) => i);
	if (source.length * target.length > 4_000_000) return null;
	const blocks = [];
	const queue = [[0, source.length, 0, target.length]];
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop();
		let bestA = alo, bestB = blo, size = 0, previous = new Map();
		for (let i = alo; i < ahi; i++) {
			const current = new Map();
			for (let j = blo; j < bhi; j++) {
				if (source[i] !== target[j]) continue;
				const length = (previous.get(j - 1) || 0) + 1;
				current.set(j, length);
				if (length > size) { bestA = i - length + 1; bestB = j - length + 1; size = length; }
			}
			previous = current;
		}
		if (!size) continue;
		blocks.push([bestA, bestB, size]);
		if (alo < bestA && blo < bestB) queue.push([alo, bestA, blo, bestB]);
		if (bestA + size < ahi && bestB + size < bhi) queue.push([bestA + size, ahi, bestB + size, bhi]);
	}
	blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged = [];
	for (const block of blocks) {
		const last = merged.at(-1);
		if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2];
		else merged.push([...block]);
	}
	merged.push([source.length, target.length, 0]);
	const positions = Array(source.length + 1).fill(0);
	const round = value => value % 1 === .5 ? 2 * Math.round(value / 2) : Math.round(value);
	const fill = (a, b, c, d) => {
		if (a === b) { positions[a] = d; return; }
		for (let i = a; i <= b; i++) positions[i] = c + round((i - a) * (d - c) / (b - a));
	};
	support.aligned = blocks.reduce((n, b) => n + b[2], 0) >= source.length * .35;
	if (!support.aligned) {
		fill(0, source.length, 0, target.length);
		return positions;
	}
	let a = 0, b = 0;
	for (const [i, j, length] of merged) {
		if (a !== i || b !== j) fill(a, i, b, j);
		if (length) fill(i, i + length, j, j + length);
		a = i + length; b = j + length;
	}
	return positions;
}

export function validLyricAlignment(value, text, reading) {
	if (value?.format !== LYRIC_ALIGNMENT_FORMAT || value.text !== text || value.reading !== reading
		|| !Array.isArray(value.spans) || value.spans.length > 10000) return false;
	let surfaceEnd = 0, readingEnd = 0;
	for (const span of value.spans) {
		if (!Array.isArray(span?.surface) || span.surface.length !== 2
			|| !Array.isArray(span.reading) || span.reading.length !== 2 || typeof span.exact !== "boolean") return false;
		const [a, b] = span.surface, [c, d] = span.reading;
		if (![a, b, c, d].every(Number.isInteger) || a < surfaceEnd || b <= a || b > text.length
			|| c < readingEnd || d < c || d > reading.length
			|| [a, b].some(i => i > 0 && i < text.length && /[\uDC00-\uDFFF]/.test(text[i]))
			|| (span.exact && c === d)) return false;
		surfaceEnd = b; readingEnd = d;
	}
	return true;
}

export function alignLyricTokens(text, reading, tokens) {
	if (tokens.map(t => t[0]).join("") !== text) return null;
	const readings = tokens.map(t => normalizeAlignmentReading(t[1]));
	const source = normalizeAlignmentReading(readings.join("")), target = normalizeAlignmentReading(reading);
	if (target.length !== reading.length) return null;
	const support = {};
	const positions = readingPositions(source, target, support);
	if (!positions) return null;
	let surface = 0, offset = 0;
	const spans = tokens.map(([part], i) => {
		const a = surface, from = offset, c = positions[offset];
		surface += part.length; offset += readings[i].length;
		const d = positions[offset];
		return { surface: [a, surface], reading: [c, d],
			exact: support.aligned && d > c && source.slice(from, offset) === target.slice(c, d) };
	});
	return { format: LYRIC_ALIGNMENT_FORMAT, text, reading, spans };
}

export function lyricAlignmentRanges(alignment, text, units, matches) {
	const reading = units.map(u => u.pronunciation).join("");
	if (!validLyricAlignment(alignment, text, reading)) return null;
	const offsets = [0];
	for (const unit of units) offsets.push(offsets.at(-1) + unit.pronunciation.length);
	const ranges = [];
	for (const match of matches) {
		const start = offsets[match.start], end = offsets[match.end];
		const spans = alignment.spans.filter(s => s.reading[0] < s.reading[1]
			&& s.reading[0] < end && start < s.reading[1]);
		let cursor = start;
		for (const span of spans) {
			if (!span.exact || span.reading[0] > cursor) break;
			cursor = Math.max(cursor, span.reading[1]);
		}
		if (spans.length && cursor >= end) ranges.push([spans[0].surface[0], spans.at(-1).surface[1]]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const range of ranges) {
		if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
		else merged.push(range);
	}
	return merged;
}
