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
