import "./editorDisplay.css";

const STORAGE_KEY = "soramimic-editor-display";
const kinds = ["wordClear", "wordLock", "lineLock"];

export function setupEditorDisplay(onChange) {
	const options = Object.fromEntries(kinds.map((kind) => [kind, false]));
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
		for (const kind of kinds) options[kind] = saved?.[kind] === true;
	} catch { /* Display preferences are optional. */ }
	const inputs = Object.fromEntries(kinds.map((kind) => [kind,
		document.getElementById(`display-${kind}`)]));
	const presets = document.querySelectorAll("[data-display-preset]");
	function sync() {
		for (const kind of kinds) inputs[kind].checked = options[kind];
		for (const button of presets) {
			const enabled = button.dataset.displayPreset === "expert";
			const selected = kinds.every((kind) => options[kind] === enabled);
			button.classList.toggle("active", selected);
			button.setAttribute("aria-pressed", String(selected));
		}
	}
	function save() {
		sync();
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(options)); }
		catch { /* Keep the current view usable when storage is unavailable. */ }
		onChange();
	}
	for (const kind of kinds) inputs[kind].addEventListener("change", () => {
		options[kind] = inputs[kind].checked;
		save();
	});
	for (const button of presets) button.addEventListener("click", () => {
		for (const kind of kinds) options[kind] = button.dataset.displayPreset === "expert";
		save();
	});
	sync();
	return options;
}
