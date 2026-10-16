export const MAX_PRIORITY_WORDS = 5;

// Candidate ranking keeps the phonetic distance intact for diagnostics.
const PRIORITY_REWARD = 40;

export function normalizePriorityWords(words) {
	const result = new Map();
	for (const word of Array.isArray(words) ? words : []) {
		if (!word || typeof word.id !== "string" || typeof word.original !== "string"
			|| typeof word.surface !== "string") continue;
		const scope = ["surface", "surfaces"].includes(word.scope) ? word.scope : "word";
		const value = { id: word.id, original: word.original, surface: word.surface,
			kana: typeof word.kana === "string" ? word.kana : "", scope };
		if (scope === "surfaces") {
			value.surfaces = [...new Set((Array.isArray(word.surfaces) ? word.surfaces : [])
				.filter(surface => typeof surface === "string" && surface.length))];
			if (!value.surfaces.length) value.surfaces = [word.surface];
		}
		result.set(priorityKey(value), value);
	}
	return [...result.values()];
}

export function priorityKey(word) {
	return JSON.stringify([word.id, word.original, word.scope,
		word.scope === "surface" ? word.surface : ""]);
}

export function matchesPriorityWord(word, preferred) {
	return !word.filler && String(word.id) === preferred.id && word.original === preferred.original
		&& (preferred.scope === "word" || (preferred.scope === "surfaces"
			? preferred.surfaces.includes(word.surface) : word.surface === preferred.surface));
}

export function createPriorityReward(words) {
	const byId = new Map();
	for (const word of normalizePriorityWords(words)) {
		if (!byId.has(word.id)) byId.set(word.id, []);
		byId.get(word.id).push(word);
	}
	if (!byId.size) return () => 0;
	return word => byId.get(String(word.id))?.some(preferred => matchesPriorityWord(word, preferred))
		? PRIORITY_REWARD : 0;
}
