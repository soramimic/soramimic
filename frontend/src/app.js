// UIの配線。機能は旧 widget/(SettingArea, ConversionArea, NavigationButtons)と同等。
import { fetchText, fetchJson } from "./api.js";
import {
	loadEngine, buildDatabase, unitsListFromTokens, ORIGINAL_STORAGE_KEY,
} from "./appCore.js";
import { textToPhrases, makeResultText } from "./convert.js";
import { createYomiApi } from "./yomiApi.js";
import {
	setupButtonGroup, createParamControls,
	renderFacets as renderFacetsIn, compileWhere as compileWhereIn,
} from "./convertControls.js";

const EDITOR_STORAGE_KEY = "soramimic-editor";

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
	const duplicateButtons = $id("duplicate-buttons");
	const wordlistButtons = $id("wordlist-buttons");
	const wordlistFacets = $id("wordlist-facets");
	const originalDialog = $id("original-dialog");
	const originalText = $id("original-text");

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
	const dbCache = new Map();

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
	const originalBtn = addWordlistButton({
		value: "ORIGINAL",
		text: "自作の単語リストを使用",
	});

	// ファセット絞り込み(描画・whereのコンパイル)も編集ツールと共有する。
	// 共有関数はコンテナ引数を取るので、生成画面のコンテナを束ねただけのラッパにする
	const renderFacets = (entry) => renderFacetsIn(wordlistFacets, entry);
	const compileWhere = (entry) => compileWhereIn(wordlistFacets, entry);

	setupButtonGroup(wordlistButtons, (btn) => {
		setWordlistControl(btn); // プルダウン側の選択も解除する
		selectedWordlist = btn.__config;
		renderFacets(selectedWordlist);
		if (btn === originalBtn) {
			originalText.value = localStorage.getItem(ORIGINAL_STORAGE_KEY) || "";
			originalDialog.showModal();
		}
		saveMainState();
	});
	renderFacets(selectedWordlist);

	$id("original-cancel").addEventListener("click", () => originalDialog.close());
	$id("original-register").addEventListener("click", () => {
		localStorage.setItem(ORIGINAL_STORAGE_KEY, originalText.value);
		track("wordlist_original", {});
		originalDialog.close();
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
		// キーは内容で構成する(ORIGINALは登録テキスト自体をキーにする)
		if (entry.value === "ORIGINAL") {
			const key = "ORIGINAL|" + maxUnits + "|" + (localStorage.getItem(ORIGINAL_STORAGE_KEY) || "");
			if (!dbCache.has(key)) dbCache.set(key, await buildDatabase(app, entry, undefined, maxUnits));
			return dbCache.get(key);
		}
		const key = [entry.filepath, entry.dbtype, where, maxUnits].join("|");
		if (!dbCache.has(key)) {
			dbCache.set(key, await buildDatabase(app, entry, where, maxUnits));
		}
		return dbCache.get(key);
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
		resetConvertUi();
		saveMainState();
	}

	formatSelect.addEventListener("change", () => {
		if (pastResult && pastResult.length > 0) {
			outputText.value = makeResultText(pastResult, formatSelect.value);
		}
		saveMainState();
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
			const found = wordlistByValue.get(savedMain.wordlistValue);
			if (found) {
				found.activate();
				selectedWordlist = found.entry;
				renderFacets(selectedWordlist);
			}
		}
		if (savedMain.pastResult && savedMain.pastResult.length > 0 && savedMain.lastConversion) {
			pastResult = savedMain.pastResult;
			lastConversion = savedMain.lastConversion;
			outputField.hidden = false;
			outputText.value = makeResultText(pastResult, formatSelect.value);
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

		// UI描画を挟んでから重い処理に入る
		setTimeout(async () => {
			try {
				// 初回はエンジン(データ+辞書)のロード完了をここで待つ。
				// appは「音の合わせ方」(vowelRatio)に応じたインスタンスを使う
				const engine = await enginePromise;
				app = engine.appFor(param.VOWEL_RATIO);
				// ファセットのチェック状態は変換後も操作できるため、
				// DB構築に実際使ったwhereをここで確定して編集画面へ引き継ぐ
				const entry = selectedWordlist;
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
				resetConvertUi();
			}
		}, 50);
	});

	// 初期化完了
	btnConvert.disabled = false;
	btnConvert.textContent = "変換";
}
