import { isCurrentWord, generationLock } from "./editorWordIdentity.js";

// Rebuild one line while reserving all words in other lines, including later ones.
// Other lines (and their gaps/fillers) never pass through the generator.
export function lineRegenerationInput(data, db, line, weightsList) {
	if (!Number.isInteger(line) || !data.tokensList[line]) throw new Error("再生成する行がありません");
	let wordlist = db;
	if (!data.param.DUPLICATE) {
		const used = new Set(data.results.flatMap((words, i) => i === line ? []
			: words.filter((word) => !word.filler && isCurrentWord(word, data.wordlistSource)).map((word) => word.id)));
		wordlist = Object.fromEntries(Object.entries(db).map(([size, words]) =>
			[size, words.filter((word) => !used.has(word.id))]));
	}
	return {
		tokens: [data.tokensList[line]], db: wordlist,
		locks: [(data.results[line] || []).filter((word) => word.locked && !word.filler)
			.map((word) => generationLock(word, data.wordlistSource))],
		weights: weightsList ? [weightsList[line]] : null,
	};
}
