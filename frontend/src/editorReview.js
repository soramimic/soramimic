// Compact review UI for a host that has already analyzed the song.
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

export function setupReviewToolbar() {
	document.documentElement.classList.add("video-review");
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
	const menu = element("details", "review-menu");
	const summary = element("summary", "btn btn-ghost", "•••");
	summary.setAttribute("aria-label", "その他の操作");
	const body = element("div", "review-menu-body");
	const regenerate = document.getElementById("btn-regenerate");
	regenerate.addEventListener("click", () => { menu.open = false; });
	body.append(regenerate);
	menu.append(summary, body);
	actions.append(menu, document.getElementById("regen-progress"));
	toolbar.append(actions);
}

export function renderReviewLine(data, line, selection, choose) {
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
		if (word.filler) {
			chip.append(element("span", "review-unmatched", "未対応"));
			chip.setAttribute("aria-label", `未対応、${word.surface}。候補を選ぶ`);
		}
		chip.setAttribute("aria-pressed", String(selection?.line === line
			&& selection.start === word.period[0] && selection.end === word.period[1]));
		chip.addEventListener("click", () => choose(line, word));
		words.append(chip);
	}
	row.append(words);
	return row;
}

// Original readings remain read-only because the host has already aligned these
// units to the song's notes. The range is expanded when opening a selection.
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
	header.append(close, title);
	if (word && !word.filler) {
		const lock = element("button", "btn btn-ghost panel-lock", word.locked ? "固定中" : "固定");
		lock.type = "button";
		lock.setAttribute("aria-pressed", String(!!word.locked));
		lock.addEventListener("click", () => callbacks.lock(line, word));
		header.append(lock);
	} else if (!(data.results[line] || []).some((w) =>
		!w.filler && w.period[0] < end && start < w.period[1])) {
		header.append(element("span", "review-unmatched", "未対応"));
	}
	panel.append(header);
	const details = element("details", "review-range");
	details.open = callbacks.rangeOpen;
	details.append(element("summary", "", "読み・範囲"));
	details.addEventListener("toggle", () => callbacks.setRangeOpen(details.open));
	details.append(element("p", "review-original", reviewOriginal(data, line)));
	const buttons = element("div", "review-range-units");
	units.forEach((unit, index) => {
		const button = element("button", "btn review-unit", unit.pronunciation);
		button.type = "button";
		button.dataset.index = String(index);
		button.setAttribute("aria-pressed", String(index >= start && index < end));
		button.addEventListener("click", (event) => callbacks.unit(line, index, event.shiftKey));
		buttons.append(button);
	});
	details.append(buttons);
	panel.append(details);
}
