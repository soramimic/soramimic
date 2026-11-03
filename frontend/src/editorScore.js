// Preserve completed parody lines when only other original lines changed in SVS.
const signature = value => JSON.stringify(value, (_key, item) => {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
	return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
});

export function retainScoreLines(data, tokensList, unitsList, results) {
	const previous = data.scorePrevious;
	if (!Array.isArray(previous?.scoreContext?.moras) || !Array.isArray(data.scoreContext?.moras) ||
		signature(previous.param ?? {}) !== signature(data.param ?? {}) ||
		signature(previous.where ?? null) !== signature(data.where ?? null) ||
		signature(previous.wordlist ?? null) !== signature(data.wordlist ?? null) ||
		(previous.noteLengthAlpha ?? null) !== (data.noteLengthAlpha ?? null)) return;
	const lines = context => [...new Set(context.moras.map(note => note.line))];
	const oldLines = lines(previous.scoreContext), newLines = lines(data.scoreContext);
	const reading = row => row?.map(unit => unit.pronunciation);
	for (let index = 0; index < results.length; index++) {
		const old = oldLines.indexOf(newLines[index]);
		if (old < 0 || previous.phrases?.[old] !== data.phrases[index] ||
			!Array.isArray(previous.results?.[old]) ||
			signature(reading(previous.unitsList?.[old])) !== signature(reading(unitsList[index]))) continue;
		results[index] = structuredClone(previous.results[old]);
		unitsList[index] = structuredClone(previous.unitsList[old]);
		if (previous.tokensList?.[old]) tokensList[index] = structuredClone(previous.tokensList[old]);
	}
}
