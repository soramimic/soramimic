import { alignLyricTokens, validLyricAlignment } from "./lyricAlignment.js";
import { alignmentFromUnits } from "./lib/readingAlignment.js";

// Optional derived data: an absent, unknown-version or stale map never prevents
// opening an existing editor file. Confirmed readings are never changed here.
export function syncOriginalReadingAlignments(data, app) {
	if (!app) return;
	const previousMaps = Array.isArray(data.originalReadingAlignments) ? data.originalReadingAlignments : [];
	data.originalReadingAlignments = (data.unitsList || []).map((units, line) => {
		const text = data.originalLines?.[line] || data.phrases?.[line] || "";
		const reading = units.map(u => u.pronunciation).join("");
		const previous = previousMaps[line];
		if (validLyricAlignment(previous, text, reading)) return previous;
		if (!text || !reading) return null;
		try {
			const tokens = data.tokensList?.[line];
			const sourceTokens = tokens?.map(t => t.surface_form).join("") === text
				? structuredClone(tokens) : app.textAnalyzer.tokenizeTogether([text])[0];
			const displayUnits = app.textAnalyzer.getYomiAndPhraseBreak(sourceTokens);
			return alignLyricTokens(text, reading, alignmentFromUnits(displayUnits))
				|| alignLyricTokens(text, reading, sourceTokens.map(t => [t.surface_form, t.pronunciation || ""]));
		} catch { return null; }
	});
}
