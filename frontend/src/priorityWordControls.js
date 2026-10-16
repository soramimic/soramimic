import { normalizeWordSearch } from "./editorWordlistSearch.js";
import { MAX_PRIORITY_WORDS, normalizePriorityWords, priorityKey } from "./lib/priorityWords.js";
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

export function createPriorityWordControls({ container, getWords, getContext, onChange }) {
	let selected = [], context = getContext(), request = 0, timer, active = -1, composing = false, expanded;
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
	const count = document.createElement("span");
	count.className = "priority-count";
	count.setAttribute("aria-label", "優先単語の数");
	count.setAttribute("role", "status");
	heading.append(label, count, info);
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
	help.textContent = `最大${MAX_PRIORITY_WORDS}個まで指定できます。指定した語を先に配置し、残りを生成します。音が離れていても指定を優先します。長さや固定区間の制約で入らない場合があります。追加した単語の三角アイコンから、候補にする表記をチェックできます。複数チェックした場合は、その中から音が合う表記を使います。表記は1つ以上選んでください。`;
	help.hidden = true;
	info.setAttribute("aria-controls", help.id);
	info.addEventListener("click", () => {
		help.hidden = !help.hidden;
		info.setAttribute("aria-expanded", String(!help.hidden));
	});
	input.setAttribute("aria-describedby", help.id);
	field.append(icon, input);
	row.append(field);
	container.append(heading, row, tags, list, status, help);

	function hideResults() {
		list.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
		active = -1;
	}
	function resetStatus() {
		status.textContent = selected.length > MAX_PRIORITY_WORDS
			? `${MAX_PRIORITY_WORDS}個まで指定できます。あと${selected.length - MAX_PRIORITY_WORDS}個解除してください。`
			: selected.length === MAX_PRIORITY_WORDS
				? `上限の${MAX_PRIORITY_WORDS}個です。追加するには1個解除してください。` : "";
	}
	const panelCatalogs = new WeakMap();
	const identity = word => JSON.stringify([word.id, word.original]);
	const chosenSurfaces = word => word.scope === "surfaces" ? word.surfaces : [word.surface];
	// Older saves may contain several exact spellings of the same word.
	function groupWords(words) {
		const groups = new Map();
		for (const word of normalizePriorityWords(words)) {
			const key = identity(word), previous = groups.get(key);
			if (previous?.scope === "word") continue;
			if (!previous || word.scope === "word") groups.set(key, word);
			else groups.set(key, { ...previous, scope: "surfaces",
				surfaces: [...new Set([...chosenSurfaces(previous), ...chosenSurfaces(word)])] });
		}
		return [...groups.values()];
	}
	function updateTagName(word, tag) {
		tag.querySelector(".priority-tag-name").textContent = word.scope === "word"
			? word.original || word.surface : chosenSurfaces(word).join(" / ");
	}
	async function renderChoices(word, panel) {
		const catalogContext = getContext();
		let catalog;
		try {
			catalog = getWords();
			if (panelCatalogs.get(panel) === catalog) return;
			panelCatalogs.set(panel, catalog);
			panel.textContent = "表記を読み込み中…";
			const words = await catalog;
			if (!panel.isConnected || panelCatalogs.get(panel) !== catalog
				|| context !== catalogContext || getContext() !== catalogContext) return;
			const available = [...new Set(words.filter(value => value.id === word.id && value.original === word.original).map(value => value.surface))];
			const checked = word.scope === "word" ? available : chosenSurfaces(word);
			const surfaces = [...new Set([...checked, ...available])];
			const fieldset = document.createElement("fieldset");
			const legend = document.createElement("legend");
			legend.textContent = "候補にする表記";
			fieldset.append(legend);
			for (const surface of surfaces) {
				const label = document.createElement("label");
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = checked.includes(surface);
				label.append(checkbox, document.createTextNode(surface));
				if (!available.includes(surface)) {
					const note = document.createElement("small");
					note.textContent = "現在のリスト・絞り込みでは対象外";
					label.append(note);
				}
				checkbox.addEventListener("change", () => {
					const surfaces = [...fieldset.querySelectorAll("input:checked")].map(input => input.value);
					// At least one spelling belongs to each tag; use × to remove it.
					if (!surfaces.length) { checkbox.checked = true; return; }
					selected = selected.map(value => identity(value) === identity(word)
						? { ...value, scope: "surfaces", surfaces } : value);
					updateLastChoice();
					updateTagName(selected.find(value => identity(value) === identity(word)), panel.parentElement);
					onChange();
				});
				checkbox.value = surface;
				fieldset.append(label);
			}
			function updateLastChoice() {
				const inputs = [...fieldset.querySelectorAll("input")];
				const checked = inputs.filter(input => input.checked);
				for (const input of inputs) input.disabled = checked.length === 1 && input.checked;
			}
			updateLastChoice();
			panel.replaceChildren(fieldset);
		} catch {
			if (panelCatalogs.get(panel) !== catalog) return;
			panelCatalogs.delete(panel);
			if (panel.isConnected) panel.textContent = "表記を読み込めませんでした。閉じてからもう一度開いてください。";
		}
	}
	function renderTags() {
		count.textContent = `${selected.length} / ${MAX_PRIORITY_WORDS}個`;
		input.disabled = selected.length >= MAX_PRIORITY_WORDS;
		if (input.disabled) { ++request; clearTimeout(timer); hideResults(); }
		resetStatus();
		tags.replaceChildren();
		for (const word of selected) {
			const tag = document.createElement("div");
			tag.className = "priority-tag";
			const name = word.surface;
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "priority-tag-toggle";
			toggle.setAttribute("aria-label", `${name}の候補にする表記`);
			const title = document.createElement("span");
			title.className = "priority-tag-name";
			title.textContent = word.scope === "word" ? word.original || name : chosenSurfaces(word).join(" / ");
			const action = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			action.classList.add("priority-tag-chevron");
			action.setAttribute("viewBox", "0 0 12 8");
			action.setAttribute("aria-hidden", "true");
			action.innerHTML = '<path d="M0 0h12L6 8z"/>';
			toggle.append(title, action);
			const panel = document.createElement("div");
			panel.className = "priority-surfaces";
			panel.id = `${container.id}-surfaces-${tags.children.length}`;
			panel.hidden = expanded !== identity(word);
			toggle.setAttribute("aria-controls", panel.id);
			toggle.setAttribute("aria-expanded", String(!panel.hidden));
			toggle.addEventListener("click", () => {
				const open = panel.hidden;
				expanded = open ? identity(word) : undefined;
				for (const other of tags.querySelectorAll(".priority-surfaces")) other.hidden = true;
				for (const other of tags.querySelectorAll(".priority-tag-toggle")) other.setAttribute("aria-expanded", "false");
				panel.hidden = !open;
				toggle.setAttribute("aria-expanded", String(open));
				if (open) renderChoices(selected.find(value => identity(value) === identity(word)), panel);
			});
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "priority-tag-remove";
			remove.textContent = "×";
			remove.setAttribute("aria-label", `${name}の優先指定を解除`);
			remove.addEventListener("click", () => {
				selected = selected.filter(value => identity(value) !== identity(word));
				renderTags();
				onChange();
				scheduleSearch();
			});
			tag.append(toggle, remove, panel);
			tags.append(tag);
			if (!panel.hidden) renderChoices(word, panel);
		}
		tags.hidden = !selected.length;
	}
	function refresh() {
		const next = getContext();
		if (context !== next) {
			context = next;
			selected = [];
			expanded = undefined;
			renderTags();
		} else if (expanded) {
			const panel = tags.querySelector(".priority-surfaces:not([hidden])");
			if (panel) renderChoices(selected.find(word => identity(word) === expanded), panel);
		}
		scheduleSearch();
	}
	function choose(word) {
		if (context !== getContext()) { refresh(); return; }
		if (selected.length >= MAX_PRIORITY_WORDS) { resetStatus(); return; }
		selected = groupWords([...selected, { ...word, scope: "surfaces", surfaces: [word.surface] }]);
		expanded = identity(word);
		input.value = "";
		++request;
		clearTimeout(timer);
		hideResults();
		resetStatus();
		renderTags();
		onChange();
		input.focus();
	}
	function scheduleSearch() {
		clearTimeout(timer);
		const revision = ++request;
		hideResults();
		resetStatus();
		if (input.disabled || !normalizeWordSearch(input.value) || composing) return;
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
					const value = { ...word, scope: "surface" };
					const key = priorityKey(value);
					const alreadySelected = selected.some(item => item.id === word.id && item.original === word.original);
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
				name.textContent = word.surface;
				const reading = document.createElement("small");
				const detail = word.original;
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
	input.addEventListener("keydown", event => {
		if (composing || event.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape") {
			event.preventDefault(); event.stopPropagation(); ++request; clearTimeout(timer); hideResults(); resetStatus();
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
			++request; clearTimeout(timer); hideResults(); resetStatus();
		}
	});
	hideResults(); renderTags();
	return {
		refresh,
		getValues: () => {
			if (context !== getContext()) refresh();
			return { priorityWords: normalizePriorityWords(selected), priorityContext: context };
		},
		setValues: values => {
			if (values.priorityWords === undefined) return;
			selected = groupWords(values.priorityWords);
			context = values.priorityContext ?? getContext();
			renderTags();
			refresh();
		},
	};
}
