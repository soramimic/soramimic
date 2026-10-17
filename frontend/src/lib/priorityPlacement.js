import { normalizePriorityWords, matchesPriorityWord } from "./priorityWords.js";
import { syllableVariations } from "./kanaToSyllable.js";

const BEAM_SIZE = 32;
const CANDIDATES_PER_WORD = 16;

export const matchesPriority = matchesPriorityWord;

export function priorityMetrics(results, preferences) {
	const words = results.flat();
	const requested = normalizePriorityWords(preferences);
	const included = requested.filter(preferred => words.some(word => matchesPriority(word, preferred)));
	const missing = requested.filter(preferred => !included.includes(preferred));
	return { requested: requested.length, included, missing,
		distance: words.reduce((sum, word) => sum + (word.filler ? 0 : word.sim || 0), 0),
		fillerUnits: words.reduce((sum, word) => sum + (word.filler ? word.period[1] - word.period[0] : 0), 0),
		wordCount: words.filter(word => !word.filler).length };
}

export function boundaryCost(units, end, param) {
	if (end <= 0 || end >= units.length) return 0;
	return units[end].phrase !== units[end - 1].phrase ? -(param.SAME_PHRASE_BREAK_REWARD || 0)
		: param.MID_PHRASE_BREAK_PENALTY || 0;
}

const overlaps = (a, b) => a.line === b.line && a.word.period[0] < b.word.period[1]
	&& b.word.period[0] < a.word.period[1];
const planKey = plan => JSON.stringify(plan.placements.map(item =>
	[item.preference, item.line, item.word.period, item.word.surface]));
const rankPlans = (a, b) => b.placements.length - a.placements.length || a.cost - b.cost;

// Choose placements by requested-word coverage, then phonetic and boundary cost.
// Keep alternatives during the search, then generate the remaining gaps only once.
export async function findPriorityPlan({ unitsList, wordlist, preferences, locks = [], param,
	scoreRange, signal, onProgress }) {
	const requested = normalizePriorityWords(preferences);
	onProgress?.({ preferenceIndex: 0, preferenceCount: requested.length, lineIndex: 0, lineCount: unitsList.length });
	const fixed = locks.flatMap((words, line) => (words || []).map(word => ({ line, word })));
	const groups = [];
	let yielded = performance.now();
	for (const [preference, preferred] of requested.entries()) {
		if (fixed.some(item => matchesPriority(item.word, preferred))) continue;
		const subset = {};
		for (const [size, rows] of Object.entries(wordlist)) {
			const entries = rows.filter(word => matchesPriority(word, preferred));
			if (entries.length) subset[size] = entries;
		}
		const candidates = [];
		const reserved = !param.DUPLICATE && fixed.some(item => !item.word.filler && String(item.word.id) === preferred.id);
		if (!reserved && Object.keys(subset).length) {
			const maximum = Math.max(...Object.keys(subset).map(Number));
			for (const [line, units] of unitsList.entries()) {
				const boundary = index => index === 0 || index === units.length
					|| units[index - 1].char_index !== units[index].char_index;
				const minimums = units.map(unit => Math.min(...syllableVariations(unit.pronunciation)
					.map(variation => variation.u.filter(Boolean).length)));
				for (let start = 0; start < units.length; start++) {
					if (!boundary(start)) continue;
					let minimum = 0;
					for (let end = start + 1; end <= units.length; end++) {
						minimum += minimums[end - 1];
						if (minimum > maximum) break;
						if (!boundary(end)) continue;
						const span = { line, word: { period: [start, end] } };
						if (fixed.some(item => overlaps(item, span))) continue;
						if (performance.now() - yielded > 12) {
							onProgress?.({ preferenceIndex: preference + 1, preferenceCount: requested.length,
								lineIndex: line + 1, lineCount: unitsList.length });
							await new Promise(resolve => setTimeout(resolve, 0));
							yielded = performance.now();
						}
						if (signal?.aborted) return null;
						const target = units.slice(start, end).map(unit => unit.pronunciation);
						const word = scoreRange(subset, target, line, start, end);
						if (!word || !Number.isFinite(word.sim)) continue;
						const placed = { ...word, period: [start, end], originalkana: target.join(""),
							score: word.sim + boundaryCost(units, end, param), priorityPlaced: true };
						candidates.push({ preference, line, word: placed,
							cost: placed.score + boundaryCost(units, start, param) + (param.WORD_NUMBER_PENALTY || 0) });
					}
				}
			}
		}
		candidates.sort((a, b) => a.cost - b.cost || a.line - b.line || a.word.period[0] - b.word.period[0]);
		// Include positions from different lines so several requested words can
		// fit even when their cheapest positions compete within the same line.
		const limit = Math.max(CANDIDATES_PER_WORD, Math.min(64, requested.length * 2));
		const diverse = [];
		const lines = new Set();
		for (const candidate of candidates) {
			if (lines.has(candidate.line)) continue;
			lines.add(candidate.line); diverse.push(candidate);
			if (diverse.length === limit) break;
		}
		for (const candidate of candidates) {
			if (diverse.length === limit) break;
			if (!diverse.includes(candidate)) diverse.push(candidate);
		}
		groups.push({ preference, candidates: diverse });
	}
	// Scarce words go first, but retain alternative assignments and omission paths.
	groups.sort((a, b) => a.candidates.length - b.candidates.length || a.preference - b.preference);
	let beam = [{ placements: [], cost: 0 }];
	for (const group of groups) {
		const next = [];
		for (const plan of beam) {
			next.push(plan);
			for (const candidate of group.candidates) {
				if (plan.placements.some(item => overlaps(item, candidate)
					|| (!param.DUPLICATE && item.word.id === candidate.word.id))) continue;
				next.push({ placements: [...plan.placements, candidate], cost: plan.cost + candidate.cost });
			}
		}
		next.sort(rankPlans);
		const unique = new Map();
		for (const plan of next) if (!unique.has(planKey(plan))) unique.set(planKey(plan), plan);
		beam = [...unique.values()].slice(0, BEAM_SIZE);
	}
	const plan = beam[0];
	return { ...plan,
		locks: unitsList.map((_, line) => [...(locks[line] || []),
			...plan.placements.filter(item => item.line === line).map(item => item.word)]) };
}
