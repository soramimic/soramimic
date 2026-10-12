import { KanaToSyllable, charToVowel, hiraToKata, syllableVariations, longVowelExpansion } from "./lib/kanaToSyllable.js";
import { PronunciationSearch } from "./lib/pronunciationSearch.js";

const splitter = KanaToSyllable();
const STORAGE_KEY = "soramimic-editor-visualization";
const kinds = ["vowel", "distance", "single", "filler"];
const labels = { vowel: "母音不一致", distance: "類似度低", single: "1音節", filler: "未変換" };

function syllables(kana) {
	if (typeof kana !== "string") return [];
	return splitter.split(hiraToKata(kana.normalize("NFKC"))) || [];
}

// Use the shortest zero-cost spelling variant: ケイ/ケー and コウ/コー
// agree, while nasals and geminates do not count as vowels.
function canonicalUnits(parts) {
	return parts.flatMap((part) => syllableVariations(part, false)
		.filter(({ c }) => c === 0).sort((a, b) => a.u.length - b.u.length)[0]?.u || []);
}

function unitVowel(unit) {
	// charToVowel's legacy table omits small ョ. Normalize only for this
	// diagnostic so conversion scores and output remain unchanged.
	return charToVowel(unit.replace(/ョ/g, "ヨ").replace(/^ヲ/, "オ"));
}

export function vowelSequence(kana) {
	return canonicalUnits(syllables(kana)).map(unitVowel)
		.filter((vowel) => /^[アイウエオ]$/.test(vowel)).join("");
}

function pronunciationSearch(target, pronunciation) {
	const extra = pronunciation.filter((unit) => longVowelExpansion(unit)).length;
	const lengths = Array.from({ length: extra + 1 }, (_, i) => pronunciation.length + i);
	return new PronunciationSearch(target, lengths);
}

// Re-score the assigned pronunciation against the current reading/settings.
// Saved sim/score values can be stale after reading or parameter edits.
export function wordDiagnostics(word, target, app = null, param = {}, matrix = null) {
	if (word.filler) return { filler: true };
	const parts = syllables(word.kana);
	if (!parts.length) return {};
	const source = target.join("");
	const sourceVowels = vowelSequence(source), wordVowels = vowelSequence(word.kana);
	const result = { vowel: sourceVowels !== wordVowels, single: parts.length === 1,
		sourceVowels, wordVowels };
	// Free input stores unsimplified syllables, whereas generated words retain
	// their selected pronunciation variant and its conversion cost.
	const custom = String(word.id).startsWith("custom-");
	const pronunciation = !custom && Array.isArray(word.pronunciation) && word.pronunciation.length
		? word.pronunciation : canonicalUnits(parts);
	if (result.vowel) {
		const vowelPronunciation = pronunciation.map((unit) => {
			const vowel = unitVowel(unit);
			return /^[アイウエオ]$/.test(vowel) ? vowel + (unit.endsWith("ー") ? "ー" : "") : unit;
		});
		const vowelTarget = target.map((unit) => unit.replace(/ョ/g, "ヨ"));
		const search = pronunciationSearch(vowelTarget, vowelPronunciation);
		// A long vowel may cover one or two source units. Compare the same
		// reachable alignments as generation instead of contracting each side
		// independently. Consonant differences and variation costs are irrelevant
		// to whether the aligned vowels agree.
		const vowelDistance = (score, left, right) => score + Number(unitVowel(left) !== unitVowel(right));
		result.vowel = !search.lengths.some((length) =>
			search.distanceExpanded(vowelPronunciation, length, vowelDistance, 0, 0, null) === 0);
	}
	if (!app || !matrix) return result;
	const search = pronunciationSearch(target, pronunciation);
	const cost = Number(param.VARIATION_COST) || 0;
	const wordCost = custom ? 0 : Number(word.vcost) || 0;
	let distance = Infinity;
	for (const length of search.lengths) {
		distance = Math.min(distance, search.scoreExpanded(pronunciation, length, matrix, cost, wordCost));
	}
	result.distance = distance / Math.max(1, target.length);
	result.lengthMismatch = search.lengths.length === 0;
	return result;
}

export function setupVisualization(getContext) {
	const details = document.getElementById("editor-visualization");
	const threshold = document.getElementById("visualization-threshold");
	const inputs = Object.fromEntries(kinds.map((kind) => [kind, document.getElementById(`visualize-${kind}`)]));
	try {
		const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
		for (const kind of kinds) inputs[kind].checked = saved?.[kind] === true;
		if (Number.isFinite(saved?.threshold) && saved.threshold >= 0 && saved.threshold <= 100) {
			threshold.value = saved.threshold;
		}
	} catch { /* Display preferences are optional. */ }
	const records = new WeakMap();
	let cache = new WeakMap(), previousApp, previousParam, matrix;
	function refresh() {
		const context = getContext();
		const paramKey = JSON.stringify(context.param || {});
		if (context.app !== previousApp || paramKey !== previousParam) {
			cache = new WeakMap();
			matrix = null;
			previousApp = context.app;
			previousParam = paramKey;
		}
		const needDistance = details.open || inputs.distance.checked;
		if (needDistance && context.app && !matrix) matrix = context.app.kanaSimilarity.getKanaSimilarity(context.param);
		const limit = Math.max(0, Math.min(100, Number(threshold.value) || 0));
		const counts = Object.fromEntries(kinds.map((kind) => [kind, 0]));
		let highlighted = 0;
		for (const chip of document.querySelectorAll("#editor-lines .review-word")) {
			const record = records.get(chip);
			if (!record) continue;
			const { word, target, title, aria } = record;
			const key = JSON.stringify([target, word.kana, word.pronunciation, word.vcost, needDistance]);
			let entry = cache.get(word);
			if (!entry || entry.key !== key) {
				entry = { key, value: wordDiagnostics(word, target, context.app, context.param, needDistance ? matrix : null) };
				cache.set(word, entry);
			}
			const diagnostics = entry.value;
			const flags = { ...diagnostics, distance: diagnostics.distance !== undefined && diagnostics.distance > limit };
			const active = kinds.filter((kind) => flags[kind] && inputs[kind].checked);
			for (const kind of kinds) if (flags[kind]) counts[kind]++;
			if (active.length) highlighted++;
			chip.classList.toggle("visualization-hit", !!active.length);
			chip.querySelector(".visualization-badges")?.remove();
			const descriptions = active.map((kind) => kind === "vowel"
				? `母音: ${diagnostics.sourceVowels || "なし"} → ${diagnostics.wordVowels || "なし"}`
				: kind === "distance" ? Number.isFinite(diagnostics.distance)
					? `音の距離: ${diagnostics.distance.toFixed(1)} / 音` : diagnostics.lengthMismatch ? "読みの長さが合いません" : "音の距離を比較できません"
				: labels[kind]);
			if (active.length) {
				const badges = document.createElement("span");
				badges.className = "visualization-badges";
				badges.setAttribute("aria-hidden", "true");
				active.forEach((kind, index) => {
					const badge = document.createElement("span");
					badge.className = `visualization-badge visualization-${kind}`;
					badge.textContent = kind === "distance" && !Number.isFinite(diagnostics.distance)
						? diagnostics.lengthMismatch ? "長さ不一致" : "比較不可" : labels[kind];
					badge.title = descriptions[index];
					badges.append(badge);
				});
				chip.append(badges);
			}
			chip.title = [title, ...descriptions].join("\n");
			if (active.length) chip.setAttribute("aria-label", `${aria || word.surface}。${descriptions.join("、")}`);
			else if (aria) chip.setAttribute("aria-label", aria);
			else chip.removeAttribute("aria-label");
		}
		for (const kind of kinds) {
			document.getElementById(`visualization-count-${kind}`).textContent = kind === "distance" && !context.app ? "準備中" : `${counts[kind]}か所`;
		}
		const enabled = kinds.some((kind) => inputs[kind].checked);
		document.getElementById("visualization-summary").textContent = enabled ? `・${highlighted}か所を強調` : "";
		threshold.disabled = !inputs.distance.checked;
	}
	function save() {
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
				...Object.fromEntries(kinds.map((kind) => [kind, inputs[kind].checked])), threshold: Number(threshold.value),
			}));
		} catch { /* Editing data has priority over optional preferences. */ }
		refresh();
	}
	for (const input of Object.values(inputs)) input.addEventListener("change", save);
	threshold.addEventListener("input", save);
	details.addEventListener("toggle", refresh);
	return {
		decorate(chip, word, target) {
			records.set(chip, { word, target, title: chip.title, aria: chip.getAttribute("aria-label") });
		},
		refresh,
	};
}
