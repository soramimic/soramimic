// Shared compact editor layout. Host review controls source-editing capabilities.
// The host owns originalLines; do not infer display spelling from phonetic units.
import "./editorReview.css";

export const isVideoReview = (data) => data?.host?.review === true;

const element = (tag, className, text) => {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

export function reviewOriginal(data, line) {
	return data.originalLines?.[line] || data.phrases?.[line] || "";
}

// Fill uncovered source ranges for display only. Replacing part of a word removes
// that word, so results can contain gaps as well as explicit conversion fillers.
function reviewWords(data, line) {
	const units = data.unitsList[line] || [];
	const assigned = (data.results[line] || []).filter((word) => !word.filler)
		.sort((a, b) => a.period[0] - b.period[0]);
	const words = [];
	let cursor = 0;
	const appendGap = (end) => {
		if (cursor >= end) return;
		words.push({
			period: [cursor, end], filler: true,
			surface: units.slice(cursor, end).map((unit) => unit.pronunciation).join(""),
		});
	};
	for (const word of assigned) {
		appendGap(word.period[0]);
		words.push(word);
		cursor = Math.max(cursor, word.period[1]);
	}
	appendGap(units.length);
	return words;
}

export function setupReviewToolbar(review, onSearchViewportChange) {
	document.documentElement.classList.add("simple-editor");
	document.documentElement.classList.toggle("video-review", review);
	const toolbar = document.getElementById("editor-toolbar");
	const actions = element("div", "review-tools");
	for (const [id, label, icon] of [
		["btn-undo", "元に戻す", "←"], ["btn-redo", "やり直す", "→"],
	]) {
		const button = document.getElementById(id);
		button.textContent = icon;
		button.setAttribute("aria-label", label);
		button.title = label;
		actions.append(button);
	}
	const menu = element("div", "review-menu");
	const summary = element("button", "btn btn-ghost review-menu-toggle", "•••");
	summary.type = "button";
	summary.setAttribute("aria-expanded", "false");
	summary.setAttribute("aria-controls", "editor-actions");
	summary.setAttribute("aria-label", "その他の操作");
	const body = element("div", "review-menu-body");
	body.id = "editor-actions";
	body.hidden = true;
	const setOpen = (open) => {
		if (!open && body.contains(document.activeElement)) summary.focus();
		body.hidden = !open;
		summary.setAttribute("aria-expanded", String(open));
	};
	summary.addEventListener("click", () => setOpen(body.hidden));
	const regenerate = document.getElementById("btn-regenerate");
	regenerate.addEventListener("click", () => { setOpen(false); });
	if (review) {
		body.append(regenerate);
	} else {
		regenerate.className = "btn btn-ghost btn-icon";
		regenerate.setAttribute("aria-label", "固定中以外を再生成");
		regenerate.title = "固定中以外を再生成";
		regenerate.textContent = "↻";
		actions.append(regenerate);
		body.append(document.getElementById("btn-settings"));
		const files = element("div", "editor-file-actions");
		for (const id of ["btn-import", "btn-export"]) files.append(document.getElementById(id));
		body.append(files);
		const copy = element("div", "editor-copy-options");
		const format = element("div", "editor-copy-format");
		const select = document.getElementById("copy-format");
		const formatLabel = element("span", "editor-copy-format-label");
		formatLabel.setAttribute("aria-hidden", "true");
		const updateFormat = () => { formatLabel.textContent = select.selectedOptions[0].textContent; };
		select.addEventListener("change", updateFormat);
		updateFormat();
		format.append(formatLabel, select);
		copy.append(document.querySelector('label[for="copy-format"]'), format, document.getElementById("btn-copy"));
		body.append(copy);
	}
	const displaySettings = document.getElementById("btn-display-settings");
	if (review) body.prepend(displaySettings);
	else body.querySelector("#btn-settings").after(displaySettings);
	for (const button of body.querySelectorAll("button")) {
		button.addEventListener("click", () => { setOpen(false); });
	}
	document.addEventListener("click", (event) => {
		if (!menu.contains(event.target)) setOpen(false);
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		setOpen(false);
		summary.focus();
		event.stopPropagation();
	});
	menu.append(summary, body);
	actions.append(menu);
	if (!review) actions.prepend(document.getElementById("btn-video"));
	const status = element("div", "review-toolbar-status");
	status.append(document.getElementById("regen-progress"), document.getElementById("settings-progress"));
	document.body.append(status);
	toolbar.append(actions);
	toolbar.append(document.getElementById("reverse-search"));
	// Keep everything above the lyrics together while search hits scroll past.
	const header = document.querySelector(".site-header");
	const pageHeader = element("div", "review-page-header");
	header.before(pageHeader);
	pageHeader.append(header, document.getElementById("editor-status"),
		document.getElementById("bridge-status"), toolbar);
	const main = document.querySelector("main");
	const search = document.getElementById("reverse-search");
	const root = document.documentElement;
	let viewportFrame;
	const resizeSearch = () => {
		if (!search.open) return;
		const viewport = window.visualViewport;
		const height = viewport?.height ?? innerHeight;
		root.style.setProperty("--reverse-viewport-height", `${height}px`);
		root.style.setProperty("--reverse-viewport-top", `${viewport?.offsetTop ?? 0}px`);
		// The full toolbar can consume a small phone's entire keyboard viewport.
		root.classList.toggle("reverse-search-compact", height < 400);
		onSearchViewportChange?.();
	};
	const scheduleResize = () => {
		if (!search.open) return;
		cancelAnimationFrame(viewportFrame);
		viewportFrame = requestAnimationFrame(resizeSearch);
	};
	window.addEventListener("resize", scheduleResize);
	window.visualViewport?.addEventListener("resize", scheduleResize);
	window.visualViewport?.addEventListener("scroll", scheduleResize);
	search.addEventListener("toggle", (event) => {
		cancelAnimationFrame(viewportFrame);
		const open = event.currentTarget.open;
		const top = open ? window.scrollY : main.scrollTop;
		root.classList.toggle("reverse-search-open", open);
		// Transfer the lyric position when changing between page and lyric scrolling.
		if (open) {
			resizeSearch();
			window.scrollTo({ top: 0, behavior: "instant" });
			main.scrollTo({ top, behavior: "instant" });
		} else {
			root.style.removeProperty("--reverse-viewport-height");
			root.style.removeProperty("--reverse-viewport-top");
			root.classList.remove("reverse-search-compact");
			window.scrollTo({ top, behavior: "instant" });
		}
	});
}

export function renderReviewLine(data, line, selection, choose, lockIcon, decorate, actions = {}) {
	const row = element("div", "editor-line review-line");
	row.dataset.line = String(line);
	if (!data.unitsList[line]?.length) {
		row.classList.add("editor-line-blank");
		return row;
	}
	const original = element("p", "review-original", reviewOriginal(data, line));
	original.setAttribute("aria-label", data.originalLines?.[line] ? "元歌詞" : "元歌詞の読み");
	row.append(original);
	const words = element("div", "review-words");
	words.setAttribute("aria-label", "替え歌");
	for (const word of reviewWords(data, line)) {
		const chip = element("button", "review-word");
		chip.append(element("span", "review-word-surface", word.surface));
		chip.type = "button";
		chip.dataset.start = String(word.period[0]);
		chip.dataset.end = String(word.period[1]);
		chip.classList.toggle("filler", !!word.filler);
		chip.classList.toggle("locked", !!word.locked && !word.filler);
		if (word.filler) {
			chip.setAttribute("aria-label", `未対応、${word.surface}。候補を選ぶ`);
		} else if (word.locked) {
			if (!actions.lock) chip.append(lockIcon(true));
			chip.setAttribute("aria-label", `${word.surface}、固定中。候補を選ぶ`);
		}
		chip.setAttribute("aria-pressed", String(selection?.line === line
			&& selection.start === word.period[0] && selection.end === word.period[1]));
		decorate?.(chip, word);
		chip.addEventListener("click", () => choose(line, word));
		if (word.filler || (!actions.clear && !actions.lock)) {
			words.append(chip);
			continue;
		}
		const item = element("div", "review-word-item");
		const controls = element("div", "word-quick-actions");
		controls.setAttribute("role", "group");
		controls.setAttribute("aria-label", `${word.surface}の操作`);
		const addAction = (className, label, content, callback) => {
			const button = element("button", `btn btn-ghost inline-edit-action ${className}`);
			button.type = "button";
			button.dataset.start = String(word.period[0]);
			button.disabled = !!actions.busy;
			button.title = label;
			button.setAttribute("aria-label", label);
			button.append(content);
			button.addEventListener("click", () => {
				callback(line, word);
				const updated = document.querySelector(`.review-line[data-line="${line}"]`);
				const target = updated?.querySelector(`.${className}[data-start="${word.period[0]}"]`)
					|| [...(updated?.querySelectorAll(".review-word") || [])].find((chip) =>
						Number(chip.dataset.start) <= word.period[0] && word.period[0] < Number(chip.dataset.end));
				target?.focus({ preventScroll: true });
			});
			controls.append(button);
			return button;
		};
		if (actions.lock) {
			const button = addAction("word-quick-lock", word.locked
				? `${word.surface}の固定を解除` : `${word.surface}を固定`, lockIcon(!!word.locked), actions.lock);
			button.setAttribute("aria-pressed", String(!!word.locked));
		}
		if (actions.clear) addAction("word-quick-clear", `${word.surface}の割り当てをクリア`, "×", actions.clear);
		item.append(chip, controls);
		words.append(item);
	}
	row.append(words);
	return row;
}

// Reading and range stay visible while editing. Only standalone sessions may
// change source readings; reviewed songs keep the host's note alignment.
export function appendReviewHeader(panel, data, selection, callbacks) {
	const { line, start, end } = selection;
	const units = data.unitsList[line] || [];
	const word = (data.results[line] || []).find((w) => w.period[0] === start && w.period[1] === end);
	const kana = units.slice(start, end).map((u) => u.pronunciation).join("");
	const header = element("div", "panel-header review-panel-header");
	const close = element("button", callbacks.hasChanges
		? "btn btn-primary panel-close panel-done" : "btn btn-ghost panel-close",
		callbacks.hasChanges ? "決定" : "×");
	close.type = "button";
	const closeLabel = callbacks.hasChanges ? "決定して歌詞一覧に戻る" : "閉じて歌詞一覧に戻る";
	close.setAttribute("aria-label", closeLabel);
	close.title = closeLabel;
	close.addEventListener("click", callbacks.close);
	const title = element("h2", "review-selected-word", word?.surface || kana);
	const selected = element("div", "review-selected");
	const name = element("div", "review-selected-name");
	name.append(title);
	if (word?.kana && word.kana !== word.surface) name.append(element("span", "review-selected-reading", word.kana));
	selected.append(name);
	header.append(selected);
	const actions = element("div", "review-word-actions");
	if (word && !word.filler) {
		const lock = element("button", "btn btn-ghost panel-lock");
		lock.type = "button";
		lock.setAttribute("aria-label", "この単語を固定");
		lock.setAttribute("aria-pressed", String(!!word.locked));
		lock.title = word.locked ? "固定中（押すと固定を解除）" : "再生成してもこの単語を残す";
		lock.append(callbacks.lockIcon(!!word.locked));
		lock.addEventListener("click", () => callbacks.lock(line, word));
		actions.append(lock);
	}
	if (actions.childElementCount) header.append(actions);
	header.append(close);
	panel.append(header);
	const range = element("div", "review-range");
	range.dataset.line = String(line);
	range.setAttribute("role", "group");
	range.setAttribute("aria-label", "読みと範囲");
	range.append(element("p", "review-original", reviewOriginal(data, line)));
	const buttons = element("div", "review-range-units");
	units.forEach((unit, index) => {
		const button = element("button", "btn review-unit", unit.pronunciation);
		button.type = "button";
		button.dataset.index = String(index);
		button.title = unit.surface_form;
		button.setAttribute("aria-label", `${unit.surface_form}、読み ${unit.pronunciation}。範囲を選択`);
		button.setAttribute("aria-pressed", String(index >= start && index < end));
		button.addEventListener("click", (event) => callbacks.unit(line, index, event.shiftKey, event.detail === 0));
		button.addEventListener("pointerdown", (event) => callbacks.pointer?.(line, index, event));
		buttons.append(button);
	});
	range.append(buttons);
	if (callbacks.reading) {
		const edit = element("button", "btn btn-ghost panel-yomi-toggle", "✏️");
		edit.type = "button";
		edit.title = callbacks.reading.label;
		edit.setAttribute("aria-label", callbacks.reading.label);
		edit.addEventListener("click", callbacks.reading.open);
		range.append(edit);
	}
	panel.append(range);
}
