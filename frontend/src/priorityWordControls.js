import { normalizeWordSearch } from "./editorWordlistSearch.js";
import { normalizePriorityWords, priorityKey } from "./lib/priorityWords.js";
import { loadWordlistEntries } from "./appCore.js";

export function priorityContext(entry) {
	return JSON.stringify([entry?.value, entry?.filepath, entry?.dbtype,
		entry?.csvText, entry?.originalText]);
}

// Keep one catalog, containing readings rather than pronunciation variations.
export function createPriorityCatalogLoader(getApp, getSelection) {
	let cached;
	return () => {
		const { entry, where } = getSelection();
		const key = JSON.stringify([priorityContext(entry), where]);
		if (cached?.key !== key) {
			const item = { key };
			item.promise = Promise.resolve(getApp()).then(app => loadWordlistEntries(app, entry, where))
				.catch(error => { if (cached === item) cached = null; throw error; });
			cached = item;
		}
		return cached.promise;
	};
}

export function createPriorityWordControls({ container, getWords, getContext, onChange, onCompare }) {
	let selected = [], context = getContext(), request = 0, timer, active = -1, composing = false;
	const label = document.createElement("label");
	label.className = "field-label";
	label.textContent = "優先して含めたい単語";
	const heading = document.createElement("div");
	heading.className = "priority-heading";
	const info = document.createElement("button");
	info.type = "button";
	info.className = "priority-info";
	info.textContent = "ⓘ";
	info.setAttribute("aria-label", "優先単語の説明");
	info.setAttribute("aria-expanded", "false");
	heading.append(label, info);
	const row = document.createElement("div");
	row.className = "priority-search-row";
	const field = document.createElement("div");
	field.className = "kana-search-field";
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.classList.add("kana-search-icon");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	icon.innerHTML = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>';
	const input = document.createElement("input");
	input.id = `${container.id}-search`;
	input.className = "input";
	input.type = "search";
	input.placeholder = "ひらがな・カタカナ";
	input.autocomplete = "off";
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-expanded", "false");
	label.htmlFor = input.id;
	const scope = document.createElement("select");
	scope.className = "input priority-scope";
	scope.setAttribute("aria-label", "優先する範囲");
	for (const [value, text] of [["word", "単語全体"], ["surface", "選んだ表記"]]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = text;
		scope.append(option);
	}
	const tags = document.createElement("div");
	tags.className = "priority-tags";
	tags.setAttribute("aria-label", "優先する単語");
	const list = document.createElement("div");
	list.id = `${container.id}-results`;
	list.className = "priority-results";
	list.setAttribute("role", "listbox");
	list.setAttribute("aria-label", "単語の検索候補");
	input.setAttribute("aria-controls", list.id);
	const status = document.createElement("p");
	status.className = "field-note priority-status";
	status.setAttribute("role", "status");
	const help = document.createElement("p");
	help.className = "field-note";
	help.id = `${container.id}-hint`;
	help.textContent = "選択中のリストから、音が近い箇所で優先して使います。必ず含まれるとは限りません。";
	help.hidden = true;
	info.setAttribute("aria-controls", help.id);
	info.addEventListener("click", () => {
		help.hidden = !help.hidden;
		info.setAttribute("aria-expanded", String(!help.hidden));
	});
	input.setAttribute("aria-describedby", help.id);
	const methodRow = document.createElement("div");
	methodRow.className = "priority-method-row";
	const method = document.createElement("select");
	method.className = "input";
	method.setAttribute("aria-label", "優先単語の使い方");
	for (const [value, text] of [["score", "音の近さで優先"], ["placement", "先に配置して生成"]]) {
		method.append(new Option(text, value));
	}
	function syncMethodHelp() {
		help.textContent = method.value === "placement"
			? "指定した語を先に配置し、残りを生成します。音が離れていても指定を優先します。長さや固定区間の制約で入らない語は比較結果に表示します。"
			: "選択中のリストから、音が近い箇所で優先して使います。必ず含まれるとは限りません。";
	}
	method.addEventListener("change", () => { syncMethodHelp(); onChange(); });
	methodRow.append(method);
	if (onCompare) {
		const compare = document.createElement("button");
		compare.type = "button";
		compare.className = "btn";
		compare.textContent = "両方式で比較";
		compare.addEventListener("click", onCompare);
		methodRow.append(compare);
	}
	field.append(icon, input);
	row.append(field, scope);
	container.append(heading, row, tags, list, status, methodRow, help);

	function hideResults() {
		list.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
		active = -1;
	}
	function renderTags() {
		tags.replaceChildren();
		for (const word of selected) {
			const tag = document.createElement("span");
			tag.className = "priority-tag";
			const name = word.scope === "surface" ? word.surface : word.original || word.surface;
			tag.append(document.createTextNode(name));
			if (word.scope === "surface") {
				const detail = document.createElement("small");
				detail.textContent = word.original && word.original !== word.surface
					? `${word.original}・表記のみ` : "表記のみ";
				tag.append(detail);
			}
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "×";
			remove.setAttribute("aria-label", `${name}の優先指定を解除`);
			remove.addEventListener("click", () => {
				selected = selected.filter(value => priorityKey(value) !== priorityKey(word));
				renderTags();
				onChange();
				scheduleSearch();
			});
			tag.append(remove);
			tags.append(tag);
		}
		tags.hidden = !selected.length;
		methodRow.hidden = !selected.length;
	}
	function refresh() {
		const next = getContext();
		if (context !== next) {
			context = next;
			selected = [];
			renderTags();
		}
		scheduleSearch();
	}
	function choose(word) {
		if (context !== getContext()) { refresh(); return; }
		if (word.scope === "word") selected = selected.filter(value => value.id !== word.id || value.original !== word.original);
		selected = normalizePriorityWords([...selected, word]);
		input.value = "";
		++request;
		clearTimeout(timer);
		hideResults();
		status.textContent = "";
		renderTags();
		onChange();
		input.focus();
	}
	function scheduleSearch() {
		clearTimeout(timer);
		const revision = ++request;
		hideResults();
		status.textContent = "";
		if (!normalizeWordSearch(input.value) || composing) return;
		timer = setTimeout(() => search(revision), 180);
	}
	async function search(revision) {
		const searchContext = getContext();
		const query = normalizeWordSearch(input.value);
		status.textContent = "候補を検索中…";
		try {
			const words = await getWords();
			if (revision !== request || searchContext !== getContext()) return;
			const matches = new Map();
			let processed = 0;
			for (const word of words) {
				if ([word.kana, word.original, word.surface].some(value => normalizeWordSearch(value).includes(query))) {
					const value = { ...word, scope: scope.value };
					const key = priorityKey(value);
					const alreadySelected = selected.some(item => priorityKey(item) === key
						|| (item.scope === "word" && item.id === word.id && item.original === word.original));
					if (!alreadySelected && !matches.has(key)) matches.set(key, value);
				}
				if (++processed % 5000 === 0) {
					await new Promise(resolve => setTimeout(resolve, 0));
					if (revision !== request || searchContext !== getContext()) return;
				}
			}
			list.replaceChildren();
			for (const [index, word] of [...matches.values()].slice(0, 30).entries()) {
				const button = document.createElement("button");
				button.type = "button";
				button.tabIndex = -1;
				button.id = `${list.id}-${index}`;
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", "false");
				const name = document.createElement("span");
				name.textContent = word.scope === "word" ? word.original || word.surface : word.surface;
				const reading = document.createElement("small");
				const detail = word.scope === "word" ? word.surface : word.original;
				reading.textContent = [detail !== name.textContent ? detail : "", word.kana].filter(Boolean).join(" · ");
				button.append(name, reading);
				button.addEventListener("click", () => choose(word));
				list.append(button);
			}
			list.hidden = !matches.size;
			input.setAttribute("aria-expanded", String(!!matches.size));
			status.textContent = !matches.size ? "候補がありません" : matches.size > 30
				? `${matches.size}件中30件を表示。かなを追加して絞り込めます。` : "";
		} catch (error) {
			if (revision === request) status.textContent = "候補を読み込めませんでした。もう一度検索してください。";
		}
	}
	input.addEventListener("input", scheduleSearch);
	input.addEventListener("focus", refresh);
	input.addEventListener("compositionstart", () => { composing = true; scheduleSearch(); });
	input.addEventListener("compositionend", () => { composing = false; scheduleSearch(); });
	scope.addEventListener("change", scheduleSearch);
	input.addEventListener("keydown", event => {
		if (composing || event.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape") {
			event.preventDefault(); event.stopPropagation(); ++request; clearTimeout(timer); hideResults(); status.textContent = "";
		} else if (!list.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			const options = [...list.children];
			active = (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
			options.forEach((option, index) => option.setAttribute("aria-selected", String(index === active)));
			input.setAttribute("aria-activedescendant", options[active].id);
			options[active].scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (!list.hidden) list.children[Math.max(0, active)]?.click();
		}
	});
	container.addEventListener("focusout", event => {
		if (!container.contains(event.relatedTarget)) {
			++request; clearTimeout(timer); hideResults(); status.textContent = "";
		}
	});
	hideResults(); renderTags();
	return {
		refresh,
		getValues: () => {
			if (context !== getContext()) refresh();
			return { priorityWords: normalizePriorityWords(selected), priorityContext: context, priorityStrategy: method.value };
		},
		setValues: values => {
			if (values.priorityStrategy !== undefined) method.value = values.priorityStrategy === "placement" ? "placement" : "score";
			syncMethodHelp();
			if (values.priorityWords === undefined) return;
			selected = normalizePriorityWords(values.priorityWords);
			context = values.priorityContext ?? getContext();
			renderTags();
			refresh();
		},
	};
}
