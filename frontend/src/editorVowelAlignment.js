import { charToVowel, syllableVariations, longVowelExpansion } from "./lib/kanaToSyllable.js";

export function unitVowel(unit) {
	return charToVowel(unit.replace(/ョ/g, "ヨ").replace(/^ヲ/, "オ"));
}

// Removing a nasal/geminate is allowed; replacing it with a vowel is not.
function onlyDeletesNasals(original, candidate) {
	let cursor = 0;
	for (const unit of original) {
		if (unit === candidate[cursor]) cursor++;
		else if (!/^[ンッ]$/.test(unit)) return false;
	}
	return cursor === candidate.length;
}

function vowelGraph(syllables) {
	const graph = [[]];
	let start = 0;
	for (const raw of syllables) {
		if (raw === null) continue;
		const part = raw.replace(/ョ/g, "ヨ");
		const choices = syllableVariations(part).map(({u, c}) => ({ units: u.filter(Boolean), cost: c }));
		const native = choices.filter(({cost}) => cost === 0);
		const alternatives = native.length ? choices.filter(({units, cost}) => cost === 0
			|| native.some((original) => onlyDeletesNasals(original.units, units))) : [{ units: [part] }];
		const projected = [...new Map(alternatives.map(({units}) => {
			const vowels = units.map((unit) => ({ vowel: unitVowel(unit),
				extra: longVowelExpansion(unit)?.[1] ?? null }));
			return [JSON.stringify(vowels), vowels];
		})).values()];
		const branches = projected.map((units) => ({ units,
			middle: units.slice(1).map(() => graph.push([]) - 1) }));
		const end = graph.push([]) - 1;
		for (const {units, middle} of branches) {
			const path = [start, ...middle, end];
			for (let i = 0; i < Math.max(1, units.length); i++) {
				graph[path[i]].push({ end: path[i + 1], vowel: units[i]?.vowel ?? null });
				if (units[i]?.extra) {
					const extraNode = graph.push([]) - 1;
					graph[path[i]].push({ end: extraNode, vowel: units[i].vowel });
					graph[extraNode].push({ end: path[i + 1], vowel: units[i].extra });
				}
			}
		}
		start = end;
	}
	return { edges: graph, end: start };
}

// Intersect the two finite pronunciation graphs without enumerating variants.
// Real long vowels may stay whole or split; nasal lengthening cannot supply
// a missing vowel, even when generation selected that pronunciation variant.
export function sameVowelAlignment(source, word) {
	const left = vowelGraph(source), right = vowelGraph(word);
	const pending = [[0, 0]], seen = new Set(["0/0"]);
	const add = (a, b) => {
		const key = `${a}/${b}`;
		if (seen.has(key)) return;
		seen.add(key);
		pending.push([a, b]);
	};
	while (pending.length) {
		const [a, b] = pending.pop();
		if (a === left.end && b === right.end) return true;
		for (const edge of left.edges[a]) {
			if (edge.vowel === null) add(edge.end, b);
			else for (const other of right.edges[b]) {
				if (other.vowel !== null && edge.vowel === other.vowel) add(edge.end, other.end);
			}
		}
		for (const edge of right.edges[b]) if (edge.vowel === null) add(a, edge.end);
	}
	return false;
}
