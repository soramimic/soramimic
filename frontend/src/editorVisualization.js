import { KanaToSyllable, hiraToKata, syllableVariations, longVowelExpansion } from "./lib/kanaToSyllable.js";
import { PronunciationSearch } from "./lib/pronunciationSearch.js";
import { unitVowel, sameVowelAlignment } from "./editorVowelAlignment.js";

const splitter = KanaToSyllable();
const STORAGE_KEY = "soramimic-editor-visualization";
const kinds = ["vowel", "long", "nasal", "single", "filler"];
const labels = { vowel: "母音不一致", long: "長音2モーラ化", nasal: "ン・ッ変化", single: "1音節", filler: "未変換" };

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

export function vowelSequence(kana) {
	return canonicalUnits(syllables(kana)).map(unitVowel)
		.filter((vowel) => /^[アイウエオ]$/.test(vowel)).join("");
}

function pronunciationSearch(target, pronunciation, options) {
	const extra = pronunciation.filter((unit) => longVowelExpansion(unit)).length;
	const lengths = Array.from({ length: extra + 1 }, (_, i) => pronunciation.length + i);
	return new PronunciationSearch(target, lengths, options);
}

function nasalCounts(pronunciation) {
	return ["ン", "ッ"].map((char) => pronunciation.join("").split(char).length - 1);
}

function bestDistance(search, pronunciation, matrix, cost, wordCost) {
	return Math.min(Infinity, ...search.lengths.map((length) =>
		search.scoreExpanded(pronunciation, length, matrix, cost, wordCost)));
}

// Re-score the assigned pronunciation against the current reading/settings.
// Saved sim/score values can be stale after reading or parameter edits.
export function wordDiagnostics(word, target, app = null, param = {}, matrix = null) {
	if (word.filler) return { filler: true };
	const parts = syllables(word.kana);
	if (!parts.length) return {};
	const source = target.join("");
	const sourceVowels = vowelSequence(source), wordVowels = vowelSequence(word.kana);
	const result = { vowel: !sameVowelAlignment(target, parts), single: parts.length === 1,
		sourceVowels, wordVowels };
	// Free input stores unsimplified syllables, whereas generated words retain
	// their selected pronunciation variant and its conversion cost.
	const custom = String(word.id).startsWith("custom-");
	const pronunciation = !custom && Array.isArray(word.pronunciation) && word.pronunciation.length
		? word.pronunciation : canonicalUnits(parts);
	const originalNasals = nasalCounts(canonicalUnits(parts));
	const selectedNasals = nasalCounts(pronunciation);
	result.nasal = originalNasals.some((count, i) => count !== selectedNasals[i]);
	if (!app || !matrix) return result;
	const search = pronunciationSearch(target, pronunciation);
	const cost = Number(param.VARIATION_COST) || 0;
	const wordCost = custom ? 0 : Number(word.vcost) || 0;
	const distance = bestDistance(search, pronunciation, matrix, cost, wordCost);
	result.distance = distance / Math.max(1, target.length);
	result.lengthMismatch = search.lengths.length === 0;
	result.long = false;
	if (Number.isFinite(distance)) {
		// Rejoin previously expanded spellings from older saved results too.
		const held = canonicalUnits(syllables(pronunciation.join("")));
		const hasLongVowel = [...parts, ...target].some((unit) =>
			unit !== null && syllableVariations(unit, false).some(({u, c}) => c === 0
				&& u.some((part) => longVowelExpansion(part))));
		if (hasLongVowel) {
			const unexpanded = pronunciationSearch(target, held, { expandLongVowels: false });
			const heldDistance = unexpanded.score(held, matrix, cost, wordCost);
			result.long = distance < heldDistance - 1e-8;
		}
		if (!result.nasal && [...target, ...pronunciation].some((unit) => /[ンッ]/.test(unit))) {
			const unchanged = pronunciationSearch(target, pronunciation, { allowSoundChanges: false });
			const nasalKind = (unit) => /^[ンッ]$/.test(unit) ? unit : null;
			const extend = (score, left, right) => nasalKind(left) === nasalKind(right)
				? score + (matrix[left]?.[right] ?? Infinity) : Infinity;
			const unchangedDistance = Math.min(Infinity, ...unchanged.lengths.map((length) =>
				unchanged.distanceExpanded(pronunciation, length, extend, cost, wordCost, null)));
			result.nasal = distance < unchangedDistance - 1e-8;
		}
	}
	return result;
}

export function setupVisualization(getContext) {
	const dialog = document.getElementById("editor-display-settings");
	const inputs = Object.fromEntries(kinds.map((kind) => [kind, document.getElementById(`visualize-${kind}`)]));
	try {
		const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
		for (const kind of kinds) inputs[kind].checked = saved?.[kind] === true;
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
		const needDistance = dialog.open || inputs.long.checked || inputs.nasal.checked;
		if (needDistance && context.app && !matrix) matrix = context.app.kanaSimilarity.getKanaSimilarity(context.param);
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
			const active = kinds.filter((kind) => diagnostics[kind] && inputs[kind].checked);
			for (const kind of kinds) if (diagnostics[kind]) counts[kind]++;
			if (active.length) highlighted++;
			chip.classList.toggle("visualization-hit", !!active.length);
			chip.querySelector(".visualization-badges")?.remove();
			const descriptions = active.map((kind) => kind === "vowel"
				? `母音: ${diagnostics.sourceVowels || "なし"} → ${diagnostics.wordVowels || "なし"}`
				: labels[kind]);
			if (active.length) {
				const badges = document.createElement("span");
				badges.className = "visualization-badges";
				badges.setAttribute("aria-hidden", "true");
				active.forEach((kind, index) => {
					const badge = document.createElement("span");
					badge.className = `visualization-badge visualization-${kind}`;
					badge.textContent = labels[kind];
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
			document.getElementById(`visualization-count-${kind}`).textContent = ["long", "nasal"].includes(kind) && !context.app ? "準備中" : `${counts[kind]}か所`;
		}
		const enabled = kinds.some((kind) => inputs[kind].checked);
		document.getElementById("visualization-summary").textContent = enabled ? `・${highlighted}か所` : "";
	}
	function save() {
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
				...Object.fromEntries(kinds.map((kind) => [kind, inputs[kind].checked])),
			}));
		} catch { /* Editing data has priority over optional preferences. */ }
		refresh();
	}
	for (const input of Object.values(inputs)) input.addEventListener("change", save);
	document.getElementById("btn-display-settings").addEventListener("click", () => {
		dialog.showModal();
		refresh();
	});
	document.getElementById("btn-display-settings-close").addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", refresh);
	dialog.addEventListener("click", (event) => {
		if (event.target !== dialog) return;
		const bounds = dialog.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right
			|| event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
	});
	return {
		decorate(chip, word, target) {
			records.set(chip, { word, target, title: chip.title, aria: chip.getAttribute("aria-label") });
		},
		refresh,
	};
}
