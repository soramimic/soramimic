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

export function setupReviewToolbar(review) {
	document.documentElement.classList.add("simple-editor");
	document.documentElement.classList.toggle("video-review", review);
	const toolbar = document.getElementById("editor-toolbar");
	const actions = element("div", "review-tools");
	for (const [id, label, icon] of [
		["btn-undo", "元に戻す", "↶"], ["btn-redo", "やり直す", "↷"],
	]) {
		const button = document.getElementById(id);
		button.textContent = icon;
		button.setAttribute("aria-label", label);
		button.title = label;
		actions.append(button);
	}
	if (!review) actions.append(document.getElementById("btn-settings"));
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
	body.append(regenerate);
	if (!review) {
		for (const id of ["btn-import", "btn-export"]) body.append(document.getElementById(id));
		const copy = element("div", "editor-copy-options");
		copy.append(document.querySelector('label[for="copy-format"]'),
			document.getElementById("copy-format"), document.getElementById("btn-copy"));
		body.append(copy);
		for (const button of body.querySelectorAll("button")) {
			button.addEventListener("click", () => { setOpen(false); });
		}
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
	toolbar.append(document.getElementById("regen-progress"), document.getElementById("settings-progress"));
	toolbar.append(actions);
	toolbar.append(document.getElementById("reverse-search"));
}

export function renderReviewLine(data, line, selection, choose, lockIcon, decorate) {
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
			chip.append(lockIcon(true));
			chip.setAttribute("aria-label", `${word.surface}、固定中。候補を選ぶ`);
		}
		chip.setAttribute("aria-pressed", String(selection?.line === line
			&& selection.start === word.period[0] && selection.end === word.period[1]));
		decorate?.(chip, word);
		chip.addEventListener("click", () => choose(line, word));
		words.append(chip);
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
	const close = element("button", "btn btn-ghost panel-close", "←");
	close.type = "button";
	close.setAttribute("aria-label", "歌詞一覧に戻る");
	close.addEventListener("click", callbacks.close);
	const title = element("h2", "review-selected-word", word?.surface || kana);
	const selected = element("div", "review-selected");
	selected.append(title);
	if (word?.kana && word.kana !== word.surface) selected.append(element("span", "review-selected-reading", word.kana));
	header.append(close, selected);
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
