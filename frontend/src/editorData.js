export const DEFAULT_NOTE_LENGTH_ALPHA = 0.25;

// Opening an older snapshot applies these defaults without constituting an edit.
export function normalizeEditorParam(param) {
	if (!param || typeof param !== "object") return;
	delete param.SAME_VOWEL_REWARD;
	delete param.SAME_CONSONANT_REWARD;
	if (param.VOWEL_RATIO == null) param.VOWEL_RATIO = 0.8;
	if (param.VARIATION_COST == null) param.VARIATION_COST = 20 * Number(param.VOWEL_RATIO);
}

export function normalizeEditorNoteLength(data) {
	if (!Array.isArray(data.noteLengthRawList)) {
		delete data.noteLengthRawList;
		delete data.noteLengthAlpha;
		return;
	}
	const alpha = Number(data.noteLengthAlpha);
	data.noteLengthAlpha = Number.isFinite(alpha) && alpha >= 0
		? Math.min(2, alpha) : DEFAULT_NOTE_LENGTH_ALPHA;
}

export function validateEditorData(obj) {
	if (!obj || typeof obj !== "object") return "JSONオブジェクトではありません";
	if (!Array.isArray(obj.results)) return "results(行ごとの単語列)がありません";
	if (!Array.isArray(obj.unitsList)) return "unitsList(行ごとの発音ユニット列)がありません";
	if (obj.results.length !== obj.unitsList.length) {
		return "resultsとunitsListの行数が一致しません";
	}
	if (!obj.results.every(Array.isArray) || !obj.unitsList.every(Array.isArray)) {
		return "resultsとunitsListの各行は配列で指定してください";
	}
	return null;
}
