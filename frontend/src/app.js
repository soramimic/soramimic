// UIの配線。機能は旧 widget/(SettingArea, ConversionArea, NavigationButtons)と同等。
import { fetchText, fetchJson } from "./api.js";
import { loadEngine, buildDatabase, ORIGINAL_STORAGE_KEY } from "./appCore.js";
import { textToPhrases, makeResultText } from "./convert.js";
import { createYomiApi } from "./yomiApi.js";

const EDITOR_STORAGE_KEY = "soramimic-editor";

// GA4カスタムイベント送信(本番以外・広告ブロック時はgtag未定義なので何もしない)
function track(name, params) {
	if (typeof window.gtag === "function") window.gtag("event", name, params);
}

function $id(id) {
	return document.getElementById(id);
}

// 単一選択のボタングループ
function setupButtonGroup(container, onChange) {
	container.addEventListener("click", (e) => {
		const btn = e.target.closest("button");
		if (!btn) return;
		for (const b of container.querySelectorAll("button")) {
			b.classList.toggle("active", b === btn);
		}
		if (onChange) onChange(btn);
	});
}

function activeValue(container) {
	const btn = container.querySelector("button.active");
	return btn ? btn.dataset.value : null;
}

// 両端ラベル付きスライダーの1項目を作る(「音の合わせ方」「文節の区切り」「単語の長さ」で共通)。
// val() は生のスライダー値(数値)を返す。ペナルティへの写像は呼び出し側で行う。
function createSliderItem({ label, leftText, rightText, min, max, step, defaultValue, ariaLabel }) {
	const item = document.createElement("div");
	item.className = "param-item param-item-wide";
	const title = document.createElement("h4");
	title.className = "field-label";
	title.textContent = label;
	const row = document.createElement("div");
	row.className = "slider-row";
	const left = document.createElement("span");
	left.className = "slider-end";
	left.textContent = leftText;
	const right = document.createElement("span");
	right.className = "slider-end";
	right.textContent = rightText;
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.value = String(defaultValue);
	slider.setAttribute("aria-label", ariaLabel || label);
	row.append(left, slider, right);
	item.append(title, row);
	return {
		element: item,
		val: () => Number(slider.value),
		set: (value) => { slider.value = String(value); },
	};
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
	setupButtonGroup(duplicateButtons, saveMainState);
	const paramArea = $id("param-area");
	// パラメータUIの再設計(#21 → #102)。monophoneタイブレーク行列(#102)に基づく:
	// - 「音の合わせ方」= vowelRatio(r)。行列がコア音素タイブレーク方式になったので、
	//   rは純粋な母音/子音の重み。既定 r=0.8 で「母音ロック・子音タイブレーク」
	//   (旧既定相当だが子音一致率はむしろ良い)、左に振ると子音ロックへ滑らかに移る。
	//   SAME_VOWEL/CONSONANT_REWARD の掛け算ハックは撤廃(#102 実測)。
	// - 文節・単語長は3択トグルからスライダーへ。内部ペナルティは線形。
	//   文節 0(無視)〜8(がっちり守る)、内部値は×20(=0〜160)。MIDスイープ実測
	//   (furusato/umi/placeholder)で MID=160 が3入力とも文節内切断ゼロの飽和点で、
	//   応答は単調・線形写像が最適(母音の犠牲は最大-7pt)。旧×5(上限40)では
	//   編集距離換算2.5操作分で不足し「文節重視でも文節が無視される」ため再較正した
	//   (1ステップ=編集距離1.25操作分)。「がっちり守る」でも候補枯渇時は切れる
	//   (絶対切断ではない含意)。既定1(=20)。
	//   単語長 0(細かめ)〜6(長め)、内部値は×10(=0〜60)。既定2(=20)。
	// 既定値(r=0.8・文節1・単語長2)は本番「バランス」プリセットと同一。
	const iptSound = createSliderItem({
		label: "音の合わせ方", leftText: "子音重視", rightText: "母音重視",
		min: 0.1, max: 0.9, step: 0.1, defaultValue: 0.8,
		ariaLabel: "音の合わせ方(子音重視〜母音重視)",
	});
	const iptPhrasebreak = createSliderItem({
		label: "文節の区切り", leftText: "無視", rightText: "がっちり守る",
		min: 0, max: 8, step: 1, defaultValue: 1,
		ariaLabel: "文節の区切り(無視〜がっちり守る)",
	});
	const iptWordnum = createSliderItem({
		label: "単語の長さ", leftText: "細かめ", rightText: "長め",
		min: 0, max: 6, step: 1, defaultValue: 2,
		ariaLabel: "単語の長さ(細かめ〜長め)",
	});
	for (const p of [iptSound, iptPhrasebreak, iptWordnum]) {
		paramArea.appendChild(p.element);
	}

	// プリセット: ワンタップで詳細設定(スライダー)へ値を流し込む。
	// 全プリセット r=0.8(母音ロック)固定で、文節・単語長の強さだけ変える(#102):
	//   バランス   MID20(文節1)/WNP20(音そっくりと文節重視の中間、既定)
	//   音そっくり MID0/WNP0(音韻マックス)
	//   文節重視   MID160(文節8=スライダー最大・実測の飽和点)/WNP20
	//   長い単語   MID20(文節1)/WNP60(スライダー最大)
	const PRESETS = [
		{ name: "バランス", sound: 0.8, phrase: 1, wordnum: 2 },
		{ name: "音そっくり", sound: 0.8, phrase: 0, wordnum: 0 },
		{ name: "文節重視", sound: 0.8, phrase: 8, wordnum: 2 },
		{ name: "長い単語", sound: 0.8, phrase: 1, wordnum: 6 },
	];
	const presetButtons = $id("preset-buttons");
	for (const preset of PRESETS) {
		const btn = document.createElement("button");
		btn.className = "btn" + (preset.name === "バランス" ? " active" : "");
		btn.textContent = preset.name;
		btn.__preset = preset;
		presetButtons.appendChild(btn);
	}
	function applyPreset(p) {
		iptSound.set(p.sound);
		iptPhrasebreak.set(p.phrase);
		iptWordnum.set(p.wordnum);
	}
	applyPreset(PRESETS[0]); // 既定はバランス(詳細設定の初期値もここから決まる)
	setupButtonGroup(presetButtons, (btn) => {
		applyPreset(btn.__preset);
		track("param_preset", { preset: btn.__preset.name });
		saveMainState();
	});
	// 詳細設定を手で触ったらプリセットの選択表示を外す(値はカスタム扱い)
	function clearPresetSelection() {
		for (const b of presetButtons.querySelectorAll("button")) {
			b.classList.remove("active");
		}
	}
	paramArea.addEventListener("click", (e) => {
		if (e.target.closest("button")) { clearPresetSelection(); saveMainState(); }
	});
	paramArea.addEventListener("input", () => { clearPresetSelection(); saveMainState(); });

	function getParam() {
		return {
			// SAME_VOWEL/CONSONANT_REWARD は撤廃(#102)。母音ロックは類似度行列自体が
			// monophoneタイブレーク方式になったことで表現され、掛け算ハックは不要。
			// 未指定なのでlib既定(=1、無効化)のまま。母音/子音の重みは VOWEL_RATIO で調整する。
			VOWEL_RATIO: iptSound.val(),
			// ン/ッ/ーの1変換操作コスト。母音準一致セル(名目20)相当を実効値として
			// vowelRatio(=r)に連動させる(実効=20×r。行列は母音側が2r倍される)。#105
			VARIATION_COST: 20 * Number(iptSound.val()),
			// 文節つまみは「境界一致への報酬」ではなく「文節内で切ることへの
			// ペナルティ」に写像する(#98)。報酬方式は30で飽和し、文節内分割を
			// 抑止できなかったため置き換え。係数は×20(UI0〜8→内部0〜160)。
			// MIDスイープ実測でMID=160が3入力とも文節内切断ゼロの飽和点・線形応答
			// (1ステップ=編集距離1.25操作分)。旧×5(上限40)では文節重視でも切断が残った
			SAME_PHRASE_BREAK_REWARD: 0,
			MID_PHRASE_BREAK_PENALTY: iptPhrasebreak.val() * 20,
			WORD_NUMBER_PENALTY: iptWordnum.val() * 10,
			DUPLICATE: activeValue(duplicateButtons) === "true",
			OUTPUT_FORMAT: formatSelect.value,
		};
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
	// 後処理(formatTokensList)はどちらの経路でも共通
	async function tokenizePhrases(phrases) {
		if (yomiApiReady) {
			try {
				const raw = await yomiApi.tokenize(phrases);
				return app.textAnalyzer.formatTokensList(raw);
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

	// facet の1つの選択肢を where 断片に変換する。設定で述語を定義できる:
	// - item.where があればそれをそのまま使う(任意の述語。SQL 的な自由度)
	// - facet.columns(配列)があれば全列の or に展開する
	//   (例: {columns:["type1","type2"]} で炎チェック→ type1=ほのお or type2=ほのお)
	// - どちらも無ければ facet.column=値(従来互換)
	function facetClause(f, item) {
		if (item.where) return item.where;
		const cols = f.columns || [f.column];
		return "(" + cols.map((c) => `${c}=${item.v}`).join(" or ") + ")";
	}

	// 選択中リストの facets(絞り込みチェックボックス)を描画する
	function renderFacets(entry) {
		wordlistFacets.innerHTML = "";
		const facets = (entry && entry.facets) || [];
		for (const f of facets) {
			const group = document.createElement("div");
			group.className = "facet-group";
			const label = document.createElement("span");
			label.className = "facet-label";
			label.textContent = f.label || f.column || "";
			group.appendChild(label);
			for (const item of f.values) {
				const lbl = document.createElement("label");
				lbl.className = "facet-check";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.value = item.v;
				cb.checked = item.default === true;
				// 各選択肢が担う where 断片を要素に持たせる(単一列に限らない)
				cb.__where = facetClause(f, item);
				lbl.append(cb, document.createTextNode(item.label || item.v));
				group.appendChild(lbl);
			}
			wordlistFacets.appendChild(group);
		}
	}

	// 現在のチェック状態を where 文字列にコンパイルする。
	// 同一 facet 内は or、facet をまたぐと and。未チェックの facet は制約なし。
	// 各選択肢の断片は facetClause() が決める(column= / columns の or / 任意の where)。
	// facets 未定義のエントリは従来どおり entry.where を返す。
	function compileWhere(entry) {
		const facets = (entry && entry.facets) || [];
		if (facets.length === 0) return entry ? entry.where : undefined;
		const clauses = [];
		for (const group of wordlistFacets.querySelectorAll(".facet-group")) {
			const frags = [...group.querySelectorAll("input:checked")]
				.map((cb) => cb.__where);
			if (frags.length === 0) continue; // 制約なし
			clauses.push("(" + frags.join(" or ") + ")");
		}
		return clauses.join(" and ");
	}

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

	async function getDatabase(entry, where) {
		// 同じvalueでもwhere(ファセット絞り込み含む)が異なると別物なので、
		// キーは内容で構成する(ORIGINALは登録テキスト自体をキーにする)
		if (entry.value === "ORIGINAL") {
			const key = "ORIGINAL|" + (localStorage.getItem(ORIGINAL_STORAGE_KEY) || "");
			if (!dbCache.has(key)) dbCache.set(key, await buildDatabase(app, entry));
			return dbCache.get(key);
		}
		const key = [entry.filepath, entry.dbtype, where].join("|");
		if (!dbCache.has(key)) {
			dbCache.set(key, await buildDatabase(app, entry, where));
		}
		return dbCache.get(key);
	}

	// ---- 変換 ----
	let pastResult = null;
	let lastConversion = null; // 直近の変換入力(編集ツールへの受け渡し用)

	function saveMainState() {
		try {
			// activeなプリセット名(手で詳細設定を触った=カスタムのときはnull)
			const activePreset = presetButtons.querySelector("button.active");
			sessionStorage.setItem(MAIN_STORAGE_KEY, JSON.stringify({
				text: inputText.value,
				format: formatSelect.value,
				wordlistValue: selectedWordlist ? selectedWordlist.value : null,
				preset: activePreset ? activePreset.textContent : null,
				sound: iptSound.val(),
				phrase: iptPhrasebreak.val(),
				wordnum: iptWordnum.val(),
				duplicate: activeValue(duplicateButtons),
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
		const unitsList = lastConversion.tokensList.map((tokens) =>
			app.textAnalyzer.getYomiAndPhraseBreak(tokens).map((u) => ({
				surface_form: u.surface_form,
				pronunciation: u.pronunciation,
				phrase: u.phrase,
			})));
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
		// 既定のバランスは applyPreset(PRESETS[0]) で適用済みなので、
		// 保存値があるときだけ上書きする(旧セッションで欠けていれば既定のまま)
		if (typeof savedMain.sound === "number") iptSound.set(savedMain.sound);
		if (typeof savedMain.phrase === "number") iptPhrasebreak.set(savedMain.phrase);
		if (typeof savedMain.wordnum === "number") iptWordnum.set(savedMain.wordnum);
		if (savedMain.duplicate) {
			for (const b of duplicateButtons.querySelectorAll("button")) {
				b.classList.toggle("active", b.dataset.value === savedMain.duplicate);
			}
		}
		if ("preset" in savedMain) {
			// 保存名に一致するプリセットをactive、null(カスタム)なら全部外す
			for (const b of presetButtons.querySelectorAll("button")) {
				b.classList.toggle("active", b.textContent === savedMain.preset);
			}
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
				const db = await getDatabase(entry, where);
				const tokensList = await tokenizePhrases(phrases);
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
