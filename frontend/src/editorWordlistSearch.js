export function normalizeWordSearch(value) {
	return String(value || "").normalize("NFKC").toLowerCase()
		.replace(/[ぁ-ゖ]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0x60))
		.replace(/[\s・]/g, "");
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
let cached;

// Index the current, filtered DB once. Pronunciation variations must not become
// duplicate search hits, and older lists must not stay in the search cache.
async function indexWords(db) {
	const words = new Map();
	let processed = 0;
	for (const rows of Object.values(db)) {
		for (const word of rows) {
			const key = JSON.stringify([word.id, word.surface, word.kana, word.original]);
			const previous = words.get(key);
			if (!previous) {
				words.set(key, { word, text: [word.surface, word.original, word.kana]
					.map(normalizeWordSearch).join("\0") });
			} else if ((word.vcost || 0) < (previous.word.vcost || 0)) {
				previous.word = word;
			}
			if (++processed % 5000 === 0) await pause();
		}
	}
	return [...words.values()];
}

export async function searchWordlist(db, query, { limit = 100, signal } = {}) {
	const text = normalizeWordSearch(query);
	if (!text) return { groups: [], total: 0 };
	if (cached?.db !== db) cached = { db, index: indexWords(db) };
	const index = await cached.index;
	signal?.throwIfAborted();
	const groups = new Map();
	let total = 0, processed = 0;
	for (const item of index) {
		if (item.text.includes(text)) {
			total++;
			const key = JSON.stringify([item.word.surface, item.word.kana]);
			if (!groups.has(key) && groups.size < limit) groups.set(key, { key, cands: [] });
			groups.get(key)?.cands.push(item.word);
		}
		if (++processed % 5000 === 0) {
			await pause();
			signal?.throwIfAborted();
		}
	}
	return { groups: [...groups.values()], total };
}
