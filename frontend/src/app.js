// UIの配線。機能は旧 widget/(SettingArea, ConversionArea, NavigationButtons)と同等。
import { fetchText, fetchJson } from "./api.js";
import { validateEditorData } from "./editorData.js";
import { createGenerationHistoryRepository } from "./generationHistory.js";
import {
	loadEngine, buildDatabase, unitsListFromTokens,
} from "./appCore.js";
import { textToPhrases, makeResultText } from "./convert.js";
import { writeClipboard } from "./clipboard.js";
import { createYomiApi, tokenizePhrasesWithYomiApi } from "./yomiApi.js";
import { originalTextToCsv } from "./wordlistInput.js";
import {
	createCustomWordlistRepository, customWordlistId, customWordlistValue,
	CUSTOM_WORDLISTS_STORAGE_KEY,
} from "./customWordlists.js";
import { readCustomWordlistFile } from "./customWordlistFile.js";
import { createLruCache } from "./lib/lruCache.js";
import { createPriorityCatalogLoader, priorityContext } from "./priorityWordControls.js";
import { createPriorityComparison } from "./priorityComparison.js";
import { maximumVariationLength } from "./lib/kanaToSyllable.js";
import {
	createParamControls,
	renderFacets as renderFacetsIn, compileWhere as compileWhereIn,
} from "./convertControls.js";

const EDITOR_STORAGE_KEY = "soramimic-editor";
const DATABASE_CACHE_LIMIT = 2;
const RESULT_FORMAT = "4";

// GA4カスタムイベント送信(本番以外・広告ブロック時はgtag未定義なので何もしない)
function track(name, params) {
	if (typeof window.gtag === "function") window.gtag("event", name, params);
}

function $id(id) {
	return document.getElementById(id);
}

export async function startApp() {
	const btnConvert = $id("btn-convert");
	const btnCancel = $id("btn-cancel");
	const progress = $id("progress");
	const progressText = $id("progress-text");
	const inputText = $id("input-text");
	const outputField = $id("output-field");
	const outputText = $id("output-text");
	const btnCopyResult = $id("btn-copy-result");
	const copyResultStatus = $id("copy-result-status");
	const duplicateButtons = $id("duplicate-buttons");
	const wordlistButtons = $id("wordlist-buttons");
	const wordlistFacets = $id("wordlist-facets");
	const originalDialog = $id("original-dialog");
	const originalName = $id("original-name");
	const originalText = $id("original-text");
	const originalStatus = $id("original-status");
	const originalFile = $id("original-file");

	// 生成画面の状態は sessionStorage に保持し、編集ツール等から戻ってきても
	// 入力・結果が消えないようにする。歌詞は初期化を待たずここで復元する
	const MAIN_STORAGE_KEY = "soramimic-main";
	let savedMain = null;
	try {
		savedMain = JSON.parse(sessionStorage.getItem(MAIN_STORAGE_KEY));
	} catch (err) {
		console.warn("生成画面の状態読み込みに失敗:", err);
	}
	if (savedMain) {
		if (typeof savedMain.text === "string") inputText.value = savedMain.text;
	}

	const lyricsFile = $id("lyrics-file");
	function isJsonInput() {
		return inputText.value.trimStart().startsWith("{");
	}
	function updateConvertLabel() {
		btnConvert.textContent = isJsonInput() ? "編集画面へ" : "生成";
	}
	function openEditorJson(text) {
		if (new Blob([text]).size > 10 * 1024 * 1024) throw new Error("JSONは10MB以内にしてください");
		const payload = JSON.parse(text.trim());
		const problem = validateEditorData(payload);
		if (problem) throw new Error(problem);
		if (!payload.results.length) throw new Error("編集する生成結果がありません");
		delete payload.format;
		delete payload.setupFirst;
		delete payload.host;
		delete payload.hostRequest;
		delete payload.generationHistoryId;
		payload.history = [];
		payload.future = [];
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(payload));
		window.location.assign("editor.html");
	}
	// 同じファイルを選び直した場合も再読み込みする。
	lyricsFile.addEventListener("click", () => { lyricsFile.value = ""; });
	lyricsFile.addEventListener("change", async () => {
		const file = lyricsFile.files?.[0];
		if (!file) return;
		const status = $id("lyrics-file-status");
		status.hidden = false;
		status.textContent = "読み込み中...";
		setGenerationBusy(true);
		try {
			if (file.size > 10 * 1024 * 1024) throw new Error("10MB以内のファイルを選んでください");
			const text = (await file.text()).replace(/^\uFEFF/, "");
			if (/\.json$/i.test(file.name) || file.type === "application/json") {
				openEditorJson(text);
				return;
			}
			if (!/\.(txt|md)$/i.test(file.name)) throw new Error("TXT・Markdown・JSONファイルを選んでください");
			if (text.length > 10000) throw new Error("歌詞は1万文字以内にしてください");
			inputText.value = text;
			saveMainState();
			status.hidden = true;
		} catch (error) {
			lyricsFile.value = "";
			status.textContent = "読み込めませんでした: " + error.message;
		} finally {
			setGenerationBusy(false);
		}
	});

	// ---- MIDI取り込み ----
	// XF形式(カラオケ歌詞入り)MIDIから歌唱行を抽出して入力欄に流し込む。
	// 入力欄に元歌詞が貼ってあれば、歌唱行と対応づけて表記(漢字)ベースの行にできる
	// (読みカナだけだとトークナイザが文節を取れず、変換の文節スコアが効かないため)。
	// 主機能ではないため、?midi 付きのURLで開いたときだけボタンを表示する。
	// パーサ等はMIDIを使うときだけ動的importする(初期バンドルを増やさない)
	if (!new URLSearchParams(location.search).has("midi")) {
		$id("btn-midi-import").hidden = true;
	}
	const midiStatus = $id("midi-status");
	const midiFile = $id("midi-file");
	$id("btn-midi-import").addEventListener("click", () => midiFile.click());

	// 入力欄のテキストを元歌詞として使うかをダイアログで確認する
	function askUseLyrics() {
		return new Promise((resolve) => {
			const dialog = $id("midi-lyrics-dialog");
			const onYes = () => done(true);
			const onNo = () => done(false);
			const onCancel = () => done(false);
			function done(useLyrics) {
				$id("midi-lyrics-yes").removeEventListener("click", onYes);
				$id("midi-lyrics-no").removeEventListener("click", onNo);
				dialog.removeEventListener("close", onCancel);
				dialog.close();
				resolve(useLyrics);
			}
			$id("midi-lyrics-yes").addEventListener("click", onYes);
			$id("midi-lyrics-no").addEventListener("click", onNo);
			dialog.addEventListener("close", onCancel);
			dialog.showModal();
		});
	}

	midiFile.addEventListener("change", async () => {
		const file = midiFile.files && midiFile.files[0];
		midiFile.value = "";
		if (!file) return;
		try {
			const { parseXfMidi } = await import("./xfMidi.js");
			const { lines, noteCount, warnings } = parseXfMidi(await file.arrayBuffer());
			const notes = [`${file.name}: ${lines.length}行・${noteCount}音符を取り込みました`];

			const lyricsText = inputText.value.trim();
			let filled = null;
			if (lyricsText && await askUseLyrics()) {
				const { alignLyrics } = await import("./xfAlign.js");
				const aligned = alignLyrics(lines, lyricsText);
				filled = aligned.lines.map((l) => l.text);
				notes.push(`元歌詞と対応づけ: ${aligned.matchedCount}/${lines.length}行`);
				if (aligned.matchedCount < lines.length) {
					notes.push("対応づかなかった行は読みカナのまま");
				}
				// 元歌詞の1行をそのまま採れなかった行は区切りが推定なので、
				// 「n/m行」だけ見て全行そのまま入ったと誤解しないよう明示する
				const guessed = aligned.matchedCount - aligned.snappedCount;
				if (guessed > 0) {
					notes.push(`${guessed}行は元歌詞の行の途中で区切りました`);
				}
			}
			inputText.value = (filled || lines.map((l) => l.kana)).join("\n");
			saveMainState();
			if (warnings.length > 0) notes.push(...warnings);
			midiStatus.textContent = notes.join(" / ");
			midiStatus.hidden = false;
			track("midi_import", { lines: lines.length, notes: noteCount, lyrics: !!filled });
		} catch (err) {
			console.error(err);
			midiStatus.textContent = `MIDIの取り込みに失敗しました: ${err.message}`;
			midiStatus.hidden = false;
		}
	});

	// ---- 単語重複・パラメータ ----
	// スライダー・プリセット・単語重複のUIは編集ツールと共有する(convertControls.js)。
	// ここで足すのは生成画面固有の副作用(GA計測・状態保存)だけ

	function getParam() {
		return Object.assign(paramControls.getParam(), {
			OUTPUT_FORMAT: RESULT_FORMAT,
		});
	}

	// ---- データ読み込みとアルゴリズム初期化 ----
	// UIは設定(数KB)だけで先に組んで操作可能にし、重いリソース
	// (データJSON+kuromoji辞書、計20MB超)は裏でロードを進める。
	// 変換ボタンも即有効化し、押されたときにロードが未完了なら
	// 「準備中...」表示のまま完了を待つ。
	// 設定の取得を必ず先に済ませるのは、細い回線だと大物ダウンロードに
	// 帯域を取られて設定(=UI起動)が後回しになるため
	const config = await fetchJson("conf/setting.json");
	const enginePromise = loadEngine();
	let app = null; // ロード完了後に代入(変換系のフローでしか参照しない)
	enginePromise.catch((err) => {
		console.error(err);
		btnConvert.disabled = true;
		btnConvert.textContent = "読み込みに失敗しました";
	});

	// 読み推定API(soramimic-yomi)。使えるときだけ歌詞のトークナイズを任せ、
	// ダメならkuromojiにフォールバック(プログレッシブエンハンスメント)
	const yomiApi = createYomiApi(config.yomiApi && config.yomiApi.url);
	let yomiApiReady = false;
	if (yomiApi.enabled) {
		yomiApi.healthy().then((ok) => {
			yomiApiReady = ok;
			console.log("yomi api:", ok ? "available" : "unavailable(kuromojiを使用)");
		});
	}

	// 歌詞をトークナイズする(API優先・失敗時kuromoji)。
	// 後処理(formatTokensList)とルビ記法(｜表層《よみ》)の処理は
	// どちらの経路でも共通。記法の区間はAPIに渡さず強制トークンにする
	async function tokenizePhrases(phrases) {
		if (yomiApiReady) {
			try {
				return await tokenizePhrasesWithYomiApi(app.textAnalyzer, yomiApi, phrases);
			} catch (err) {
				console.warn("yomi api失敗、kuromojiにフォールバック:", err);
			}
		}
		return app.textAnalyzer.tokenizeTogether(phrases);
	}

	// ---- 単語リスト ----
	let selectedWordlist = null;
	// 現在と直前のDBだけを残す。ファセット・歌詞長・自作リスト内容が変わるたびに
	// 巨大DBがMapへ蓄積し続けるのを防ぎつつ、設定を戻したときの再利用は効かせる。
	const dbCache = createLruCache(DATABASE_CACHE_LIMIT);

	const wordlistByValue = new Map();
	function setWordlistControl(entry) {
		customTrigger.dataset.value = entry.value;
		customTrigger.setAttribute("aria-label", `単語リスト: ${entry.text}`);
		customTrigger.classList.toggle("active", !!customWordlistId(entry.value));
		customTextEl.textContent = entry.text;
		for (const item of customMenu.querySelectorAll("[role='menuitemradio']")) {
			item.setAttribute("aria-checked", String(item.__config.value === entry.value));
		}
	}
	for (const item of config.wordlist) {
		for (const entry of item.items || [item]) {
			wordlistByValue.set(entry.value, { entry, activate: () => setWordlistControl(entry) });
			if (entry.active) selectedWordlist = entry;
		}
	}

	const paramControls = createParamControls({
		paramArea: $id("param-area"),
		presetArea: $id("preset-buttons"),
		duplicateArea: duplicateButtons,
		priorityArea: $id("priority-words"),
		onPriorityCompare: () => priorityComparison.start(),
		getPriorityContext: () => priorityContext(selectedWordlist),
		getPriorityWords: createPriorityCatalogLoader(
			async () => (await enginePromise).appFor(),
			() => ({ entry: selectedWordlist, where: compileWhere(selectedWordlist) })),
		onChange: (kind, preset) => {
			if (kind === "preset") track("param_preset", { preset: preset.name });
			saveMainState();
		},
	});

	// 自作リストは名前付きで複数保存し、行ごとに選択・編集・削除できるメニューから選ぶ。
	// 保存本文はentryにもスナップショットとして持たせ、変換・編集ツールが
	// localStorageの「現在値」に依存しないようにする。
	const customRepository = createCustomWordlistRepository(localStorage);
	let customLists = [];
	let customLoadError = null;
	try {
		customLists = customRepository.list(); // 旧originalWordlistの初回移行もここ
	} catch (err) {
		console.warn("自作リストの読み込みに失敗:", err);
		customLoadError = err;
	}
	const defaultWordlist = selectedWordlist;
	const customWrap = document.createElement("span");
	customWrap.className = "custom-wordlist-picker";
	const customTrigger = document.createElement("button");
	customTrigger.type = "button";
	customTrigger.id = "wordlist-trigger";
	customTrigger.className = "btn custom-wordlist-trigger";
	customTrigger.setAttribute("aria-haspopup", "menu");
	customTrigger.setAttribute("aria-expanded", "false");
	customTrigger.setAttribute("aria-controls", "custom-wordlist-menu");
	const customTextEl = document.createElement("span");
	customTextEl.textContent = selectedWordlist.text;
	const customMenu = document.createElement("div");
	customMenu.id = "custom-wordlist-menu";
	customMenu.className = "custom-wordlist-menu";
	customMenu.setAttribute("role", "menu");
	customMenu.setAttribute("aria-label", "単語リスト");
	customMenu.hidden = true;
	customTrigger.append(customTextEl);
	customWrap.append(customTrigger, customMenu);
	wordlistButtons.appendChild(customWrap);

	function customEntry(list) {
		return {
			value: customWordlistValue(list.id),
			text: list.name,
			customId: list.id,
			originalText: list.text,
			updatedAt: list.updatedAt,
		};
	}

	function customMenuIcon(type) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.classList.add("custom-wordlist-menu-icon");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", type === "edit"
			? "M4 20h4L19 9l-4-4L4 16v4zm10-13 4 4M4 20l4-1"
			: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5");
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "1.8");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		svg.appendChild(path);
		return svg;
	}

	function makeWordlistOption(entry, subitem = false) {
		const choose = document.createElement("button");
		choose.type = "button";
		choose.className = "custom-wordlist-menu-select";
		if (subitem) choose.classList.add("custom-wordlist-menu-subitem");
		choose.setAttribute("role", "menuitemradio");
		choose.setAttribute("aria-label", entry.text);
		choose.setAttribute("aria-checked", String(entry.value === selectedWordlist?.value));
		choose.textContent = entry.text;
		choose.dataset.value = entry.value;
		choose.__config = entry;
		choose.addEventListener("click", () => {
			const found = wordlistByValue.get(entry.value);
			if (!found) return;
			if (selectedWordlist?.value === entry.value) {
				closeCustomMenu();
				return;
			}
			found.activate();
			selectedWordlist = found.entry;
			renderFacets(selectedWordlist);
			closeCustomMenu();
			saveMainState();
		});
		return choose;
	}

	function addWordlistHeading(text) {
		const heading = document.createElement("div");
		heading.className = "custom-wordlist-menu-heading";
		heading.setAttribute("role", "presentation");
		heading.textContent = text;
		customMenu.append(heading);
	}

	function renderCustomOptions() {
		for (const value of [...wordlistByValue.keys()]) {
			if (customWordlistId(value)) wordlistByValue.delete(value);
		}
		customMenu.replaceChildren();
		for (const item of config.wordlist) {
			if (item.items) addWordlistHeading(item.label);
			for (const entry of item.items || [item]) customMenu.append(makeWordlistOption(entry, !!item.items));
		}
		addWordlistHeading("自作リスト");
		const add = document.createElement("button");
		add.type = "button";
		add.className = "custom-wordlist-menu-new custom-wordlist-menu-subitem";
		add.setAttribute("role", "menuitem");
		add.textContent = "＋ 新しいリスト";
		add.addEventListener("click", (event) => {
			event.stopPropagation();
			closeCustomMenu(false);
			openOriginalDialog();
		});
		customMenu.appendChild(add);
		for (const list of customLists) {
			const entry = customEntry(list);
			const row = document.createElement("div");
			row.className = "custom-wordlist-menu-row custom-wordlist-menu-subitem";
			const choose = makeWordlistOption(entry);
			const edit = document.createElement("button");
			edit.type = "button";
			edit.className = "custom-wordlist-menu-action";
			edit.setAttribute("role", "menuitem");
			edit.setAttribute("aria-label", `「${list.name}」を編集`);
			edit.appendChild(customMenuIcon("edit"));
			edit.addEventListener("click", (event) => {
				event.stopPropagation();
				closeCustomMenu(false);
				openOriginalDialog(list);
			});
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "custom-wordlist-menu-action custom-wordlist-menu-delete";
			remove.setAttribute("role", "menuitem");
			remove.setAttribute("aria-label", `「${list.name}」を削除`);
			remove.appendChild(customMenuIcon("delete"));
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				if (deleteCustomWordlist(list)) closeCustomMenu();
			});
			row.append(choose, edit, remove);
			customMenu.appendChild(row);
			wordlistByValue.set(entry.value, { entry, activate: () => setWordlistControl(entry) });
		}
		positionCustomMenu();
	}
	renderCustomOptions();
	setWordlistControl(selectedWordlist);

	function positionCustomMenu() {
		if (customMenu.hidden) return;
		const triggerRect = customTrigger.getBoundingClientRect();
		const gutter = 8;
		const width = Math.min(Math.max(320, triggerRect.width), window.innerWidth - gutter * 2);
		customMenu.style.width = `${width}px`;
		customMenu.style.left = `${Math.max(gutter, Math.min(
			triggerRect.left, window.innerWidth - width - gutter))}px`;
		const below = triggerRect.bottom + 4;
		const above = triggerRect.top - customMenu.offsetHeight - 4;
		customMenu.style.top = `${Math.max(gutter, below + customMenu.offsetHeight <= window.innerHeight - gutter
			? below : above)}px`;
	}

	function closeCustomMenu(focusTrigger = true) {
		if (customMenu.hidden) return;
		customMenu.hidden = true;
		customTrigger.setAttribute("aria-expanded", "false");
		if (focusTrigger) customTrigger.focus();
	}

	function openCustomMenu({ focus = true, last = false } = {}) {
		customMenu.hidden = false;
		customTrigger.setAttribute("aria-expanded", "true");
		positionCustomMenu();
		if (!focus) return;
		const items = [...customMenu.querySelectorAll("button")];
		const checked = customMenu.querySelector("[role='menuitemradio'][aria-checked='true']");
		(last ? items.at(-1) : checked || items[0])?.focus();
	}

	customTrigger.addEventListener("click", (event) => {
		event.stopPropagation();
		if (customMenu.hidden) openCustomMenu();
		else closeCustomMenu();
	});
	customTrigger.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		if (customMenu.hidden) openCustomMenu({ last: event.key === "ArrowUp" });
	});
	customMenu.addEventListener("keydown", (event) => {
		const items = [...customMenu.querySelectorAll("button")];
		if (event.key === "Escape") {
			event.preventDefault();
			closeCustomMenu();
			return;
		}
		if (event.key === "Tab") {
			closeCustomMenu(false);
			return;
		}
		let index = items.indexOf(document.activeElement);
		if (event.key === "ArrowDown") index = (index + 1) % items.length;
		else if (event.key === "ArrowUp") index = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") index = 0;
		else if (event.key === "End") index = items.length - 1;
		else return;
		event.preventDefault();
		items[index]?.focus();
	});
	document.addEventListener("click", (event) => {
		if (!customMenu.hidden && !customWrap.contains(event.target)) closeCustomMenu(false);
	});
	window.addEventListener("resize", positionCustomMenu);
	window.addEventListener("scroll", positionCustomMenu, true);
	// 旧版で変換済みの結果をsessionStorageから復元する場合、選択値だけでなく
	// 編集ツールへ渡す変換時リストも移行する。旧キーは新形式保存後に消えるため、
	// ここを直さないと「編集ツールで開く」で候補DBが空になる。
	if (savedMain && savedMain.lastConversion && savedMain.lastConversion.wordlist
		&& savedMain.lastConversion.wordlist.value === "ORIGINAL"
		&& typeof savedMain.lastConversion.wordlist.csvText !== "string"
		&& customLists.length > 0) {
		savedMain.lastConversion.wordlist = customEntry(customLists[0]);
	}

	// ファセット絞り込み(描画・whereのコンパイル)も編集ツールと共有する。
	// 共有関数はコンテナ引数を取るので、生成画面のコンテナを束ねただけのラッパにする
	const renderFacets = (entry) => {
		renderFacetsIn(wordlistFacets, entry);
		paramControls.refreshPriority();
	};
	wordlistFacets.addEventListener("change", () => paramControls.refreshPriority());
	const compileWhere = (entry) => compileWhereIn(wordlistFacets, entry);

	renderFacets(selectedWordlist);

	let editingCustomId = null;
	let editingCustomUpdatedAt = null;
	function showOriginalStatus(message, isError = true) {
		originalStatus.textContent = message || "";
		originalStatus.hidden = !message;
		originalStatus.classList.toggle("is-error", !!message && isError);
	}
	function openOriginalDialog(list = null) {
		editingCustomId = list ? list.id : null;
		editingCustomUpdatedAt = list ? list.updatedAt : null;
		$id("original-dialog-title").textContent = list
			? "自作単語リストの編集" : "自作単語リストの保存";
		originalName.value = list ? list.name : "";
		originalText.value = list ? list.text : "";
		$id("original-delete").hidden = !list;
		showOriginalStatus(customLoadError ? customLoadError.message : "");
		originalDialog.showModal();
		originalName.focus();
	}

	function restoreSelectedWordlistControl() {
		const found = selectedWordlist && wordlistByValue.get(selectedWordlist.value);
		if (found) found.activate();
	}

	$id("original-cancel").addEventListener("click", () => originalDialog.close());
	const originalDropzone = $id("btn-original-file");
	async function loadOriginalFile(file) {
		if (!file) return;
		try {
			const loaded = await readCustomWordlistFile(file);
			const engine = await enginePromise;
			// 名前付き保存へ進む前に、選択したファイルが実際に正規化できるか確認する。
			originalTextToCsv(loaded.text, engine.app);
			originalText.value = loaded.text;
			if (!editingCustomId && !originalName.value.trim()) originalName.value = loaded.name;
			showOriginalStatus(
				`${file.name}: ${loaded.rows.toLocaleString()}語を入力欄へ読み込みました`, false);
		} catch (err) {
			console.warn("自作リストファイルの読み込みに失敗:", err);
			showOriginalStatus("読み込めませんでした: " + err.message);
		}
	}
	originalDropzone.addEventListener("click", () => originalFile.click());
	originalFile.addEventListener("change", () => {
		const file = originalFile.files && originalFile.files[0];
		originalFile.value = ""; // 同じファイルを選び直してもchangeを発火させる
		loadOriginalFile(file);
	});
	let originalDragDepth = 0;
	originalDropzone.addEventListener("dragenter", (event) => {
		if (!event.dataTransfer || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		originalDragDepth += 1;
		originalDropzone.classList.add("is-dragging");
	});
	originalDropzone.addEventListener("dragover", (event) => {
		if (!event.dataTransfer || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	});
	originalDropzone.addEventListener("dragleave", () => {
		originalDragDepth = Math.max(0, originalDragDepth - 1);
		if (originalDragDepth === 0) originalDropzone.classList.remove("is-dragging");
	});
	originalDropzone.addEventListener("dragend", () => {
		originalDragDepth = 0;
		originalDropzone.classList.remove("is-dragging");
	});
	originalDropzone.addEventListener("drop", (event) => {
		event.preventDefault();
		originalDragDepth = 0;
		originalDropzone.classList.remove("is-dragging");
		loadOriginalFile(event.dataTransfer && event.dataTransfer.files[0]);
	});
	originalDialog.addEventListener("close", () => {
		originalDragDepth = 0;
		originalDropzone.classList.remove("is-dragging");
	});
	$id("original-register").addEventListener("click", () => {
		const name = originalName.value.trim();
		const text = originalText.value;
		if (!name) {
			showOriginalStatus("リスト名を入力してください");
			originalName.focus();
			return;
		}
		if (!text.trim()) {
			showOriginalStatus("単語を1つ以上入力してください");
			originalText.focus();
			return;
		}
		try {
			const selectedValueBeforeSave = selectedWordlist && selectedWordlist.value;
			const wasCreating = !editingCustomId;
			const saved = editingCustomId
				? customRepository.update(editingCustomId, { name, text }, {
					expectedUpdatedAt: editingCustomUpdatedAt,
				})
				: customRepository.create({ name, text });
			customLoadError = null;
			customLists = customRepository.list();
			renderCustomOptions();
			const valueToRestore = wasCreating || selectedValueBeforeSave === customWordlistValue(saved.id)
				? customWordlistValue(saved.id) : selectedValueBeforeSave;
			const found = wordlistByValue.get(valueToRestore);
			if (found) {
				found.activate();
				selectedWordlist = found.entry;
			}
			renderFacets(selectedWordlist);
			saveMainState();
			track("wordlist_original", { action: editingCustomId ? "update" : "create" });
			originalDialog.close();
		} catch (err) {
			console.warn("自作リストの保存に失敗:", err);
			showOriginalStatus("保存できませんでした: " + err.message);
		}
	});

	function deleteCustomWordlist(list) {
		if (!list || !confirm(`「${list.name}」を削除しますか？`)) return false;
		try {
			customRepository.remove(list.id);
			customLists = customRepository.list();
			const wasSelected = customWordlistId(selectedWordlist && selectedWordlist.value) === list.id;
			renderCustomOptions();
			if (wasSelected && defaultWordlist) {
				const fallback = wordlistByValue.get(defaultWordlist.value);
				if (fallback) fallback.activate();
				selectedWordlist = defaultWordlist;
				renderFacets(selectedWordlist);
				saveMainState();
			} else {
				restoreSelectedWordlistControl();
			}
			track("wordlist_original", { action: "delete" });
			return true;
		} catch (err) {
			console.warn("自作リストの削除に失敗:", err);
			showOriginalStatus("削除できませんでした: " + err.message);
			return false;
		}
	}

	$id("original-delete").addEventListener("click", () => {
		const list = customLists.find((item) => item.id === editingCustomId);
		if (deleteCustomWordlist(list)) originalDialog.close();
	});

	// 別タブでの作成・更新・削除を一覧へ反映する。編集中のtextareaは上書きせず、
	// 保存時のupdatedAt比較で競合を検知してユーザーの入力を残す。
	window.addEventListener("storage", (event) => {
		if (event.key !== CUSTOM_WORDLISTS_STORAGE_KEY) return;
		try {
			const selectedId = customWordlistId(selectedWordlist && selectedWordlist.value);
			customLists = customRepository.list();
			renderCustomOptions();
			const current = selectedId && wordlistByValue.get(customWordlistValue(selectedId));
			if (current) {
				current.activate();
				selectedWordlist = current.entry;
			} else if (selectedId && defaultWordlist) {
				const fallback = wordlistByValue.get(defaultWordlist.value);
				if (fallback) fallback.activate();
				selectedWordlist = defaultWordlist;
				renderFacets(selectedWordlist);
				saveMainState();
			}
		} catch (err) {
			console.warn("別タブの自作リスト更新を反映できませんでした:", err);
		}
	});

	const sampleButton = $id("btn-sample-lyrics");
	const samplePicker = $id("sample-picker");
	const sampleStatus = $id("sample-status");
	let sampleRequest = null;
	sampleButton.addEventListener("click", () => {
		sampleStatus.hidden = true;
		samplePicker.showModal();
		sampleButton.setAttribute("aria-expanded", "true");
	});
	$id("sample-close").addEventListener("click", () => samplePicker.close());
	samplePicker.addEventListener("close", () => {
		sampleButton.setAttribute("aria-expanded", "false");
		sampleRequest?.abort();
		if (!sampleRequest) sampleButton.focus();
	});
	samplePicker.addEventListener("click", async (event) => {
		const choice = event.target.closest("button[data-path]");
		if (!choice || sampleRequest) return;
		const path = choice.dataset.path;
		const request = new AbortController();
		sampleRequest = request;
		sampleStatus.hidden = false;
		sampleStatus.textContent = "歌詞を読み込み中...";
		for (const button of samplePicker.querySelectorAll("[data-path]")) button.disabled = true;
		setGenerationBusy(true);
		try {
			const text = await fetchText(path, { signal: request.signal });
			if (request.signal.aborted || !samplePicker.open) return;
			inputText.value = text;
			lyricsFile.value = "";
			$id("lyrics-file-status").hidden = true;
			saveMainState();
			track("sample_select", { song: path });
			samplePicker.close();
		} catch (error) {
			if (!request.signal.aborted) sampleStatus.textContent = "歌詞を読み込めませんでした: " + error.message;
		} finally {
			sampleRequest = null;
			for (const button of samplePicker.querySelectorAll("[data-path]")) button.disabled = false;
			setGenerationBusy(false);
			if (!samplePicker.open) sampleButton.focus();
		}
	});


	async function prepareConversion(text, param = getParam()) {
		const phrases = textToPhrases(text);
		let entry = selectedWordlist;
		const where = compileWhere(entry);
		const engine = await enginePromise;
		app = engine.appFor(param.VOWEL_RATIO);
		if (customWordlistId(entry?.value)) entry = { ...entry, originalText: undefined,
			csvText: originalTextToCsv(entry.originalText, app) };
		const tokensList = await tokenizePhrases(phrases);
		const maxUnits = tokensList.reduce((max, tokens) => Math.max(max,
			maximumVariationLength(app.textAnalyzer.getYomiAndPhraseBreak(tokens).map(unit => unit.pronunciation))), 0);
		const db = await getDatabase(entry, where, maxUnits > 0 ? maxUnits : undefined);
		return { app, phrases, tokensList, db, entry, where, param, sourceText: text };
	}

	const priorityComparison = createPriorityComparison({
		prepare: () => {
			const text = inputText.value.trim();
			if (!text || text.length > 10000) throw new Error("歌詞を1〜1万文字で入力してください");
			const param = getParam();
			if (!param.PRIORITY_WORDS.length) throw new Error("優先する単語を選んでください");
			return prepareConversion(text, param);
		},
		onChoose: async ({ prepared, results, param }) => {
			const gen = ++convertGen;
			paramControls.setValues({ priorityStrategy: param.PRIORITY_STRATEGY });
			lastConversion = { phrases: prepared.phrases, tokensList: prepared.tokensList, param,
				wordlist: prepared.entry, where: prepared.where, sourceText: prepared.sourceText };
			await setResult(results, gen);
		},
	});

	async function getDatabase(entry, where, maxUnits) {
		// 同じvalueでもwhere(ファセット絞り込み含む)が異なると別物なので、
		// キーは内容で構成し、自作リストの編集後に古いDBを使わない。
		if (customWordlistId(entry.value)) {
			const key = [entry.value, entry.csvText || entry.originalText || "", maxUnits].join("|");
			return dbCache.getOrCreate(key,
				() => buildDatabase(app, entry, undefined, maxUnits));
		}
		const key = [entry.filepath, entry.dbtype, where, maxUnits].join("|");
		return dbCache.getOrCreate(key,
			() => buildDatabase(app, entry, where, maxUnits));
	}

	// ---- 変換 ----
	let pastResult = null;
	let lastConversion = null; // 直近の変換入力(編集ツールへの受け渡し用)
	let editorPayload = null;
	let selectedHistoryId = null;
	let historyEntries = [];
	let historyBusy = false;
	const historyRepository = createGenerationHistoryRepository();
	const historySelect = $id("history-select");
	const historyDelete = $id("history-delete");
	const historyStatus = $id("history-status");

	function saveMainState() {
		try {
			const values = paramControls.getValues();
			sessionStorage.setItem(MAIN_STORAGE_KEY, JSON.stringify({
				text: inputText.value,
				wordlistValue: selectedWordlist ? selectedWordlist.value : null,
				// activeなプリセット名(手で詳細設定を触った=カスタムのときはnull)
				preset: paramControls.activePresetName(),
				sound: values.sound,
				phrase: values.phrase,
				wordnum: values.wordnum,
				duplicate: String(values.duplicate),
				priorityWords: values.priorityWords,
				priorityContext: values.priorityContext,
				priorityStrategy: values.priorityStrategy,
				historyId: selectedHistoryId,
				unsavedResult: !selectedHistoryId ? editorPayload : undefined,
				pastResult: !selectedHistoryId && !editorPayload ? pastResult : undefined,
				lastConversion: !selectedHistoryId && !editorPayload ? lastConversion : undefined,
			}));
		} catch (err) {
			console.warn("生成画面の状態保存に失敗:", err);
		}
	}
	inputText.addEventListener("input", () => {
		lyricsFile.value = "";
		$id("lyrics-file-status").hidden = true;
		updateConvertLabel();
		saveMainState();
	});

	let convertMeta = null; // 変換1回分の計測情報(convertイベント用)

	const btnOpenEditor = $id("btn-open-editor");
	async function makeEditorPayload(conversion = lastConversion, results = pastResult) {
		const engine = await enginePromise;
		return {
			phrases: conversion.phrases,
			tokensList: conversion.tokensList,
			results,
			param: conversion.param,
			wordlist: conversion.wordlist,
			where: conversion.where,
			unitsList: unitsListFromTokens(engine.app, conversion.tokensList),
		};
	}
	async function openEditor() {
		if (!pastResult?.length) return;
		const payload = structuredClone(editorPayload || await makeEditorPayload());
		if (selectedHistoryId) payload.generationHistoryId = selectedHistoryId;
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(payload));
		track("open_editor", {});
		window.location.assign("editor.html");
	}

	function showGenerationError(error) {
		console.error(error);
		const status = $id("generation-error");
		status.textContent = "エラーが発生しました: " + error.message;
		status.hidden = false;
	}
	btnOpenEditor.addEventListener("click", () => openEditor().catch(showGenerationError));

	function showHistoryStatus(message) {
		historyStatus.textContent = message;
		historyStatus.hidden = !message;
		if (message) { outputField.hidden = false; outputField.open = true; }
	}
	function renderHistoryOptions() {
		historySelect.replaceChildren();
		if (!selectedHistoryId) historySelect.append(new Option("今回の結果（未保存）", ""));
		for (const entry of historyEntries) {
			const date = new Date(entry.createdAt).toLocaleString("ja-JP", {
				year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
			});
			const firstLine = entry.payload.phrases?.find(line => line.trim()) || entry.sourceText || "";
			const name = entry.payload.wordlist?.text || "単語リスト";
			historySelect.append(new Option(`${date} · ${name} · ${firstLine.slice(0, 32)}`, entry.id));
		}
		historySelect.value = selectedHistoryId || "";
		historySelect.disabled = historyBusy || historyEntries.length === 0;
		historyDelete.disabled = historyBusy || !selectedHistoryId;
		btnOpenEditor.disabled = historyBusy;
		$id("history-count").textContent = historyEntries.length ? `（${historyEntries.length}件）` : "";
	}
	function selectHistoryEntry(entry) {
		selectedHistoryId = entry?.id || null;
		editorPayload = entry ? structuredClone(entry.payload) : null;
		pastResult = editorPayload?.results || null;
		outputText.textContent = pastResult?.length ? makeResultText(pastResult, RESULT_FORMAT) : "";
		outputText.scrollTop = 0;
		btnCopyResult.disabled = !outputText.textContent;
		btnOpenEditor.hidden = !pastResult?.length;
		outputField.hidden = !historyEntries.length && !editorPayload && historyStatus.hidden;
		renderHistoryOptions();
		saveMainState();
	}
	historySelect.addEventListener("change", () => {
		const entry = historyEntries.find(item => item.id === historySelect.value);
		if (entry) selectHistoryEntry(entry);
	});
	historyDelete.addEventListener("click", async () => {
		const id = selectedHistoryId;
		if (!id || !confirm("選択した生成結果を履歴から削除しますか？")) return;
		historyDelete.disabled = true;
		try {
			await historyRepository.remove(id);
			historyEntries = await historyRepository.list();
			showHistoryStatus("");
			selectHistoryEntry(historyEntries[0]);
		} catch {
			showHistoryStatus("生成結果を削除できませんでした。もう一度お試しください。");
			renderHistoryOptions();
		}
	});

	async function initializeHistory() {
		if (savedMain?.unsavedResult?.results?.length) {
			editorPayload = savedMain.unsavedResult;
			pastResult = editorPayload.results;
			outputText.textContent = makeResultText(pastResult, RESULT_FORMAT);
			btnOpenEditor.hidden = false;
			btnCopyResult.disabled = false;
		}
		try {
			historyEntries = await historyRepository.list();
			if (pastResult?.length && lastConversion) {
				// 前回1件だけのセッション保存を、重複させずに永続履歴へ移す。
				const payload = await makeEditorPayload();
				const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
				const id = "legacy-" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
				try {
					const entry = await historyRepository.add(payload, payload.phrases.join("\n"), { id });
					historyEntries = await historyRepository.list();
					selectHistoryEntry(entry);
				} catch {
					editorPayload = payload;
					showHistoryStatus("この結果を履歴に保存できませんでした。編集画面の「書き出し」で保存できます。");
					renderHistoryOptions();
				}
				return;
			}
			if (savedMain?.unsavedResult?.results?.length) {
				editorPayload = savedMain.unsavedResult;
				pastResult = editorPayload.results;
				outputText.textContent = makeResultText(pastResult, RESULT_FORMAT);
				btnOpenEditor.hidden = false;
				btnCopyResult.disabled = false;
				showHistoryStatus("この結果は履歴に保存されていません。編集画面の「書き出し」で保存できます。");
				renderHistoryOptions();
				return;
			}
			const entry = historyEntries.find(item => item.id === savedMain?.historyId) || historyEntries[0];
			selectHistoryEntry(entry);
		} catch {
			showHistoryStatus("過去の生成結果を読み込めませんでした。再読み込みしてお試しください。");
			renderHistoryOptions();
		}
	}

	// 変換の世代トークン。中止・再実行のたびに進め、エンジン・辞書ロード中
	// (=生成チェーン開始前)に中止された変換が後から走り出すのを防ぐ。
	// 開始済みのチェーンは convertHandle.cancel() で止める
	let convertGen = 0;
	let convertHandle = null;

	function resetConvertUi() {
		setGenerationBusy(false);
		progress.hidden = true;
		btnCancel.hidden = true;
		btnConvert.disabled = false;
		updateConvertLabel();
	}

	function setGenerationBusy(busy) {
		historyBusy = busy;
		for (const control of document.querySelectorAll(".generation-card button, .generation-card input, .generation-card textarea, .generation-card select")) {
			if (control !== btnCancel) control.disabled = busy;
		}
		if (!busy) updateConvertLabel();
		renderHistoryOptions();
	}

	btnCancel.addEventListener("click", () => {
		convertGen++;
		if (convertHandle) {
			convertHandle.cancel();
			convertHandle = null;
		}
		if (convertMeta) {
			track("convert_cancel", {
				text_length: convertMeta.textLength,
				wordlist: convertMeta.wordlist,
				duration_ms: Date.now() - convertMeta.started,
			});
			convertMeta = null;
		}
		resetConvertUi();
	});

	async function setResult(result, gen) {
		if (convertMeta) {
			track("convert", {
				text_length: convertMeta.textLength,
				wordlist: convertMeta.wordlist,
				output_format: RESULT_FORMAT,
				duration_ms: Date.now() - convertMeta.started,
				success: result.length > 0,
			});
			convertMeta = null;
		}
		pastResult = result;
		selectedHistoryId = null;
		editorPayload = null;
		outputField.hidden = false;
		if (result.length === 0) {
			outputText.textContent = "うまく変換できる単語を見つけられませんでした";
			btnOpenEditor.hidden = true;
			outputField.open = true;
		} else {
			outputText.textContent = makeResultText(result, RESULT_FORMAT);
			btnOpenEditor.hidden = false;
		}
		btnCopyResult.disabled = outputText.textContent.length === 0;
		if (result.length > 0) {
			const conversion = lastConversion;
			const payload = await makeEditorPayload(conversion, result);
			try {
				const entry = await historyRepository.add(payload, conversion.sourceText || conversion.phrases.join("\n"));
				historyEntries = await historyRepository.list();
				if (gen !== convertGen) return;
				showHistoryStatus("");
				selectHistoryEntry(entry);
			} catch {
				if (gen !== convertGen) return;
				editorPayload = payload;
				showHistoryStatus("この結果を履歴に保存できませんでした。編集画面の「書き出し」で保存できます。");
				resetConvertUi();
				saveMainState();
				return;
			}
		}
		if (gen !== convertGen) return;
		resetConvertUi();
		saveMainState();
		if (result.length > 0) openEditor().catch(showGenerationError);
	}

	btnCopyResult.addEventListener("click", async () => {
		if (!outputText.textContent) return;
		btnCopyResult.disabled = true;
		let message;
		let state;
		try {
			await writeClipboard(outputText.textContent);
			message = "コピーしました";
			state = "success";
		} catch (err) {
			console.error(err);
			message = "コピーに失敗しました";
			state = "error";
		}
		btnCopyResult.classList.add(`copy-${state}`);
		copyResultStatus.textContent = message;
		btnCopyResult.title = message;
		setTimeout(() => {
			btnCopyResult.classList.remove("copy-success", "copy-error");
			btnCopyResult.disabled = outputText.textContent.length === 0;
			copyResultStatus.textContent = "";
			btnCopyResult.title = "出力結果をコピー";
		}, 1500);
	});

	// 前回の変換結果の復元(単語リストの選択状態も戻す)
	if (savedMain) {
		// 詳細設定・単語重複・プリセットの選択状態を復元する。
		// 既定(バランス)はUI構築時に適用済みなので、保存値があるときだけ
		// 上書きする(旧セッションで欠けていれば既定のまま)
		paramControls.setValues({
			sound: savedMain.sound,
			phrase: savedMain.phrase,
			wordnum: savedMain.wordnum,
			duplicate: savedMain.duplicate || undefined,
		});
		if ("preset" in savedMain) {
			// 保存名に一致するプリセットをactive、null(カスタム)なら全部外す
			paramControls.setPreset(savedMain.preset);
		}
		if (savedMain.wordlistValue) {
			// 旧セッションのORIGINALは、移行済みの先頭リストへ読み替える。
			const restoredValue = savedMain.wordlistValue === "ORIGINAL" && customLists.length > 0
				? customWordlistValue(customLists[0].id) : savedMain.wordlistValue;
			const found = wordlistByValue.get(restoredValue);
			if (found) {
				found.activate();
				selectedWordlist = found.entry;
				renderFacets(selectedWordlist);
			}
		}
		paramControls.setValues({ priorityWords: savedMain.priorityWords, priorityContext: savedMain.priorityContext, priorityStrategy: savedMain.priorityStrategy });
		if (savedMain.pastResult && savedMain.pastResult.length > 0 && savedMain.lastConversion) {
			pastResult = savedMain.pastResult;
			lastConversion = savedMain.lastConversion;
			outputField.hidden = false;
			outputText.textContent = makeResultText(pastResult, RESULT_FORMAT);
			btnCopyResult.disabled = false;
			btnOpenEditor.hidden = false;
		}
	}
	await initializeHistory();

	btnConvert.addEventListener("click", () => {
		const text = inputText.value;
		if (text.trim() === "") return;
		$id("generation-error").hidden = true;
		if (isJsonInput()) {
			try {
				openEditorJson(text);
			} catch (error) {
				showGenerationError(error);
			}
			return;
		}
		if (text.length > 10000) {
			showGenerationError(new Error("歌詞は1万文字以内にしてください"));
			return;
		}
		const phrases = textToPhrases(text);
		const param = getParam();
		convertMeta = {
			started: Date.now(),
			textLength: text.length,
			wordlist: selectedWordlist ? selectedWordlist.value : "unknown",
		};

		$id("generation-error").hidden = true;
		const gen = ++convertGen;
		setGenerationBusy(true);
		btnConvert.disabled = true;
		btnConvert.textContent = "準備中...";
		btnCancel.hidden = false;
		progress.hidden = false;
		progressText.textContent = `0/${phrases.length}`;
		outputText.textContent = "";
		btnCopyResult.disabled = true;

		// UI描画を挟んでから重い処理に入る
		setTimeout(async () => {
			try {
				progressText.textContent = "単語リストを準備中...";
				const { tokensList, db, entry, where } = await prepareConversion(text, param);
				if (gen !== convertGen) return; // ロード中に中止・再実行された
				lastConversion = {
					phrases, tokensList, param, wordlist: entry, where, sourceText: text,
				};
				btnConvert.textContent = "生成中...";
				const updateFunc = (result, i) => {
					if (gen !== convertGen) return;
					progressText.textContent = `${i + 1}/${phrases.length}`;
				};
				convertHandle = app.soramimiMaker.generateFromTokens(tokensList, db, param, updateFunc, (result) => {
					if (gen !== convertGen) return; // 中止済みの結果は捨てる
					convertHandle = null;
					setResult(result, gen).catch(error => { showGenerationError(error); resetConvertUi(); });
				});
				convertHandle.finished?.catch(error => {
					if (gen !== convertGen) return;
					showGenerationError(error); resetConvertUi();
				});
			} catch (err) {
				if (gen !== convertGen) return;
				showGenerationError(err);
				resetConvertUi();
			}
		}, 50);
	});

	// 初期化完了
	lyricsFile.disabled = false;
	sampleButton.disabled = false;
	btnConvert.disabled = false;
	updateConvertLabel();
}
