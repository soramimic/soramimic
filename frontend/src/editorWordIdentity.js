export function wordlistKey(entry) {
	if (!entry) return "";
	if (entry.value === "ORIGINAL" || typeof entry.csvText === "string") return entry.value + "\t" + (entry.csvText || "");
	return [entry.value, entry.filepath, entry.dbtype].join("\t");
}

const sources = new Map();
export async function wordlistSource(entry) {
	const key = wordlistKey(entry);
	if (!sources.has(key)) {
		sources.set(key, crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
			.then((digest) => Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")));
	}
	return sources.get(key);
}

export function isCurrentWord(word, source) {
	return !word.wordlistSource || word.wordlistSource === source;
}

// Retained words from another list must not reserve an unrelated matching ID.
// Keep the temporary ID inside generation and restore the word's real ID after it.
export function generationLock(word, source) {
	const lock = structuredClone(word);
	if (!isCurrentWord(word, source)) {
		lock.retainedId = word.id;
		lock.id = `retained:${word.wordlistSource}:${word.id}`;
	}
	return lock;
}

export function generatedWords(words, source, rememberSource = false) {
	return words.map((word) => {
		if (word.filler) return word;
		const restored = { ...word };
		if (rememberSource && !restored.wordlistSource) restored.wordlistSource = source;
		if ("retainedId" in restored) {
			restored.id = restored.retainedId;
			delete restored.retainedId;
		}
		return restored;
	});
}
