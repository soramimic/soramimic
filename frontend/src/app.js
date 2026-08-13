// UIの配線。機能は旧 widget/(SettingArea, ConversionArea, NavigationButtons)と同等。
import { fetchText, fetchJson } from "./api.js";
import {
	loadEngine, buildDatabase, unitsListFromTokens,
} from "./appCore.js";
import { textToPhrases, makeResultText } from "./convert.js";
import { writeClipboard } from "./clipboard.js";
import { createYomiApi } from "./yomiApi.js";
import { originalTextToCsv } from "./wordlistInput.js";
import {
	createCustomWordlistRepository, customWordlistId, customWordlistValue,
	CUSTOM_WORDLISTS_STORAGE_KEY,
} from "./customWordlists.js";
import { readCustomWordlistFile } from "./customWordlistFile.js";
import { createLruCache } from "./lib/lruCache.js";
import {
	setupButtonGroup, createParamControls,
	renderFacets as renderFacetsIn, compileWhere as compileWhereIn,
} from "./convertControls.js";

const EDITOR_STORAGE_KEY = "soramimic-editor";
const DATABASE_CACHE_LIMIT = 2;

// GA4カスタムイベント送信(本番以外・広告ブロック時はgtag未定義なので何もしない)
function track(name, params) {
	if (typeof window.gtag === "function") window.gtag("event", name, params);
}

function $id(id) {
	return document.getElementById(id);
}

function setupTabs() {
	const links = document.querySelectorAll("[data-tab-link]");
	for (const link of links) {
		link.addEventListener("click", (e) => {
			e.preventDefault();
			const name = link.dataset.tabLink;
			for (const page of document.querySelectorAll(".tabpage")) {
				page.hidden = page.id !== `tab-${name}`;
			}
			for (const l of document.querySelectorAll(".tabs a")) {
				l.classList.toggle("active", l.dataset.tabLink === name);
			}
		});
	}
}

export async function startApp() {
	setupTabs();

	const btnConvert = $id("btn-convert");
	const btnCancel = $id("btn-cancel");
	const progress = $id("progress");
	const progressText = $id("progress-text");
	const inputText = $id("input-text");
	const outputField = $id("output-field");
	const outputText = $id("output-text");
	const formatSelect = $id("format-select");
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
	const customWordlistActions = $id("custom-wordlist-actions");
	const btnCustomWordlistEdit = $id("btn-custom-wordlist-edit");

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
		if (savedMain.format) formatSelect.value = savedMain.format;
	}

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
	const paramControls = createParamControls({
		paramArea: $id("param-area"),
		presetArea: $id("preset-buttons"),
		duplicateArea: duplicateButtons,
		onChange: (kind, preset) => {
			if (kind === "preset") track("param_preset", { preset: preset.name });
			saveMainState();
		},
	});

	function getParam() {
		return Object.assign(paramControls.getParam(), {
			OUTPUT_FORMAT: formatSelect.value,
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
				const { chunks, plan } = app.textAnalyzer.splitByRuby(phrases);
				const raw = await yomiApi.tokenize(chunks);
				return app.textAnalyzer.formatTokensList(
					app.textAnalyzer.mergeRubyTokens(raw, plan));
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

	// 設定の wordlist は「エントリ(=ボタン)」と「グループ {label, items}(=プルダウン)」の混在。
	// 表示順・グループ分け・ラベルはすべて設定ファイル側で決める。
	// プルダウンは「自前描画のチップ + 透明な<select>を重ねる」構造。
	// (iOS Safariはplaceholder用optionをピッカーに出したり、未選択時の
	//  表示を先頭項目にしたりとクセがあるため、表示はselectに任せない)
	const wordlistSelects = []; // { sel, wrap, textEl, label }
	const wordlistByValue = new Map(); // value → { entry, activate(=コントロールを選択状態にする) }

	// ボタン・プルダウンをまたいで選択状態を排他にする
	function setWordlistControl(activeEl) {
		for (const b of wordlistButtons.querySelectorAll("button")) {
			b.classList.toggle("active", b === activeEl);
		}
		for (const s of wordlistSelects) {
			const isActive = s.sel === activeEl;
			if (!isActive) {
				s.sel.selectedIndex = -1; // ピッカーのチェックも外す
				s.textEl.textContent = s.label;
				s.capEl.hidden = true;
			}
			s.wrap.classList.toggle("active", isActive);
		}
	}

	function addWordlistButton(entry) {
		const btn = document.createElement("button");
		btn.className = "btn" + (entry.active ? " active" : "");
		btn.textContent = entry.text;
		btn.dataset.value = entry.value;
		btn.__config = entry;
		wordlistButtons.appendChild(btn);
		wordlistByValue.set(entry.value, { entry, activate: () => setWordlistControl(btn) });
		if (entry.active) selectedWordlist = entry;
		return btn;
	}

	for (const item of config.wordlist) {
		if (!item.items) {
			addWordlistButton(item);
			continue;
		}
		const wrap = document.createElement("span");
		wrap.className = "btn wordlist-select-wrap";
		// 選択中はグループ名を小さく前置する(「架空 ファンタジー」)。
		// 未選択時はグループ名だけを通常サイズで出す
		const capEl = document.createElement("span");
		capEl.className = "wordlist-select-caption";
		capEl.textContent = item.label;
		capEl.hidden = true;
		const textEl = document.createElement("span");
		textEl.textContent = item.label;
		const sel = document.createElement("select");
		sel.setAttribute("aria-label", item.label);
		const optgroup = document.createElement("optgroup");
		optgroup.label = item.label;
		sel.appendChild(optgroup);
		for (const entry of item.items) {
			const opt = document.createElement("option");
			opt.value = entry.value;
			opt.textContent = entry.text;
			opt.__config = entry;
			optgroup.appendChild(opt);
			wordlistByValue.set(entry.value, {
				entry,
				activate: () => {
					sel.value = entry.value;
					setWordlistControl(sel);
					textEl.textContent = entry.text;
					capEl.hidden = false;
				},
			});
		}
		sel.selectedIndex = -1; // 初期状態は未選択(チップにはグループ名を表示)
		sel.addEventListener("change", () => {
			const opt = sel.selectedOptions[0];
			if (!opt) return;
			setWordlistControl(sel);
			textEl.textContent = opt.textContent;
			capEl.hidden = false;
			selectedWordlist = opt.__config;
			renderFacets(selectedWordlist);
			saveMainState();
		});
		wrap.append(capEl, textEl, sel);
		wordlistButtons.appendChild(wrap);
		wordlistSelects.push({ sel, wrap, textEl, capEl, label: item.label });
	}

	// 自作リストは名前付きで複数保存し、既存のグループ型UIと同じselectから選ぶ。
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
	customWrap.className = "btn wordlist-select-wrap";
	const customCapEl = document.createElement("span");
	customCapEl.className = "wordlist-select-caption";
	customCapEl.textContent = "自作";
	customCapEl.hidden = true;
	const customTextEl = document.createElement("span");
	customTextEl.textContent = "自作リスト";
	const customSelect = document.createElement("select");
	customSelect.setAttribute("aria-label", "自作リスト");
	customWrap.append(customCapEl, customTextEl, customSelect);
	wordlistButtons.appendChild(customWrap);
	wordlistSelects.push({
		sel: customSelect, wrap: customWrap, textEl: customTextEl,
		capEl: customCapEl, label: "自作リスト",
	});

	function customEntry(list) {
		return {
			value: customWordlistValue(list.id),
			text: list.name,
			customId: list.id,
			originalText: list.text,
			updatedAt: list.updatedAt,
		};
	}

	function renderCustomOptions() {
		for (const value of [...wordlistByValue.keys()]) {
			if (customWordlistId(value)) wordlistByValue.delete(value);
		}
		customSelect.replaceChildren();
		const group = document.createElement("optgroup");
		group.label = "保存済み";
		for (const list of customLists) {
			const entry = customEntry(list);
			const opt = document.createElement("option");
			opt.value = entry.value;
			opt.textContent = entry.text;
			opt.__config = entry;
			group.appendChild(opt);
			wordlistByValue.set(entry.value, {
				entry,
				activate: () => {
					customSelect.value = entry.value;
					setWordlistControl(customSelect);
					customTextEl.textContent = entry.text;
					customCapEl.hidden = false;
				},
			});
		}
		if (customLists.length > 0) customSelect.appendChild(group);
		const add = document.createElement("option");
		add.value = "__NEW_CUSTOM_WORDLIST__";
		add.textContent = "＋ 新しいリスト";
		customSelect.appendChild(add);
		customSelect.selectedIndex = -1;
	}
	renderCustomOptions();
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
	const renderFacets = (entry) => renderFacetsIn(wordlistFacets, entry);
	const compileWhere = (entry) => compileWhereIn(wordlistFacets, entry);

	setupButtonGroup(wordlistButtons, (btn) => {
		setWordlistControl(btn); // プルダウン側の選択も解除する
		selectedWordlist = btn.__config;
		renderFacets(selectedWordlist);
		customWordlistActions.hidden = true;
		saveMainState();
	});
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

	customSelect.addEventListener("change", () => {
		if (customSelect.value === "__NEW_CUSTOM_WORDLIST__") {
			customSelect.selectedIndex = -1;
			restoreSelectedWordlistControl();
			openOriginalDialog();
			return;
		}
		const found = wordlistByValue.get(customSelect.value);
		if (!found) return;
		found.activate();
		selectedWordlist = found.entry;
		renderFacets(selectedWordlist);
		customWordlistActions.hidden = false;
		saveMainState();
	});

	btnCustomWordlistEdit.addEventListener("click", () => {
		const id = customWordlistId(selectedWordlist && selectedWordlist.value);
		const list = id && customLists.find((item) => item.id === id);
		if (list) openOriginalDialog(list);
	});

	$id("original-cancel").addEventListener("click", () => originalDialog.close());
	$id("btn-original-file").addEventListener("click", () => originalFile.click());
	originalFile.addEventListener("change", async () => {
		const file = originalFile.files && originalFile.files[0];
		originalFile.value = ""; // 同じファイルを選び直してもchangeを発火させる
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
			const saved = editingCustomId
				? customRepository.update(editingCustomId, { name, text }, {
					expectedUpdatedAt: editingCustomUpdatedAt,
				})
				: customRepository.create({ name, text });
			customLoadError = null;
			customLists = customRepository.list();
			renderCustomOptions();
			const found = wordlistByValue.get(customWordlistValue(saved.id));
			found.activate();
			selectedWordlist = found.entry;
			renderFacets(selectedWordlist);
			customWordlistActions.hidden = false;
			saveMainState();
			track("wordlist_original", { action: editingCustomId ? "update" : "create" });
			originalDialog.close();
		} catch (err) {
			console.warn("自作リストの保存に失敗:", err);
			showOriginalStatus("保存できませんでした: " + err.message);
		}
	});

	$id("original-delete").addEventListener("click", () => {
		const list = customLists.find((item) => item.id === editingCustomId);
		if (!list || !confirm(`「${list.name}」を削除しますか？`)) return;
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
				customWordlistActions.hidden = true;
				saveMainState();
			}
			track("wordlist_original", { action: "delete" });
			originalDialog.close();
		} catch (err) {
			console.warn("自作リストの削除に失敗:", err);
			showOriginalStatus("削除できませんでした: " + err.message);
		}
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
				customWordlistActions.hidden = true;
				renderFacets(selectedWordlist);
				saveMainState();
			}
		} catch (err) {
			console.warn("別タブの自作リスト更新を反映できませんでした:", err);
		}
	});

	// ---- サンプル(歌詞 × 単語リスト) ----
	// クリックで歌詞と単語リストをセットし、そのまま変換まで実行する
	// (初見でも1クリックで結果に届く)。単語リストの登録は wordlistByValue に
	// 依存するため、リスト構築後のここで配線する。変換実行中はボタンが
	// disabledでclick()が効かないため、歌詞・リストの差し替えだけになる
	$id("sample-buttons").addEventListener("click", async (e) => {
		const btn = e.target.closest("button[data-path]");
		if (!btn) return;
		track("sample_select", { song: btn.dataset.path, wordlist: btn.dataset.wordlist });
		const found = wordlistByValue.get(btn.dataset.wordlist);
		if (found) {
			found.activate();
			selectedWordlist = found.entry;
			renderFacets(selectedWordlist);
		}
		inputText.value = await fetchText(btn.dataset.path);
		saveMainState();
		btnConvert.click();
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

	function saveMainState() {
		try {
			const values = paramControls.getValues();
			sessionStorage.setItem(MAIN_STORAGE_KEY, JSON.stringify({
				text: inputText.value,
				format: formatSelect.value,
				wordlistValue: selectedWordlist ? selectedWordlist.value : null,
				// activeなプリセット名(手で詳細設定を触った=カスタムのときはnull)
				preset: paramControls.activePresetName(),
				sound: values.sound,
				phrase: values.phrase,
				wordnum: values.wordnum,
				duplicate: String(values.duplicate),
				pastResult,
				lastConversion,
			}));
		} catch (err) {
			console.warn("生成画面の状態保存に失敗:", err);
		}
	}
	inputText.addEventListener("input", saveMainState);

	let convertMeta = null; // 変換1回分の計測情報(convertイベント用)

	const btnOpenEditor = $id("btn-open-editor");
	btnOpenEditor.addEventListener("click", async () => {
		if (!pastResult || pastResult.length === 0 || !lastConversion) return;
		track("open_editor", {});
		// 結果がある時点でエンジンはロード済みのはずだが、前回セッションの
		// 結果復元直後だけは未ロードがあり得るため念のため待つ
		// (sessionStorageは新タブ生成時にコピーされるため、window.openは
		//  必ずデータを書き終えたあとに呼ぶこと)
		({ app } = await enginePromise);
		// 発音ユニット列(結果単語のperiodが指すインデックス列)も渡し、
		// 編集画面が表示のためだけにトークナイザを再初期化しなくて済むようにする
		const unitsList = unitsListFromTokens(app, lastConversion.tokensList);
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify({
			phrases: lastConversion.phrases,
			tokensList: lastConversion.tokensList,
			results: pastResult,
			param: lastConversion.param,
			wordlist: lastConversion.wordlist,
			where: lastConversion.where,
			unitsList,
		}));
		window.open("editor.html");
	});

	// 変換の世代トークン。中止・再実行のたびに進め、エンジン・辞書ロード中
	// (=生成チェーン開始前)に中止された変換が後から走り出すのを防ぐ。
	// 開始済みのチェーンは convertHandle.cancel() で止める
	let convertGen = 0;
	let convertHandle = null;

	function resetConvertUi() {
		progress.hidden = true;
		btnCancel.hidden = true;
		btnConvert.disabled = false;
		btnConvert.textContent = "変換";
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

	function setResult(result) {
		if (convertMeta) {
			track("convert", {
				text_length: convertMeta.textLength,
				wordlist: convertMeta.wordlist,
				output_format: formatSelect.value,
				duration_ms: Date.now() - convertMeta.started,
				success: result.length > 0,
			});
			convertMeta = null;
		}
		pastResult = result;
		outputField.hidden = false;
		if (result.length === 0) {
			outputText.value = "うまく変換できる単語を見つけられませんでした";
			btnOpenEditor.hidden = true;
		} else {
			outputText.value = makeResultText(result, formatSelect.value);
			btnOpenEditor.hidden = false;
		}
		btnCopyResult.disabled = outputText.value.length === 0;
		resetConvertUi();
		saveMainState();
	}

	formatSelect.addEventListener("change", () => {
		if (pastResult && pastResult.length > 0) {
			outputText.value = makeResultText(pastResult, formatSelect.value);
			btnCopyResult.disabled = false;
		}
		saveMainState();
	});

	btnCopyResult.addEventListener("click", async () => {
		if (!outputText.value) return;
		btnCopyResult.disabled = true;
		let message;
		let state;
		try {
			await writeClipboard(outputText.value);
			message = "コピーしました";
			state = "success";
		} catch (err) {
			console.error(err);
			message = "コピーに失敗しました";
			state = "error";
		}
		btnCopyResult.classList.add(`copy-${state}`);
		copyResultStatus.textContent = message;
		setTimeout(() => {
			btnCopyResult.classList.remove("copy-success", "copy-error");
			btnCopyResult.disabled = outputText.value.length === 0;
			copyResultStatus.textContent = "";
		}, 1500);
	});
	outputText.addEventListener("input", () => {
		btnCopyResult.disabled = outputText.value.length === 0;
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
				customWordlistActions.hidden = !customWordlistId(selectedWordlist.value);
			}
		}
		if (savedMain.pastResult && savedMain.pastResult.length > 0 && savedMain.lastConversion) {
			pastResult = savedMain.pastResult;
			lastConversion = savedMain.lastConversion;
			outputField.hidden = false;
			outputText.value = makeResultText(pastResult, formatSelect.value);
			btnCopyResult.disabled = false;
			btnOpenEditor.hidden = false;
		}
	}

	btnConvert.addEventListener("click", () => {
		const text = inputText.value;
		if (text.trim() === "") return;
		const phrases = textToPhrases(text);
		const param = getParam();
		convertMeta = {
			started: Date.now(),
			textLength: text.length,
			wordlist: selectedWordlist ? selectedWordlist.value : "unknown",
		};

		const gen = ++convertGen;
		btnConvert.disabled = true;
		btnConvert.textContent = "準備中...";
		btnCancel.hidden = false;
		progress.hidden = false;
		progressText.textContent = `0/${phrases.length}`;
		outputText.value = "";
		btnCopyResult.disabled = true;

		// UI描画を挟んでから重い処理に入る
		setTimeout(async () => {
			try {
				// 初回はエンジン(データ+辞書)のロード完了をここで待つ。
				// appは「音の合わせ方」(vowelRatio)に応じたインスタンスを使う
				const engine = await enginePromise;
				app = engine.appFor(param.VOWEL_RATIO);
				// ファセットのチェック状態は変換後も操作できるため、
				// DB構築に実際使ったwhereをここで確定して編集画面へ引き継ぐ
				let entry = selectedWordlist;
				// 変換時の自作リストを正規化CSVとしてスナップショット化する。
				// 変換後に保存内容を編集・削除しても、編集ツール側で同じ候補を再現できる。
				if (customWordlistId(entry && entry.value)) {
					entry = {
						...entry,
						originalText: undefined,
						csvText: originalTextToCsv(entry.originalText, app),
					};
				}
				const where = compileWhere(entry);
				const tokensList = await tokenizePhrases(phrases);
				// 単語DBのキー長は getYomiAndPhraseBreak が返す発音ユニット数と
				// 同じ。歌詞側の最大値を先に求め、不要に長いバリエーションを
				// DBへ展開しない。
				const maxUnits = tokensList.reduce((max, tokens) =>
					Math.max(max, app.textAnalyzer.getYomiAndPhraseBreak(tokens).length), 0);
				progressText.textContent = "単語リストを準備中...";
				const db = await getDatabase(entry, where, maxUnits > 0 ? maxUnits : undefined);
				if (gen !== convertGen) return; // ロード中に中止・再実行された
				lastConversion = {
					phrases, tokensList, param, wordlist: entry, where,
				};
				btnConvert.textContent = "変換中...";
				const updateFunc = (result, i) => {
					if (gen !== convertGen) return;
					progressText.textContent = `${i + 1}/${phrases.length}`;
				};
				convertHandle = app.soramimiMaker.generateFromTokens(tokensList, db, param, updateFunc, (result) => {
					if (gen !== convertGen) return; // 中止済みの結果は捨てる
					convertHandle = null;
					setResult(result);
				});
			} catch (err) {
				console.error(err);
				if (gen !== convertGen) return;
				outputField.hidden = false;
				outputText.value = "エラーが発生しました: " + err.message;
				btnCopyResult.disabled = false;
				resetConvertUi();
			}
		}, 50);
	});

	// 初期化完了
	btnConvert.disabled = false;
	btnConvert.textContent = "変換";
}
