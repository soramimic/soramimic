// 編集ツール(#17)のエントリ。
// ステップ1: アライン表示 / ステップ2: 候補選択・差し替え・自由入力 /
// ステップ3: 🔒固定+部分再生成、コピー /
// 以降: タップ・ドラッグ選択、候補グループ化・使用中表示・長押し詳細、戻る/進む
import "./style.css";
import "./editor.css";
import "./appBridge.js";
import {
	isVideoReview, setupReviewToolbar, renderReviewLine, appendReviewHeader,
} from "./editorReview.js";
import {
	initSoramimicApp, buildDatabase, unitsListFromTokens, ORIGINAL_STORAGE_KEY,
} from "./appCore.js";
import { originalTextToCsv, looksLikeTidyHeader } from "./wordlistInput.js";
import { alignLyricsToLines } from "./xfAlign.js";
import { fetchJson } from "./api.js";
import { makeResultText } from "./convert.js";
import { writeClipboard } from "./clipboard.js";
import { absorbSmallKana } from "./lib/kanaToSyllable.js";
import { findPlacements, highlightOriginal } from "./reverseSearch.js";
import { lineRegenerationInput } from "./editorRegeneration.js";
import { wordlistKey, wordlistSource, isCurrentWord, generationLock, generatedWords } from "./editorWordIdentity.js";
import {
	createParamControls, valuesFromParam,
	hasFacets, renderFacets, compileWhere, restoreFacets,
} from "./convertControls.js";

const videoPeer = window.SoramimicBridge.peer("video", import.meta.env.VITE_SORAMIMIC_VIDEO_URL);

export const EDITOR_STORAGE_KEY = "soramimic-editor";
const GROUP_PAGE = 30; // 「もっと見る」1回で増える候補グループ数
const GROUP_MAX = 100; // 候補グループの最大表示数
const RAW_FETCH = 300; // グループ化(同姓同名まとめ)前に取得する候補数
const HISTORY_MAX = 50; // 「戻る」履歴の上限
const LONG_PRESS_MS = 500; // 候補詳細を出す長押しの判定時間
const HOST_POLL_MS = 1500; // ホストの応答(hostRequestの消滅)を見に行く間隔
const HOST_TIMEOUT_MS = 30000; // 応答が来ないときに待機を解除するまでの猶予
const DEFAULT_NOTE_LENGTH_ALPHA = 0.25;
// 自作リストとして読み込めるファイルの上限。正規化CSV(csvText)は編集データごと
// sessionStorage に載るので、入り口で断らないと保存できないところまで行ってしまう
// stations.csv のような同梱リストも自作リストとして読み直せる容量にする。
// 処理量はサーバー側と同じく10,000行の上限でも抑える。
const ORIGINAL_FILE_MAX = 10 * 1024 * 1024;

let data = null;
// 候補提示の基盤(初期化完了までnull)。mecabは自由入力の読み付与に使う
let app = null;
let mecab = null;
let db = null;
let appFor = null; // 「音の合わせ方」別のエンジンを取り直すためのファクトリ
let engineVowelRatio = null;
let dbWhere = undefined; // いまの db を作った where(ファセット絞り込み)
let dbWordlistKey = null; // いまの db を作った単語リスト(wordlistKey)
let paramControls = null; // 変換設定パネルのパラメータUI(生成画面と共有)
let facetsEnabled = false; // 単語リストに facets があるときだけ絞り込みを出す
let wordlistCatalog = null; // value → エントリ(conf/setting.json 由来。取得失敗時null)
let settingsUpdating = false;
let settingsRevision = 0;
let settingsReady = false;
let settingsDirty = false;
let regeneration = null;
let reverseMatches = [];
let reverseTimer = null;
let reverseRequest = null;
let setupMode = false; // セットアップ画面(第1ステップ)を表示中
let setupConverting = false; // セットアップ画面での変換中(多重実行を防ぐ)
let songRequest = null; // ホストに出した曲の依頼 {type, id, nonce}(応答待ち中だけ非null)
let songRequestTimer = null; // 応答ポーリングのタイマー
let songRequestDeadline = 0; // 応答待ちの期限(epoch ms)

// 選択中の範囲: {line, start, end}(endは排他)。単語チップ選択もperiodをこの形にする
let selection = null;
let anchorUnit = null; // Shiftクリック範囲選択の起点 {line, index}
let pendingUnit = null; // pointerdownしたユニット {line, index, x, y, slop}(タップ/ドラッグ未確定)
let dragging = false; // 移動量が閾値を超えたらドラッグ確定
let suppressClickUntil = 0; // ポインタ側で処理済みのタップのclickを二重処理しないための期限

let panelShown = GROUP_PAGE; // 表示中の候補グループ数(「もっと見る」で増える)
let openGroupKey = null; // 展開中の同名候補グループ(surface+kana)
let readingFixContext = null; // 読み修正ダイアログの下書き {line, span, draftAlign, alignMode}
let freeInputReturnClickUntil = 0;
let freeInputOpen = false; // 希少な自由入力は必要なときだけ開く
let freeInputDraft = { surface: "", reading: "" }; // 再描画しても未確定入力を保つ
let readingInputLayoutCleanup = null; // iOSキーボード表示中のパネル位置調整を解除
let reviewPreviousSelection = null;

function $id(id) {
	return document.getElementById(id);
}

function isIOSDevice() {
	return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function focusReadingInput(input, container = $id("editor-panel"), keepPositionUntilClose = false) {
	if (!input) return;
	readingInputLayoutCleanup?.();
	if (!isIOSDevice() || !window.visualViewport) {
		input.focus({ preventScroll: true });
		return;
	}
	// iOS Safariの固定パネルはキーボードに隠れるため、visual viewportの下端まで
	// containerを持ち上げる。dialogは入力以外を触ってもcloseまで位置追従を続ける。
	const viewport = window.visualViewport;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		viewport.removeEventListener("resize", syncPanelPosition);
		viewport.removeEventListener("scroll", syncPanelPosition);
		if (!keepPositionUntilClose) input.removeEventListener("blur", cleanup);
		container.style.removeProperty("bottom");
		if (readingInputLayoutCleanup === cleanup) readingInputLayoutCleanup = null;
	};
	const syncPanelPosition = () => {
		if (!keepPositionUntilClose && document.activeElement !== input) {
			cleanup();
			return;
		}
		const hiddenBottom = Math.max(
			0, window.innerHeight - viewport.height - viewport.offsetTop);
		container.style.bottom = `${hiddenBottom}px`;
	};
	viewport.addEventListener("resize", syncPanelPosition);
	viewport.addEventListener("scroll", syncPanelPosition);
	if (!keepPositionUntilClose) input.addEventListener("blur", cleanup);
	readingInputLayoutCleanup = cleanup;
	// preventScrollを付けず、Safari自身にもフォーカス欄を見える位置へ移動させる。
	input.focus();
	syncPanelPosition();
}

// videoのapp shell内に埋め込まれたときだけ、ブランドを親画面へ戻る導線にする。
// 単体のeditor.htmlではHTMLの href="./" を変更せず、従来どおり生成画面へ戻る。
function setupEmbedNavigation() {
	if (new URLSearchParams(window.location.search).get("embed") !== "video") return;
	// URLだけを直接開いた場合は親shellが通知を受け取れないため、通常導線を保つ。
	if (window.parent === window) return;

	const brand = $id("editor-brand");
	brand.removeAttribute("href");
	brand.textContent = "← 動画作成に戻る";
	brand.setAttribute("aria-label", "動画作成に戻る");
	brand.setAttribute("role", "button");
	brand.tabIndex = 0;

	const requestClose = () => {
		window.parent.postMessage({ type: "soramimic:request-close" }, window.location.origin);
	};
	brand.addEventListener("click", (event) => {
		event.preventDefault();
		requestClose();
	});
	brand.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		requestClose();
	});
}

let saveFailureNotified = false; // 保存不可の通知は1回だけ(操作のたびに出さない)

// 保存できたら true。容量超過(QuotaExceededError)は履歴を削って粘り、
// それでもダメなら「保存できていない」ことを分かる形で1度だけ知らせる:
// 黙って落とすと、編集し続けたあとでリロードして全部消える
function saveData() {
	try {
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(data));
		return true;
	} catch (err) {
		// 容量超過時は履歴を削って保存し直す(編集内容の保存を優先)
		console.warn("保存失敗、履歴を切り詰めます:", err);
		data.history = data.history.slice(-5);
		data.future = data.future.slice(-5);
		try {
			sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(data));
			return true;
		} catch (err2) {
			console.error(err2);
			if (!saveFailureNotified) {
				saveFailureNotified = true;
				alert("編集内容をブラウザに保存できませんでした(保存容量オーバー)。"
					+ "自作リストが大きすぎるかもしれません。リストを小さくするか、"
					+ "「書き出し」でファイルに保存してください。");
			}
			return false;
		}
	}
}

// ---- 履歴(戻る/進む) ----
// 読み修正はユニット列やトークン列も変えるため、結果と合わせてまとめて積む

function snapshotState() {
	return JSON.parse(JSON.stringify({
		results: data.results,
		tokensList: data.tokensList,
		unitsList: data.unitsList,
		// 設定変更も歌詞編集とは別の操作として取り消せる。
		// where は undefined(=エントリ既定)と区別するため null にして持つ
		param: data.param,
		wordlist: data.wordlist,
		wordlistSource: data.wordlistSource,
		where: data.where === undefined ? null : data.where,
		noteLengthAlpha: data.noteLengthAlpha,
	}));
}

function restoreState(s) {
	data.results = s.results;
	data.tokensList = s.tokensList;
	data.unitsList = s.unitsList;
	// 旧セッションの履歴には設定が入っていないので、あるときだけ戻す
	if (s.param) data.param = s.param;
	if (s.wordlist) data.wordlist = s.wordlist;
	data.wordlistSource = s.wordlistSource;
	if ("where" in s) data.where = s.where === null ? undefined : s.where;
	if ("noteLengthAlpha" in s) data.noteLengthAlpha = s.noteLengthAlpha;
}

// ホストは曲のノート長から作ったα=1の生重みを渡し、soramimicがUIのαを
// 適用する。既存のweightsListは任意の位置別重みとして後方互換で残す。
function noteLengthWeights() {
	if (!Array.isArray(data.noteLengthRawList)) return data.weightsList || null;
	const alpha = Number(data.noteLengthAlpha);
	if (!Number.isFinite(alpha) || alpha <= 0) return null;
	return data.noteLengthRawList.map((row) =>
		Array.isArray(row) ? row.map((raw) => Number(raw) ** alpha) : row);
}

function normalizeNoteLengthSetting() {
	if (!Array.isArray(data.noteLengthRawList)) {
		delete data.noteLengthRawList;
		delete data.noteLengthAlpha;
		return;
	}
	const alpha = Number(data.noteLengthAlpha);
	data.noteLengthAlpha = Number.isFinite(alpha) && alpha >= 0
		? Math.min(2, alpha) : DEFAULT_NOTE_LENGTH_ALPHA;
}

function applyNoteLengthSetting() {
	if (!Array.isArray(data.noteLengthRawList)) return;
	const input = $id("editor-note-length-alpha");
	const alpha = Number(input && input.value);
	data.noteLengthAlpha = Number.isFinite(alpha) && alpha >= 0
		? Math.min(2, alpha) : DEFAULT_NOTE_LENGTH_ALPHA;
}

// 編集操作(差し替え・固定切替・再生成・読み修正)の直前に呼び、現在の状態を積む
function pushHistory() {
	data.future = [];
	data.history.push(snapshotState());
	if (data.history.length > HISTORY_MAX) data.history.shift();
	updateHistoryButtons();
}

function undo() {
	if (data.history.length === 0) return;
	data.future.push(snapshotState());
	restoreState(data.history.pop());
	afterHistoryJump();
}

function redo() {
	if (data.future.length === 0) return;
	data.history.push(snapshotState());
	restoreState(data.future.pop());
	afterHistoryJump();
}

function afterHistoryJump() {
	// どの行が変わったか追跡しきれないため、全行を再計算対象に戻す
	data.dirtyLines = data.results.map((_, i) => i);
	saveData();
	setSelection(null);
	renderAll();
	updateHistoryButtons();
	// パラメータ・絞り込みも戻るので、パネル表示と候補計算の土台を合わせ直す
	syncSettingsUi();
	if (appFor) {
		setSettingsBusy(true);
		showSettingsStatus();
		syncEngine().then((applied) => {
			if (!applied) return;
			setSettingsBusy(false);
			renderPanel();
			scheduleReverseSearch();
		}).catch((err) => {
			db = null;
			setSettingsBusy(false);
			showSettingsStatus("単語リストを読み込めませんでした: " + err.message);
		});
	}
}

// 編集した行を記録する。「固定中以外を再生成」は編集の影響がありうる行だけを
// 計算し直す(それ以外の行は現在の単語を丸ごと固定してDPをスキップさせる)
function markDirty(line) {
	if (!data.dirtyLines.includes(line)) data.dirtyLines.push(line);
}

function updateHistoryButtons() {
	$id("btn-undo").disabled = settingsUpdating || data.history.length === 0;
	$id("btn-redo").disabled = settingsUpdating || data.future.length === 0;
}

// ---- 表示 ----

function unitsOf(line) {
	return data.unitsList[line] || [];
}

function rangeKana(line, start, end) {
	return unitsOf(line).slice(start, end).map((u) => u.pronunciation).join("");
}

function rangeSurface(line, start, end) {
	return unitsOf(line).slice(start, end).map((u) => u.surface_form).join("");
}

function makeLockIcon(locked = false) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.classList.add("chip-lock-icon");
	if (locked) svg.classList.add("is-locked");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	body.setAttribute("x", "3");
	body.setAttribute("y", "11");
	body.setAttribute("width", "18");
	body.setAttribute("height", "10");
	body.setAttribute("rx", "2");
	const open = document.createElementNS("http://www.w3.org/2000/svg", "path");
	open.classList.add("chip-lock-icon-open");
	open.setAttribute("d", "M7 11V7a5 5 0 0 1 9.8-1.4");
	const closed = document.createElementNS("http://www.w3.org/2000/svg", "path");
	closed.classList.add("chip-lock-icon-closed");
	closed.setAttribute("d", "M7 11V7a5 5 0 0 1 10 0v4");
	svg.append(body, open, closed);
	return svg;
}

function renderLine(line) {
	const matches = reverseMatches.filter((match) => match.line === line);
	const row = renderReviewLine(data, line, selection, onWordClick, makeLockIcon, (chip, word) => {
		chip.title = wordDetail(word);
		attachLongPress(chip, () => wordDetail(word));
		chip.classList.toggle("reverse-word-match", matches.some((match) =>
			word.period[0] < match.end && match.start < word.period[1]));
	});
	if (!unitsOf(line).length) return row;
	const original = row.querySelector(".review-original");
	const heading = document.createElement("div");
	heading.className = "review-line-heading";
	const regenerateButton = document.createElement("button");
	regenerateButton.type = "button";
	regenerateButton.className = "btn btn-ghost line-regenerate";
	regenerateButton.textContent = "↻";
	regenerateButton.title = "この行を再生成（固定中の単語は保持）";
	regenerateButton.setAttribute("aria-label", `${line + 1}行目を再生成（固定中の単語は保持）`);
	regenerateButton.disabled = !db || settingsUpdating || !!regeneration;
	regenerateButton.addEventListener("click", () => regenerate({ line }).catch(showRegenerationError));
	original.replaceWith(heading);
	heading.append(original, regenerateButton);
	if (matches.length) highlightOriginal(original, searchUnits(line), matches, data.tokensList[line]);
	return row;
}

function rerenderLine(line) {
	const old = document.querySelector(`.editor-line[data-line="${line}"]`);
	if (!old) return;
	old.replaceWith(renderLine(line));
}

function renderAll() {
	const container = $id("editor-lines");
	container.textContent = "";
	data.results.forEach((_, i) => container.appendChild(renderLine(i)));
	scheduleReverseSearch();
}

function syncLineActions() {
	for (const button of document.querySelectorAll(".line-regenerate")) {
		button.disabled = !db || settingsUpdating || !!regeneration;
	}
	$id("reverse-word").disabled = !app || settingsUpdating || !!regeneration;
	$id("reverse-clear").disabled = $id("reverse-word").disabled;
}

function setupReverseSearch() {
	$id("reverse-word").addEventListener("input", (event) => scheduleReverseSearch(event.isComposing));
	$id("reverse-word").addEventListener("compositionend", () => scheduleReverseSearch());
	$id("reverse-clear").addEventListener("click", () => {
		$id("reverse-word").value = "";
		scheduleReverseSearch();
		$id("reverse-word").focus();
	});
	$id("reverse-search").addEventListener("toggle", () => scheduleReverseSearch());
}

function searchUnits(line) {
	const row = unitsOf(line);
	const derived = app.textAnalyzer.getYomiAndPhraseBreak(data.tokensList[line]);
	const aligned = derived.length === row.length
		&& derived.every((unit, i) => unit.pronunciation === row[i].pronunciation);
	return row.map((unit, i) => ({ ...unit,
		char_index: aligned ? derived[i].char_index : undefined,
		token_index: aligned ? derived[i].token_index : undefined,
	}));
}

function scheduleReverseSearch(composing = false) {
	$id("reverse-clear").hidden = !$id("reverse-word").value;
	clearTimeout(reverseTimer);
	reverseRequest?.abort();
	reverseRequest = null;
	const previous = new Set(reverseMatches.map((match) => match.line));
	reverseMatches = [];
	for (const line of previous) rerenderLine(line);
	const status = $id("reverse-status");
	status.textContent = "";
	if (!$id("reverse-search").open || !$id("reverse-word").value.trim() || !app || settingsUpdating || composing) return;
	status.textContent = "当てはめ先を検索中…";
	reverseTimer = setTimeout(async () => {
		const request = new AbortController();
		reverseRequest = request;
		try {
			const reading = $id("reverse-word").value.trim().normalize("NFKC");
			if (!/^[ぁ-ゖァ-ヶー\s]+$/.test(reading)) {
				throw new Error("ひらがな・カタカナで入力してください");
			}
			const kana = app.textAnalyzer.formatKana(reading);
			const units = data.unitsList.map((_, line) => searchUnits(line));
			const matches = await findPlacements(app, kana, units, data.param,
				noteLengthWeights(), request.signal);
			if (request.signal.aborted) return;
			reverseMatches = matches;
			for (const line of new Set(matches.map((match) => match.line))) rerenderLine(line);
			status.textContent = matches.length ? "" : "当てはめられる範囲がありません";
		} catch (error) {
			if (!request.signal.aborted) status.textContent = error.message;
		}
	}, 250);
}

function toggleLock(line, word) {
	pushHistory();
	markDirty(line);
	word.locked = !word.locked;
	saveData();
	rerenderLine(line);
	renderPanel(); // パネルの固定ボタン表示も追従させる
}

// ---- 選択 ----

function setSelection(next) {
	panelShown = GROUP_PAGE;
	openGroupKey = null;
	freeInputOpen = false;
	freeInputDraft = { surface: "", reading: "" };
	const prev = selection;
	selection = next;
	if (prev) rerenderLine(prev.line);
	if (next && (!prev || prev.line !== next.line)) rerenderLine(next.line);
	// ドラッグ中は範囲ボタンの位置を保ち、候補は指を離してから更新する。
	if (!pendingUnit) renderPanel();
}

function onWordClick(line, word) {
	anchorUnit = { line, index: word.period[0] };
	setSelection({ line, start: word.period[0], end: word.period[1] });
}

// タップの挙動: 選択の端 → その1ユニットを外す / 選択に隣接 → 1ユニット伸ばす /
// 1ユニット選択中にそれ自身 → 選択解除 / それ以外 → そこで新規1ユニット選択
function unitTapAction(line, index) {
	const sel = selection;
	if (sel && sel.line === line) {
		const len = sel.end - sel.start;
		if (index === sel.start && len === 1) {
			setSelection(null);
			return;
		}
		if (index === sel.start) {
			setSelection({ line, start: sel.start + 1, end: sel.end });
			return;
		}
		if (index === sel.end - 1) {
			setSelection({ line, start: sel.start, end: sel.end - 1 });
			return;
		}
		if (index === sel.start - 1) {
			setSelection({ line, start: index, end: sel.end });
			return;
		}
		if (index === sel.end) {
			setSelection({ line, start: sel.start, end: sel.end + 1 });
			return;
		}
	}
	anchorUnit = { line, index };
	setSelection({ line, start: index, end: index + 1 });
}

// clickはShiftクリック(PCの範囲指定)専用。通常のタップはpointerup側で処理済み
// (タッチではpointerdownをpreventDefaultするとclickが飛ばない環境があるため)
function onUnitClick(line, index, shift, keyboard = false) {
	if (!keyboard && performance.now() < suppressClickUntil) return;
	if (shift && anchorUnit && anchorUnit.line === line) {
		const [s, e] = [Math.min(anchorUnit.index, index), Math.max(anchorUnit.index, index)];
		setSelection({ line, start: s, end: e + 1 });
		return;
	}
	unitTapAction(line, index);
}

// ---- タップ/ドラッグ判定と範囲選択 ----
// pointerdownから移動量が閾値を超えたらドラッグ確定して範囲を引き直す。
// 閾値内で指を離せばタップ(unitTapAction)。指の揺れで誤ドラッグにならないよう
// 閾値はタッチを広めにする

function onUnitPointerDown(line, index, e) {
	suppressClickUntil = 0; // 新しい操作は直前のpointerupに伴うclickではない。
	if (e.shiftKey) return; // Shiftクリックの範囲指定はclickハンドラに任せる
	if (e.pointerType === "mouse" && e.button !== 0) return;
	e.preventDefault(); // ドラッグ中のテキスト選択を防ぐ
	pendingUnit = {
		line, index,
		x: e.clientX, y: e.clientY,
		slop: e.pointerType === "touch" ? 10 : 4,
	};
	dragging = false;
	document.addEventListener("pointermove", onDragMove);
	document.addEventListener("pointerup", onDragEnd);
	document.addEventListener("pointercancel", onDragEnd);
}

function onDragMove(e) {
	if (!pendingUnit) return;
	if (!dragging) {
		const dx = e.clientX - pendingUnit.x;
		const dy = e.clientY - pendingUnit.y;
		if (dx * dx + dy * dy < pendingUnit.slop * pendingUnit.slop) return;
		dragging = true;
		anchorUnit = { line: pendingUnit.line, index: pendingUnit.index };
	}
	// 折り返した範囲ボタンも、ポインタの位置から選択する。
	const el = document.elementFromPoint(e.clientX, e.clientY);
	const chip = el && el.closest(".review-unit");
	if (!chip) return;
	const lineEl = chip.closest(".review-range");
	if (!lineEl || Number(lineEl.dataset.line) !== pendingUnit.line) return;
	const index = Number(chip.dataset.index);
	const start = Math.min(pendingUnit.index, index);
	const end = Math.max(pendingUnit.index, index) + 1;
	if (selection && selection.line === pendingUnit.line &&
		selection.start === start && selection.end === end) return;
	setSelection({ line: pendingUnit.line, start, end });
	for (const unit of lineEl.querySelectorAll(".review-unit")) {
		const selected = Number(unit.dataset.index) >= start && Number(unit.dataset.index) < end;
		unit.setAttribute("aria-pressed", String(selected));
	}
}

function onDragEnd(e) {
	const wasDragging = dragging;
	const pending = pendingUnit;
	pendingUnit = null;
	dragging = false;
	document.removeEventListener("pointermove", onDragMove);
	document.removeEventListener("pointerup", onDragEnd);
	document.removeEventListener("pointercancel", onDragEnd);
	// この操作から生じるclickをタップとして二重処理しないようにする
	suppressClickUntil = performance.now() + 400;
	if (wasDragging) {
		renderPanel(); // ドラッグ完了後に候補を更新する
	} else if (pending && e.type === "pointerup") {
		unitTapAction(pending.line, pending.index); // タップはここで確定する
	}
}

// ---- 差し替え ----

// 選択範囲を候補単語(または自由入力単語)で差し替える。
// 範囲に重なる既存単語は取り除き、periodと元歌詞情報を付けて挿入する。
// 手で選んだ単語は再生成で消えないよう自動で固定する(🔓で解除可能)
function replaceSelection(word) {
	if (!selection) return;
	const { line, start, end } = selection;
	const conflicts = [];
	data.results.forEach((words, otherLine) => {
		for (const other of words || []) {
			if (data.param.DUPLICATE || other.filler || !other.locked || other.id !== word.id
				|| (other.wordlistSource || data.wordlistSource) !== (word.wordlistSource || data.wordlistSource)) continue;
			if (otherLine === line && other.period[0] < end && start < other.period[1]) continue;
			conflicts.push({ line: otherLine, word: other });
		}
	});
	if (conflicts.length) {
		confirmAssignment(word, conflicts);
		return;
	}
	applyReplacement(word);
}

function confirmAssignment(word, conflicts) {
	const selected = selection;
	const results = data.results;
	const dialog = $id("editor-assignment-dialog");
	$id("assignment-conflict-description").textContent =
		`「${word.surface}」は次の箇所で固定されています。ここを優先すると、元の箇所の割り当てを解除します。`;
	const locations = $id("assignment-conflict-locations");
	locations.replaceChildren();
	for (const conflict of conflicts) {
		const item = document.createElement("li");
		item.textContent = `${conflict.line + 1}行目「${rangeSurface(conflict.line, ...conflict.word.period)}」`;
		const context = document.createElement("span");
		context.className = "assignment-conflict-context";
		context.textContent = data.originalLines?.[conflict.line] || data.phrases?.[conflict.line] || "";
		item.append(context);
		locations.append(item);
	}
	$id("btn-assignment-keep").onclick = () => dialog.close();
	$id("btn-assignment-move").onclick = () => {
		dialog.close();
		if (selection !== selected || data.results !== results) return;
		applyReplacement(word, conflicts);
	};
	dialog.showModal();
}

function clearSelectionAssignment() {
	if (!selection) return;
	const { line, start, end } = selection;
	const words = data.results[line] || [];
	if (!words.some((word) => !word.filler && word.period[0] < end && start < word.period[1])) return;
	pushHistory();
	markDirty(line);
	data.results[line] = words.filter((word) => word.period[1] <= start || end <= word.period[0]);
	saveData();
	rerenderLine(line);
	renderPanel();
}

function applyReplacement(word, conflicts = []) {
	pushHistory();
	const { line, start, end } = selection;
	markDirty(line);
	for (const conflict of conflicts) {
		data.results[conflict.line] = data.results[conflict.line].filter((other) => other !== conflict.word);
		markDirty(conflict.line);
	}
	const placed = Object.assign({}, word, {
		wordlistSource: word.wordlistSource || data.wordlistSource,
		period: [start, end],
		originalkana: rangeKana(line, start, end),
		original_surface: rangeSurface(line, start, end),
		locked: true,
	});
	const words = (data.results[line] || []).filter(
		(w) => w.period[1] <= start || end <= w.period[0]);
	words.push(placed);
	words.sort((a, b) => a.period[0] - b.period[0]);
	data.results[line] = words;
	saveData();
	setSelection(freeInputOpen ? selection : null);
	for (const otherLine of new Set(conflicts.map((conflict) => conflict.line))) {
		if (otherLine !== line) rerenderLine(otherLine);
	}
}

// 自由入力の読みを、通常の単語DBと同じ経路で選択範囲へ合わせる。
// id/surface/original は維持し、video が使う kana と pronunciation を必ず同期する。
function wordWithReading(word, rawReading, target, weights) {
	const kana = app.textAnalyzer.formatKana(rawReading.trim());
	if (kana === "" || kana.length > 100 || !/^[ァ-ヴー]+$/.test(kana)) return null;
	if (kana === word.kana && Array.isArray(word.pronunciation)) {
		return Object.assign({}, word);
	}
	// 選択元の発音変種が取りうる最大ユニット数より長い読みは一致しない。
	// 上限なしの直積は「ン」「ッ」の連続で指数的に増えるため、生成前に枝数も抑える。
	const maxTargetUnits = target.reduce((sum, syllable) => {
		const variants = app.textAnalyzer.syllableToVariation([syllable]);
		return sum + Math.max(0, ...variants.map((v) => v.length));
	}, 0);
	const syllables = app.textAnalyzer.yomiToSyllable(kana);
	if (!Array.isArray(syllables) || maxTargetUnits === 0) return null;
	let variationCount = 1;
	for (const syllable of syllables) {
		// 単独の削除変種は空配列として除外されるので、固定音節を番兵にして枝数を数える。
		variationCount *= app.textAnalyzer.syllableToVariation(
			[syllable, "ア"], maxTargetUnits + 1).length;
		if (variationCount > 16384) return null;
	}
	const variants = app.textAnalyzer.yomiToVariation(kana, maxTargetUnits);
	const oneWordDb = {};
	for (const pronunciation of variants) {
		if (!Array.isArray(pronunciation) || pronunciation.length === 0) continue;
		if (!(pronunciation.length in oneWordDb)) oneWordDb[pronunciation.length] = [];
		oneWordDb[pronunciation.length].push(Object.assign({}, word, {
			kana,
			pronunciation,
			vcost: pronunciation.vcost || 0,
		}));
	}
	return app.soramimiMaker.getCandidates(oneWordDb, target, data.param, 1, weights)[0] || null;
}

function isCustomWord(word) {
	return String(word?.id).startsWith("custom-");
}

// 自由入力から候補相当のオブジェクトを作る。読み欄が空なら従来どおり推定する。
function makeCustomWord(text, rawReading, target, weights) {
	const reading = rawReading.trim() || mecab.getYomi(text) || text;
	const base = {
		id: "custom-" + Date.now(),
		surface: text,
		kana: "",
		original: text,
		sim: 0,
	};
	return wordWithReading(base, reading, target, weights);
}

// ---- 候補の詳細(長押しポップオーバー / PCはホバーのツールチップ) ----

let popover = null;
let longPressTimer = null;
let longPressed = false;

function hidePopover() {
	if (popover) {
		popover.remove();
		popover = null;
	}
}

function showPopover(target, text) {
	hidePopover();
	popover = document.createElement("div");
	popover.className = "editor-popover";
	popover.textContent = text;
	document.body.appendChild(popover);
	const r = target.getBoundingClientRect();
	const left = Math.max(4, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8));
	let top = r.top - popover.offsetHeight - 6;
	if (top < 4) top = r.bottom + 6;
	popover.style.left = left + "px";
	popover.style.top = top + "px";
}

document.addEventListener("pointerdown", (e) => {
	if (popover && !popover.contains(e.target)) hidePopover();
});

// ボタンに長押しで詳細ポップオーバーを付ける。長押し後のclick(差し替え等)は握りつぶす
function attachLongPress(btn, getText) {
	btn.addEventListener("pointerdown", () => {
		longPressed = false;
		clearTimeout(longPressTimer);
		longPressTimer = setTimeout(() => {
			longPressed = true;
			showPopover(btn, getText());
		}, LONG_PRESS_MS);
	});
	for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
		btn.addEventListener(ev, () => clearTimeout(longPressTimer));
	}
	btn.addEventListener("contextmenu", (e) => e.preventDefault());
	btn.addEventListener("click", (e) => {
		if (longPressed) {
			longPressed = false;
			e.stopImmediatePropagation();
			e.preventDefault();
		}
	}, true);
}

function candidateDetail(cand, isUsed) {
	const lines = [];
	if (cand.original && cand.original !== cand.surface) lines.push(cand.original);
	lines.push("読み: " + cand.kana);
	if (typeof cand.sim === "number") {
		lines.push("スコア: " + cand.sim.toFixed(3) + "(小さいほど近い)");
	}
	lines.push(isUsed ? "この歌詞内で使用中" : "未使用");
	return lines.join("\n");
}

// 配置済みの替え歌単語の詳細。表記が同じでもidが違う単語を見分けられるよう、
// 元表記→替え歌の対応に加えて、フルネーム(original)・読み・スコア・idを出す
function wordDetail(word) {
	const lines = [];
	// filler は「置ける単語が無かったので元歌詞のまま」の区間。スコアやIDは持たない
	if (word.filler) {
		return [
			`${word.original_surface}(${word.originalkana})→ 未変換(元の歌詞のまま)`,
			"この区間に置ける単語がありませんでした",
			"タップすると候補から選べます",
		].join("\n");
	}
	lines.push(`${word.original_surface}(${word.originalkana})→ ${word.surface}`);
	if (word.original && word.original !== word.surface) lines.push("単語: " + word.original);
	lines.push("読み: " + word.kana);
	const sim = typeof word.sim === "number" ? word.sim : word.score;
	if (typeof sim === "number" && Number.isFinite(sim)) {
		lines.push("スコア: " + sim.toFixed(3) + "(小さいほど近い)");
	}
	lines.push(isCustomWord(word) ? "自由入力" : "ID: " + word.id);
	return lines.join("\n");
}

// ---- 元歌詞の読み修正 ----
// 「故郷」がコキョーと推定された等の読み間違いを、選択範囲から直せるようにする。
// 読みはトークン単位でしか変えられないため、選択をトークン境界にスナップする

function hiraToKata(text) {
	return text.replace(/[ぁ-ゖ]/g,
		(ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// 選択範囲に重なるトークンの並びを求める。
// 戻り値: {arrStart, arrEnd}=tokensListの添字範囲、{unitStart, unitEnd}=ユニット添字範囲、
// surface=対象の表記、yomi=現在の読み。対応が取れないときはnull
function tokenSpanForSelection(line, start, end) {
	if (!app) return null;
	const tokens = data.tokensList[line];
	if (!tokens || tokens.length === 0) return null;
	const units = app.textAnalyzer.getYomiAndPhraseBreak(tokens);
	if (units.length !== unitsOf(line).length) return null;
	if (units.slice(start, end).some((u) => u.token_index == null)) return null;
	const indexes = units.slice(start, end).map((u) => u.token_index);
	const tiMin = Math.min(...indexes);
	const tiMax = Math.max(...indexes);
	// トークン境界までユニット範囲を広げる
	let unitStart = start;
	let unitEnd = end;
	units.forEach((u, i) => {
		if (u.token_index >= tiMin && u.token_index <= tiMax) {
			unitStart = Math.min(unitStart, i);
			unitEnd = Math.max(unitEnd, i + 1);
		}
	});
	const arrStart = tokens.findIndex((t) => t.token_index === tiMin);
	const arrEndIdx = tokens.findIndex((t) => t.token_index === tiMax);
	if (arrStart < 0 || arrEndIdx < 0) return null;
	const arrEnd = arrEndIdx + 1;
	return {
		arrStart, arrEnd, unitStart, unitEnd,
		surface: tokens.slice(arrStart, arrEnd).map((t) => t.surface_form).join(""),
		yomi: units.slice(unitStart, unitEnd).map((u) => u.pronunciation).join(""),
	};
}

// 読みと文字ごとの対応を正データへ触れずに導出する。ダイアログ内のプレビューと
// 確定で同じ経路を使い、キャンセル時に履歴や候補を変えない。
function deriveReadingFix(
	line, span, newYomiRaw, alignMode = "untouched", draftAlign = null, preview = false) {
	// 手入力の読みも「ウッセェ」のような小書きカナを吸収してから使う
	// (単独の小書きは単語リスト側に存在せず、候補0件の行になってしまうため)
	const kata = absorbSmallKana(hiraToKata(newYomiRaw.trim()));
	if (kata === "" || !/^[ァ-ヴー]+$/.test(kata)) return null;
	const tokens = data.tokensList[line].map((t) => Object.assign({}, t));
	const multipleTokens = span.arrEnd - span.arrStart !== 1;
	const readingChanged = kata !== span.yomi;
	// プレビューでは複数tokenを仮に束ね、範囲全体の文字対応を描画する。
	// 確定時は読みまたは対応が変わる時だけ束ね、無変更の適用では元tokenを保つ。
	const mergeTokens = multipleTokens &&
		(preview || readingChanged || alignMode !== "untouched");
	if (!multipleTokens) {
		tokens[span.arrStart].pronunciation = kata;
		if (readingChanged) delete tokens[span.arrStart].manualAlign;
	} else if (mergeTokens) {
		// 複数トークンにまたがる場合は1トークンに束ねて読みを付け直す
		const merged = Object.assign({}, tokens[span.arrStart], {
			surface_form: tokens.slice(span.arrStart, span.arrEnd)
				.map((t) => t.surface_form).join(""),
			pronunciation: kata,
		});
		delete merged.manualAlign; // 束ね直したので旧割当は破棄
		tokens.splice(span.arrStart, span.arrEnd - span.arrStart, merged);
	}
	// 複数トークンも直前で1つに束ね済みなので、同じarrStartへ対応を保存できる。
	if (alignMode === "set") {
		tokens[span.arrStart].manualAlign = draftAlign.map((pair) => pair.slice());
	} else if (alignMode === "reset") {
		delete tokens[span.arrStart].manualAlign;
	}
	// 編集後のトークンからユニット列を導出し直す(tokensListを唯一の正とし、
	// 生成時と同じ関数で導出するので表示と再生成が一致する)。
	let derived;
	try {
		derived = app.textAnalyzer.getYomiAndPhraseBreak(tokens);
	} catch (e) {
		console.error("applyReadingFix: 読みの導出に失敗したため変更を中止しました", e);
		return null;
	}
	const newUnits = derived.map((u) => ({
		surface_form: u.surface_form,
		pronunciation: u.pronunciation,
		phrase: u.phrase,
	}));
	const oldUnits = data.unitsList[line];
	const unitsAfter = oldUnits.length - span.unitEnd;
	const newSpanEnd = newUnits.length - unitsAfter;
	// 有効な読みを入力したのに対象範囲のユニットが消えるのは導出失敗。
	// 空の選択と候補ゼロ件を正データへ保存せず、入力フォームに留める。
	if (newSpanEnd <= span.unitStart) return null;
	return {
		tokens, newUnits, newSpanEnd, readingChanged,
		changed: readingChanged || alignMode !== "untouched",
	};
}

// 読みと文字ごとの対応を一度に確定する。読みが変わった時だけ、重なっていた
// 替え歌候補を外して後続periodをずらす。対応だけの変更では候補を維持する。
function applyReadingFix(line, span, newYomiRaw, alignMode = "untouched", draftAlign = null) {
	const draft = deriveReadingFix(line, span, newYomiRaw, alignMode, draftAlign);
	if (!draft) return false;
	const { tokens, newUnits, newSpanEnd, readingChanged, changed } = draft;
	if (!changed) return true;
	// ここから確定: 履歴を積んでから正データ(tokensList)を差し替える
	pushHistory();
	markDirty(line);
	data.tokensList[line] = tokens;
	const delta = newSpanEnd - span.unitEnd;
	data.unitsList[line] = newUnits;
	scheduleReverseSearch();
	if (readingChanged) {
		data.results[line] = (data.results[line] || [])
			.filter((w) => w.period[1] <= span.unitStart || w.period[0] >= span.unitEnd)
			.map((w) => w.period[0] >= span.unitEnd
				? Object.assign({}, w, { period: [w.period[0] + delta, w.period[1] + delta] })
				: w);
	}
	saveData();
	return true;
}

// 読み修正は候補選択と別の作業として扱う。小窓を開いている間は背後の
// selection・候補・未確定ドラフトを一切変更しない。
function refreshReadingFixAlign(resetForReading = false) {
	const details = $id("reading-fix-align-details");
	const container = $id("reading-fix-align");
	container.textContent = "";
	if (!readingFixContext) {
		details.hidden = true;
		return;
	}
	if (resetForReading) {
		readingFixContext.alignMode = "untouched";
		readingFixContext.draftAlign = null;
	}
	const { line, span, alignMode, draftAlign } = readingFixContext;
	const draft = deriveReadingFix(
		line, span, $id("reading-fix-input").value, alignMode, draftAlign, true);
	const model = draft ? alignModel(line, span.arrStart, draft.tokens) : null;
	if (!model) {
		details.hidden = true;
		return;
	}
	details.hidden = false;
	container.appendChild(buildAlignEditor(model, (align) => {
		readingFixContext.alignMode = align ? "set" : "reset";
		readingFixContext.draftAlign = align;
		refreshReadingFixAlign();
	}));
}

function openReadingFixDialog(line, start, end, span) {
	const dialog = $id("editor-reading-dialog");
	readingFixContext = { line, span, alignMode: "untouched", draftAlign: null };
	const target = $id("reading-fix-target");
	const selected = document.createElement("mark");
	selected.className = "reading-fix-selection";
	selected.textContent = rangeSurface(line, start, end);
	target.textContent = "";
	target.append(
		document.createTextNode(rangeSurface(line, span.unitStart, start)),
		selected,
		document.createTextNode(rangeSurface(line, end, span.unitEnd)));
	target.setAttribute("aria-label", span.surface);
	$id("reading-fix-input").value = span.yomi;
	$id("reading-fix-error").textContent = "";
	$id("reading-fix-align-details").open = false;
	refreshReadingFixAlign();
	dialog.showModal();
	focusReadingInput($id("reading-fix-input"), dialog, true);
}

function closeReadingFixDialog() {
	$id("editor-reading-dialog").close();
}

function applyReadingFixFromDialog() {
	if (!readingFixContext) return;
	const { line, span, alignMode, draftAlign } = readingFixContext;
	if (!applyReadingFix(
		line, span, $id("reading-fix-input").value, alignMode, draftAlign)) {
		$id("reading-fix-error").textContent = "かなで入力してください";
		return;
	}
	// 読みの長さでユニット境界が変わり得るため、古い候補範囲は引き継がない。
	closeReadingFixDialog();
	setSelection(null);
}

function setupReadingFixDialog() {
	const dialog = $id("editor-reading-dialog");
	const input = $id("reading-fix-input");
	const close = () => closeReadingFixDialog();
	$id("btn-reading-fix-close").addEventListener("click", close);
	$id("btn-reading-fix-cancel").addEventListener("click", close);
	$id("btn-reading-fix-apply").addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		applyReadingFixFromDialog();
	});
	input.addEventListener("keydown", (e) => {
		// IMEの変換確定に使ったEnterでは読みを更新しない。
		if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
			// close()でフォーカスが鉛筆へ戻った後、同じEnterの既定動作が鉛筆を
			// 再クリックして小窓を開き直さないよう、この場で消費する。
			e.preventDefault();
			applyReadingFixFromDialog();
		}
	});
	input.addEventListener("input", (e) => {
		if (!e.isComposing) refreshReadingFixAlign(true);
	});
	input.addEventListener("compositionend", () => refreshReadingFixAlign(true));
	dialog.addEventListener("close", () => {
		readingInputLayoutCleanup?.();
		readingFixContext = null;
		$id("reading-fix-error").textContent = "";
		$id("reading-fix-align").textContent = "";
		$id("reading-fix-align-details").hidden = true;
	});
	// バックドロップのクリックはキャンセル扱い。ダイアログ内の余白では閉じない。
	dialog.addEventListener("click", (e) => {
		if (e.target !== dialog) return;
		const r = dialog.getBoundingClientRect();
		const outside = e.clientX < r.left || e.clientX > r.right
			|| e.clientY < r.top || e.clientY > r.bottom;
		if (outside) closeReadingFixDialog();
	});
}

// ---- 候補パネル ----

// 歌詞全体で使用中の単語id集合。差し替え対象(選択範囲に重なる単語)は除く
function usedIdSet(excludeLine, start, end) {
	const used = new Set();
	data.results.forEach((words, li) => {
		for (const w of words || []) {
			if (w.filler || !isCurrentWord(w, data.wordlistSource)) continue;
			if (li === excludeLine && !(w.period[1] <= start || end <= w.period[0])) continue;
			used.add(w.id);
		}
	});
	return used;
}

function renderPanel() {
	const focusedUnit = document.activeElement?.closest(".review-unit")?.dataset.index;
	const focusedLock = document.activeElement?.matches(".panel-lock");
	buildPanel();
	{
		const panel = $id("editor-panel");
		document.documentElement.classList.toggle("review-selecting", !!selection);
		if (selection && !panel.open) panel.showModal();
		else if (!selection && panel.open) panel.close();
		if (selection) {
			const target = focusedUnit !== undefined
				? panel.querySelector(`.review-unit[data-index="${focusedUnit}"]`)
				: panel.querySelector(focusedLock ? ".panel-lock" : ".panel-close");
			target?.focus({ preventScroll: true });
		} else if (reviewPreviousSelection) {
			const { line, start } = reviewPreviousSelection;
			const row = document.querySelector(`.review-line[data-line="${line}"]`);
			(row?.querySelector(`.review-word[data-start="${start}"]`) || row?.querySelector(".review-word"))
				?.focus({ preventScroll: true });
		}
		reviewPreviousSelection = selection;
		if (isVideoReview(data) && window.parent !== window) window.parent.postMessage({
			type: "soramimic:review-selection", open: !!selection,
		}, window.location.origin);
	}
}

// ---- 表層↔モーラの手動割当 ----

// 手動割当[[表層,読み],...]から、各表層文字が持つモーラ数(counts)を復元する。
// atoms はトークンのモーラ列。整合しなければ null。
function countsFromAlign(align, atoms) {
	if (!Array.isArray(align)) return null;
	const counts = [];
	let ai = 0;
	for (const pair of align) {
		if (!Array.isArray(pair)) return null;
		let acc = "";
		let c = 0;
		while (ai < atoms.length && acc.length < pair[1].length) {
			acc += atoms[ai].pronunciation;
			ai += 1;
			c += 1;
		}
		if (acc !== pair[1]) return null;
		counts.push(c);
	}
	return ai === atoms.length ? counts : null;
}

// n 個のモーラを k 個の表層文字へ均等に割る(余りは先頭から)。balancedAllocate と同傾向。
function evenCounts(n, k) {
	const base = Math.floor(n / k);
	const rem = n % k;
	return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

// 現在のユニット(atoms)の表層所有(surface_form 非空=所有, 空=直前と同じ文字)から、
// 各表層文字が持つモーラ数を復元する。各所有が単一文字で scChars と一致する時のみ。
function countsFromAtoms(scChars, atoms) {
	const groups = [];
	for (const a of atoms) {
		if (a.surface_form && a.surface_form.length > 0) {
			groups.push({ surface: a.surface_form, count: 1 });
		} else if (groups.length > 0) {
			groups[groups.length - 1].count += 1;
		} else {
			return null;
		}
	}
	if (groups.length === scChars.length && groups.every((g, i) => g.surface === scChars[i])) {
		return groups.map((g) => g.count);
	}
	return null;
}

// 割当エディタの対象かを判定し、対象なら描画に要る材料を返す。
// 対象外(かな語・表層1文字・モーラ数不足)なら null。renderPanel から呼ばれるため、
// 導出が投げてもパネル全体を巻き込まないよう握りつぶして「対象外」に倒す。
function alignModel(line, arrIndex, tokens = data.tokensList[line]) {
	const tok = tokens[arrIndex];
	const scChars = [...(tok.surface_form || "")];
	if (scChars.length < 2) return null;
	if (!/[㐀-鿿々]/.test(tok.surface_form || "")) return null; // 漢字を含む語のみ
	let fresh;
	try {
		fresh = app.textAnalyzer.getYomiAndPhraseBreak(tokens);
	} catch (e) {
		console.error("alignModel: 読みの導出に失敗したため割当エディタを出しません", e);
		return null;
	}
	const atoms = fresh.filter((u) => u.token_index === tok.token_index);
	if (atoms.length < scChars.length) return null; // 各文字に最低1モーラ割けない

	// 初期値: 手動割当 → 現在の自動割当 → 均等割 の順で復元し、実表示と一致させる
	let counts = countsFromAlign(tok.manualAlign, atoms);
	if (!counts || counts.length !== scChars.length) {
		counts = countsFromAtoms(scChars, atoms);
	}
	if (!counts || counts.length !== scChars.length) {
		counts = evenCounts(atoms.length, scChars.length);
	}
	return { tok, scChars, atoms, counts };
}

// 表層文字ごとの割当を◀▶で調整するパネル本体。model は alignModel の結果。
function buildAlignEditor(model, onChange) {
	const { tok, scChars, atoms, counts } = model;

	const buildAlign = (cs) => {
		let ai = 0;
		return scChars.map((ch, i) => {
			const yomi = atoms.slice(ai, ai + cs[i]).map((a) => a.pronunciation).join("");
			ai += cs[i];
			return [ch, yomi];
		});
	};
	const moveBoundary = (b, dir) => {
		// b と b+1 の境界: dir=-1 は左の文字へ1モーラ寄せる、+1 は右へ
		const cs = counts.slice();
		if (dir === -1 && cs[b + 1] > 1) { cs[b] += 1; cs[b + 1] -= 1; }
		else if (dir === 1 && cs[b] > 1) { cs[b] -= 1; cs[b + 1] += 1; }
		else return;
		onChange(buildAlign(cs));
	};

	const box = document.createElement("div");
	box.className = "panel-align";
	const label = document.createElement("span");
	label.className = "panel-align-label";
	label.textContent = "表層の割り当て:";
	box.appendChild(label);

	const row = document.createElement("div");
	row.className = "panel-align-row";
	let ai = 0;
	scChars.forEach((ch, i) => {
		if (i > 0) {
			const ctrl = document.createElement("span");
			ctrl.className = "align-boundary";
			const left = document.createElement("button");
			left.className = "btn align-arrow";
			left.type = "button";
			left.textContent = "◀";
			left.title = "左の文字へ1モーラ寄せる";
			left.setAttribute("aria-label", `${scChars[i - 1]}へ読みを1つ移す`);
			left.addEventListener("click", () => moveBoundary(i - 1, -1));
			const right = document.createElement("button");
			right.className = "btn align-arrow";
			right.type = "button";
			right.textContent = "▶";
			right.title = "右の文字へ1モーラ寄せる";
			right.setAttribute("aria-label", `${scChars[i]}へ読みを1つ移す`);
			right.addEventListener("click", () => moveBoundary(i - 1, 1));
			ctrl.append(left, right);
			row.appendChild(ctrl);
		}
		const cell = document.createElement("span");
		cell.className = "align-cell";
		const yomi = atoms.slice(ai, ai + counts[i]).map((a) => a.pronunciation).join("");
		ai += counts[i];
		cell.innerHTML =
			`<span class="align-surface"></span><span class="align-yomi"></span>`;
		cell.querySelector(".align-surface").textContent = ch;
		cell.querySelector(".align-yomi").textContent = yomi;
		row.appendChild(cell);
	});
	box.appendChild(row);

	// 自動割当へ戻す(手動割当がある時だけ)
	if (tok.manualAlign) {
		const reset = document.createElement("button");
		reset.className = "btn align-reset";
		reset.type = "button";
		reset.textContent = "自動に戻す";
		reset.addEventListener("click", () => onChange(null));
		box.appendChild(reset);
	}
	return box;
}

function setupReplacementPanel() {
	const panel = $id("editor-panel");
	// 戻るタップのpointerupで画面を切り替えると、遅れたclickが候補に届く。
	// 次の新しいタップはすぐ操作できるようpointerdownで抑止を解除する。
	panel.addEventListener("pointerdown", () => { freeInputReturnClickUntil = 0; }, true);
	panel.addEventListener("click", (event) => {
		if (event.detail === 0 || performance.now() >= freeInputReturnClickUntil) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}, true);
}

function closeFreeInput() {
	if (!freeInputOpen) return;
	freeInputOpen = false;
	freeInputDraft = { surface: "", reading: "" };
	renderPanel();
}

function appendReplacementControls(panel, target, rangeWeights) {
	if (freeInputOpen) {
		const free = document.createElement("div");
		free.className = "panel-free";
		const heading = document.createElement("h3");
		heading.className = "panel-free-title";
		heading.textContent = "歌詞を入力";
		const fields = document.createElement("div");
		fields.className = "panel-free-fields";
		const surfaceLabel = document.createElement("label");
		surfaceLabel.className = "panel-replacement-field";
		const surfaceInput = document.createElement("input");
		surfaceInput.className = "input panel-free-surface";
		surfaceInput.setAttribute("aria-label", "替え歌歌詞");
		surfaceInput.value = freeInputDraft.surface;
		surfaceLabel.appendChild(surfaceInput);
		const readingLabel = document.createElement("label");
		readingLabel.className = "panel-replacement-field";
		readingLabel.innerHTML = '<span>替え歌の読み</span>';
		const readingInput = document.createElement("input");
		readingInput.className = "input panel-free-reading";
		readingInput.placeholder = "未入力なら自動で推定";
		readingInput.value = freeInputDraft.reading;
		readingLabel.appendChild(readingInput);
		fields.append(surfaceLabel);
		const readingDisclosure = document.createElement("details");
		{
			readingDisclosure.className = "review-reading-input";
			const summary = document.createElement("summary");
			summary.textContent = "読みを指定";
			readingDisclosure.open = !!freeInputDraft.reading;
			readingDisclosure.append(summary, readingLabel);
			fields.append(readingDisclosure);
		}
		const note = document.createElement("span");
		note.className = "panel-replacement-note";
		note.setAttribute("role", "alert");
		const actions = document.createElement("div");
		actions.className = "panel-free-actions";
		const back = document.createElement("button");
		back.className = "btn btn-ghost panel-close panel-free-back";
		back.type = "button";
		back.textContent = "×";
		back.setAttribute("aria-label", "候補選択に戻る");
		back.title = "候補選択に戻る";
		panel.querySelector(".panel-close").replaceWith(back);
		// ソフトウェアキーボード表示中は通常の click がパネル移動で消えることがあるため、
		// touch は pointerup で確定する。スクロール開始点がボタン上でも誤って閉じないよう、
		// 指が動いた場合はタップとして扱わない。
		let backTouch = null;
		back.addEventListener("pointerdown", (event) => {
			if (event.pointerType !== "touch" || !event.isPrimary) return;
			backTouch = { id: event.pointerId, x: event.clientX, y: event.clientY };
		});
		back.addEventListener("pointermove", (event) => {
			if (!backTouch || event.pointerId !== backTouch.id) return;
			const dx = event.clientX - backTouch.x;
			const dy = event.clientY - backTouch.y;
			if (dx * dx + dy * dy > 100) backTouch = null;
		});
		back.addEventListener("pointerup", (event) => {
			if (!backTouch || event.pointerId !== backTouch.id) return;
			backTouch = null;
			freeInputReturnClickUntil = performance.now() + 400;
			closeFreeInput();
		});
		back.addEventListener("pointercancel", () => {
			backTouch = null;
		});
		back.addEventListener("click", (event) => {
			// touch は pointerup 側で処理済み。マウスとキーボードの click だけを扱う。
			if (event.pointerType === "touch") return;
			closeFreeInput();
		});
		const apply = document.createElement("button");
		apply.className = "btn btn-primary panel-free-apply";
		apply.textContent = "確定";
		const applyFree = () => {
			const text = surfaceInput.value.trim();
			if (text === "") {
				note.textContent = "替え歌歌詞を入力してください";
				return;
			}
			const custom = makeCustomWord(text, readingInput.value, target, rangeWeights);
			if (!custom) {
				note.textContent = "この範囲の音数に合わせられる読みを入力してください";
				readingDisclosure.open = true;
				focusReadingInput(readingInput);
				return;
			}
			replaceSelection(custom);
		};
		apply.addEventListener("click", applyFree);
		for (const input of [surfaceInput, readingInput]) {
			input.addEventListener("input", () => {
				freeInputDraft = { surface: surfaceInput.value, reading: readingInput.value };
			});
			input.addEventListener("focus", () => {
				if (isIOSDevice() && !readingInputLayoutCleanup) focusReadingInput(input);
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") applyFree();
			});
		}
		actions.append(apply);
		free.append(heading, fields, note, actions);
		panel.appendChild(free);
		queueMicrotask(() => focusReadingInput(surfaceInput));
	}
}

function setCandidateSelected(button, selected) {
	button.setAttribute("aria-pressed", String(selected));
	if (!selected) return;
	const check = document.createElement("span");
	check.className = "candidate-check";
	check.textContent = "✓";
	check.setAttribute("aria-hidden", "true");
	button.appendChild(check);
}

function buildPanel() {
	readingInputLayoutCleanup?.();
	const panel = $id("editor-panel");
	document.documentElement.classList.toggle(
		"editor-free-input-open", !!selection && freeInputOpen);
	hidePopover();
	if (!selection) {
		panel.classList.remove("open");
		panel.replaceChildren();
		return;
	}
	panel.textContent = "";
	panel.classList.add("open");
	const { line, start, end } = selection;
	const span = db ? tokenSpanForSelection(line, start, end) : null;

	appendReviewHeader(panel, data, selection, {
		close: () => setSelection(null), lock: toggleLock, unit: onUnitClick,
		lockIcon: makeLockIcon,
		pointer: onUnitPointerDown,
		reading: !isVideoReview(data) && span ? {
			label: `「${span.surface}（${span.yomi}）」の読みを修正`,
			open: () => openReadingFixDialog(line, start, end, span),
		} : null,
	});

	if (!db || settingsUpdating) {
		const note = document.createElement("p");
		note.className = "panel-note";
		note.textContent = "候補を読み込み中...(単語リスト初期化中)";
		panel.appendChild(note);
		return;
	}

	// 候補の取得と同姓同名(表記+読みが同じでidが違う)のグループ化。
	// 単語重複なしの判定はid単位なので、同名でも別idはそれぞれ選べるようにする
	const target = unitsOf(line).slice(start, end).map((u) => u.pronunciation);
	// 位置別の重み(汎用weightsList、または生ノート長とαから導出)があれば、
	// 選択範囲に対応する区間を切り出して候補計算にも効かせる
	const allWeights = noteLengthWeights();
	const rangeWeights = allWeights && Array.isArray(allWeights[line])
		? allWeights[line].slice(start, end)
		: null;
	const fetched = app.soramimiMaker.getCandidates(db, target, data.param, RAW_FETCH, rangeWeights);
	const used = usedIdSet(line, start, end);
	const selectedWord = (data.results[line] || []).find((word) => !word.filler
		&& word.period[0] === start && word.period[1] === end);
	const isSelected = (cand) => !!selectedWord && cand.id === selectedWord.id
		&& cand.surface === selectedWord.surface && cand.kana === selectedWord.kana
		&& (cand.wordlistSource || data.wordlistSource) === (selectedWord.wordlistSource || data.wordlistSource);
	const groups = [];
	const byKey = new Map();
	for (const cand of fetched) {
		const key = cand.surface + "\t" + cand.kana;
		if (!byKey.has(key)) {
			const g = { key, cands: [] };
			byKey.set(key, g);
			groups.push(g);
		}
		byKey.get(key).cands.push(cand);
	}

	// 同名グループを開いている場合は個別選択リストを出す
	if (openGroupKey && byKey.has(openGroupKey)) {
		renderGroupPicker(panel, byKey.get(openGroupKey), used, isSelected);
		return;
	}
	if (freeInputOpen) {
		appendReplacementControls(panel, target, rangeWeights);
		return;
	}

	const list = document.createElement("div");
	list.className = "panel-candidates";
	const listTitle = document.createElement("h3");
	listTitle.className = "panel-candidates-title";
	listTitle.textContent = "候補から選ぶ";
	list.appendChild(listTitle);
	const freeToggle = document.createElement("button");
	freeToggle.className = "btn panel-free-toggle";
	freeToggle.type = "button";
	const customWord = isCustomWord(selectedWord) ? selectedWord : null;
	freeToggle.textContent = customWord ? "✎ 手入力を編集" : "＋ 自分で入力";
	freeToggle.setAttribute("aria-expanded", "false");
	freeToggle.addEventListener("click", () => {
		freeInputOpen = true;
		freeInputDraft = { surface: customWord?.surface || "", reading: customWord?.kana || "" };
		renderPanel();
	});
	list.appendChild(freeToggle);
	const shown = groups.slice(0, Math.min(panelShown, GROUP_MAX));
	const shownCount = shown.length;
	// 手入力・別リストの語・表示件数外の語も、現在の選択として解除できるようにする。
	if (selectedWord && !shown.some((group) => group.cands.some(isSelected))) {
		shown.unshift({ cands: [selectedWord] });
	}
	if (!selectedWord && (data.results[line] || []).some((word) =>
		!word.filler && word.period[0] < end && start < word.period[1])) {
		const clear = document.createElement("button");
		clear.className = "btn panel-clear-range";
		clear.textContent = "この範囲の選択を解除";
		clear.addEventListener("click", clearSelectionAssignment);
		list.appendChild(clear);
	}
	if (shown.length === 0) {
		const note = document.createElement("p");
		note.className = "panel-note";
		note.textContent = "候補がありません";
		list.appendChild(note);
	}
	for (const g of shown) {
		const cand = g.cands[0];
		const allUsed = g.cands.every((c) => used.has(c.id));
		const btn = document.createElement("button");
		btn.className = "btn candidate";
		btn.dataset.candidateId = String(cand.id);
		const selected = g.cands.some(isSelected);
		setCandidateSelected(btn, selected);
		if (allUsed) btn.classList.add("used");
		const surface = document.createElement("span");
		surface.className = "candidate-surface";
		surface.textContent = cand.surface;
		if (g.cands.length > 1) {
			const count = document.createElement("span");
			count.className = "candidate-count";
			count.textContent = `×${g.cands.length}`;
			surface.appendChild(count);
		}
		const kana = document.createElement("span");
		kana.className = "candidate-kana";
		kana.textContent = cand.kana + (allUsed ? "・使用中" : "");
		btn.append(surface, kana);
		if (isCustomWord(cand)) {
			const source = document.createElement("span");
			source.className = "candidate-source";
			source.textContent = "手入力";
			btn.appendChild(source);
		}
		if (g.cands.length === 1) {
			btn.title = candidateDetail(cand, used.has(cand.id));
			attachLongPress(btn, () => candidateDetail(cand, used.has(cand.id)));
			btn.addEventListener("click", () => selected ? clearSelectionAssignment() : replaceSelection(cand));
		} else {
			btn.title = `${g.cands.length}件の同名候補(タップして選ぶ)`;
			attachLongPress(btn, () =>
				`${g.cands.length}件の同名候補:\n` +
				g.cands.slice(0, 8).map((c) => c.original || c.surface).join("\n") +
				(g.cands.length > 8 ? "\n…" : ""));
			btn.addEventListener("click", () => {
				if (selected) return clearSelectionAssignment();
				openGroupKey = g.key;
				renderPanel();
			});
		}
		if (selected) btn.title = "選択中（もう一度タップすると解除）";
		list.appendChild(btn);
	}
	if (groups.length > shownCount && shownCount < GROUP_MAX) {
		const more = document.createElement("button");
		more.className = "btn panel-more";
		more.textContent =
			`もっと見る(${shownCount}/${Math.min(groups.length, GROUP_MAX)}件表示中)`;
		more.addEventListener("click", () => {
			panelShown += GROUP_PAGE;
			renderPanel();
		});
		list.appendChild(more);
	}
	panel.appendChild(list);
}

// 同名候補(id違い)の個別選択リスト
function renderGroupPicker(panel, group, used, isSelected) {
	const back = document.createElement("button");
	back.className = "btn panel-back";
	back.textContent = "← 候補一覧に戻る";
	back.addEventListener("click", () => {
		openGroupKey = null;
		renderPanel();
	});
	panel.appendChild(back);

	const heading = document.createElement("p");
	heading.className = "panel-note";
	const first = group.cands[0];
	heading.textContent =
		`「${first.surface}(${first.kana})」の同名候補 ${group.cands.length}件。どれを使うか選んでください`;
	panel.appendChild(heading);

	const list = document.createElement("div");
	list.className = "panel-group-list";
	for (const cand of group.cands) {
		const isUsed = used.has(cand.id);
		const row = document.createElement("button");
		row.className = "btn group-entry";
		row.dataset.candidateId = String(cand.id);
		const selected = isSelected(cand);
		setCandidateSelected(row, selected);
		if (isUsed) row.classList.add("used");
		const main = document.createElement("span");
		main.textContent = cand.original || cand.surface;
		const sub = document.createElement("span");
		sub.className = "group-entry-sub";
		sub.textContent = `#${cand.id}・${isUsed ? "使用中" : "未使用"}`;
		row.append(main, sub);
		row.title = candidateDetail(cand, isUsed);
		attachLongPress(row, () => candidateDetail(cand, isUsed));
		if (selected) row.title = "選択中（もう一度タップすると解除）";
		row.addEventListener("click", () => selected ? clearSelectionAssignment() : replaceSelection(cand));
		list.appendChild(row);
	}
	panel.appendChild(list);
}

// ---- 再生成・コピー ----

// 🔒固定した単語(と差し替え済み単語)を残し、それ以外を作り直す
function showRegenerationError(error) {
	$id("regen-progress").textContent = error.message;
	$id("regen-progress").hidden = false;
}

function regenerate({ allUnlocked = false, line = null } = {}) {
	if (regeneration) return regeneration;
	if (settingsUpdating || !db) return Promise.reject(new Error("候補の準備ができていません。もう一度お試しください"));
	const btn = $id("btn-regenerate");
	const progress = $id("regen-progress");
	// 編集の影響がありうる行だけ再計算する。単語重複なしでは使用済み単語が
	// 後続行の選択に影響するため「最初に編集した行以降すべて」、重複ありでは
	// 「編集した行だけ」が対象。それ以外の行は現在の単語を丸ごと固定として
	// 渡すことでDP計算がスキップされ、結果も変わらない
	const dirty = new Set(data.dirtyLines);
	const minDirty = dirty.size > 0 ? Math.min(...dirty) : Infinity;
	const atRisk = (i) => (data.param.DUPLICATE ? dirty.has(i) : i >= minDirty);
	// filler(未変換の区間)は固定扱いにしない。単語が増えていれば埋まるように、
	// 再生成のたびに埋め直しを試みる
	const locksPerLine = data.results.map((words, i) =>
		(words || []).filter((w) => !w.filler && ((allUnlocked || atRisk(i)) ? w.locked : true))
			.map((word) => generationLock(word, data.wordlistSource)));
	const input = line === null
		? { tokens: data.tokensList, db, locks: locksPerLine, weights: noteLengthWeights() }
		: lineRegenerationInput(data, db, line, noteLengthWeights());
	btn.disabled = true;
	progress.hidden = false;
	progress.textContent = line === null ? `再生成中... 0/${data.results.length}` : `${line + 1}行目を再生成中…`;
	setSelection(null);
	$id("app").inert = true;
	let handle, timeout;
	regeneration = new Promise((resolve, reject) => {
		timeout = setTimeout(() => {
			handle?.cancel();
			reject(new Error("再生成に時間がかかっています。もう一度お試しください"));
		}, 120000);
		handle = app.soramimiMaker.generateFromTokens(
			input.tokens, input.db, data.param,
			(result, i) => {
				if (line === null) progress.textContent = `再生成中... ${i + 1}/${data.results.length}`;
			},
			(results) => {
				try {
					pushHistory();
					if (line === null) {
						data.results = results.map((words) => generatedWords(words, data.wordlistSource));
						data.dirtyLines = [];
					} else {
						data.results[line] = generatedWords(results[0], data.wordlistSource);
						data.dirtyLines = data.dirtyLines.filter((i) => i !== line);
					}
					saveData();
					renderAll();
					resolve();
				} catch (error) { reject(error); }
			},
			input.locks, input.weights);
	}).finally(() => {
		clearTimeout(timeout);
		regeneration = null;
		btn.disabled = false;
		progress.hidden = true;
		$id("app").inert = false;
		syncLineActions();
	});
	syncLineActions();
	return regeneration;
}

// ---- 「変換のしかた」モーダル(パラメータ・絞り込み) ----
// 生成画面へ戻らなくても変換のしかたを変えられるようにする(#17の続き)。
// ツールバーの⚙から開くモーダル(dialog)で、パラメータUIは生成画面と同じ
// 共有部品(convertControls.js)。初期値は引き継いだ data.param から逆算する

// Prepare the engine against a captured settings value before committing it.
async function prepareEngine(settings) {
	const nextApp = appFor(settings.param?.VOWEL_RATIO);
	const key = wordlistKey(settings.wordlist);
	const nextDb = key === dbWordlistKey && settings.where === dbWhere && db
		? db : await buildDatabase(nextApp, settings.wordlist, settings.where);
	return { app: nextApp, db: nextDb, key, source: await wordlistSource(settings.wordlist) };
}

function useEngine(engine, settings) {
	app = engine.app;
	db = engine.db;
	engineVowelRatio = settings.param?.VOWEL_RATIO;
	dbWhere = settings.where;
	dbWordlistKey = engine.key;
	data.wordlistSource = engine.source;
}

function engineMatches(settings = data) {
	return db && dbWordlistKey === wordlistKey(settings.wordlist) && dbWhere === settings.where
		&& engineVowelRatio === settings.param?.VOWEL_RATIO;
}

async function syncEngine() {
	if (!appFor) return false;
	const revision = ++settingsRevision;
	const settings = { param: data.param, wordlist: data.wordlist, where: data.where };
	try {
		const engine = await prepareEngine(settings);
		if (revision !== settingsRevision) return false;
		useEngine(engine, settings);
		return true;
	} catch (error) {
		if (revision !== settingsRevision) return false;
		throw error;
	}
}

// 表示を現在の data.param / data.wordlist / data.where に合わせ直す(戻る/進むのあと)。
// モーダルが閉じていてもDOMは生きているので、次に開いたときに正しい表示になる
function syncSettingsUi() {
	if (!paramControls) return;
	paramControls.setValues(valuesFromParam(data.param));
	paramControls.syncPreset();
	const noteField = $id("editor-note-length-field");
	if (noteField) noteField.hidden = !Array.isArray(data.noteLengthRawList);
	const noteInput = $id("editor-note-length-alpha");
	if (noteInput && Array.isArray(data.noteLengthRawList)) {
		noteInput.value = String(data.noteLengthAlpha);
	}
	syncWordlistUi();
}

// ---- 自作リストの入力(貼り付け / ファイル読み込み) ----

function setOriginalFileStatus(text) {
	const el = $id("original-file-status");
	if (!el) return;
	el.textContent = text || "";
	el.hidden = !text;
}

// 自作リストを選択中なら、専用モーダルを開き直すボタンを設定画面に出す。
function showOriginalEditButton(show) {
	$id("btn-original-edit").hidden = !show;
}

// 自作リストの内容は生成画面と共有する(localStorage)。容量オーバーは黙って
// 落とさず、その場の状態表示で知らせる
function saveOriginalText(text) {
	try {
		localStorage.setItem(ORIGINAL_STORAGE_KEY, text);
	} catch (err) {
		console.warn("自作リストの保存に失敗:", err);
		setOriginalFileStatus(
			"自作リストを保存できませんでした(ブラウザの保存容量オーバー)。行数を減らしてください");
	}
}

// 読み込んだ内容の件数(コメント・空行と、tidy CSVの見出し行を除いた行数)。
// 正確な語数ではなく「入った」ことが分かるための目安表示
function countOriginalEntries(text) {
	const lines = String(text).split(/\r\n|\n|\r/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (lines.length > 0 && looksLikeTidyHeader(lines[0])) lines.shift();
	return lines.length;
}

// 選んだCSV/テキストを自作リストの編集欄に流し込む。ここでやるのは
// textareaを埋めてinputを発火させるところまでで、正規化CSV(originalTextToCsv)も
// localStorageへの保存も貼り付けたときとまったく同じハンドラに任せる
async function loadOriginalFile(file) {
	if (file.size > ORIGINAL_FILE_MAX) {
		setOriginalFileStatus(
			`ファイルが大きすぎます(${(file.size / 1024 / 1024).toFixed(1)}MB)。`
			+ `${ORIGINAL_FILE_MAX / 1024 / 1024}MBまでのCSV/テキストにしてください`);
		return;
	}
	let text;
	try {
		text = await file.text();
	} catch (err) {
		console.error(err);
		setOriginalFileStatus("ファイルを読み込めませんでした: " + err.message);
		return;
	}
	const ta = $id("editor-original-text");
	ta.value = text;
	// 先に成功の表示を出しておく。保存に失敗したときは input のハンドラが
	// この表示を上書きするので、失敗のほうが残る
	setOriginalFileStatus(`${file.name}: ${countOriginalEntries(text)}語を読み込みました`);
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// 自作リスト欄へクリップボードのテキストを流し込む。Clipboard API が使えない
// HTTP配置や権限拒否では、欄へフォーカスして通常の Ctrl/Cmd+V を案内する。
async function pasteOriginalText() {
	const ta = $id("editor-original-text");
	try {
		if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
			throw new Error("clipboard unavailable");
		}
		const text = await navigator.clipboard.readText();
		if (!text) {
			setOriginalFileStatus("クリップボードにテキストがありません");
			return;
		}
		ta.value = text;
		setOriginalFileStatus(`クリップボードから${countOriginalEntries(text)}語を貼り付けました`);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	} catch (err) {
		console.warn("クリップボードを読み取れませんでした:", err);
		ta.focus();
		setOriginalFileStatus("入力欄に Ctrl+V（Macは⌘V）で貼り付けてください");
	}
}

// 単語リスト選択・自作リストの編集欄・ファセットを data.wordlist / data.where に
// 合わせ直す。単語リストの選択UIは conf が取れた環境にしか無いので、
// 無ければファセットだけ面倒を見る
let wordlistUiValue = "";

function syncWordlistUi() {
	const entry = data.wordlist || {};
	const sel = $id("editor-wordlist");
	if (wordlistCatalog && sel) {
		if (entry.value) {
			sel.value = entry.value;
			wordlistUiValue = entry.value;
		}
		showOriginalEditButton(entry.value === "ORIGINAL");
	}
	facetsEnabled = hasFacets(entry);
	$id("editor-facet-field").hidden = !facetsEnabled;
	if (facetsEnabled) {
		renderFacets($id("editor-facets"), entry);
		restoreFacets($id("editor-facets"), data.where);
	} else {
		$id("editor-facets").innerHTML = "";
	}
}

// 選んだリストの絞り込みを表示し、今ある歌詞を保ったまま設定を保存する。
function onWordlistChange() {
	const entry = wordlistCatalog && wordlistCatalog.get($id("editor-wordlist").value);
	if (!entry) return;
	showOriginalEditButton(entry.value === "ORIGINAL");
	if (entry.value === "ORIGINAL") openOriginalDialog(data.wordlist?.value || wordlistUiValue);
	else wordlistUiValue = entry.value;
	facetsEnabled = hasFacets(entry);
	$id("editor-facet-field").hidden = !facetsEnabled;
	renderFacets($id("editor-facets"), entry);
	// いま適用中のリストへ選び直しただけなら、現在の絞り込みを保つ
	// (選び直しで絞り込みが黙って既定に戻るのを避ける)
	if (facetsEnabled && entry.value === (data.wordlist && data.wordlist.value)) {
		restoreFacets($id("editor-facets"), data.where);
	}
	if (entry.value !== "ORIGINAL") saveSettings();
}

let originalDialogRestoreValue = null;
let originalDialogAccepted = false;
let originalDraftEntry = null;

// 自作リストは別モーダルで編集する。選択操作から開いた場合は、キャンセル時に
// それまで適用されていた単語リストへセレクトを戻す。
function openOriginalDialog(restoreValue = null) {
	if (engineMatches()) {
		++settingsRevision;
		setSettingsBusy(false);
		showSettingsStatus();
	}
	originalDraftEntry = null;
	const dialog = $id("editor-original-dialog");
	const ta = $id("editor-original-text");
	originalDialogRestoreValue = restoreValue && restoreValue !== "ORIGINAL"
		? restoreValue : null;
	originalDialogAccepted = false;
	const saved = localStorage.getItem(ORIGINAL_STORAGE_KEY);
	if (saved !== null) ta.value = saved;
	else if (data.wordlist && data.wordlist.value === "ORIGINAL") {
		ta.value = data.wordlist.csvText || "";
	}
	setOriginalFileStatus("");
	dialog.showModal();
	ta.focus();
}

function cancelOriginalDialog() {
	$id("editor-original-dialog").close();
}

function acceptOriginalDialog() {
	const text = $id("editor-original-text").value;
	if (!text.trim()) {
		setOriginalFileStatus("単語を1つ以上入力してください");
		return;
	}
	try {
		originalDraftEntry = { value: "ORIGINAL", text: "自作リストを使う",
			csvText: originalTextToCsv(text, app) };
	} catch (error) {
		setOriginalFileStatus(error.message);
		return;
	}
	saveOriginalText(text);
	originalDialogAccepted = true;
	originalDialogRestoreValue = null;
	wordlistUiValue = "ORIGINAL";
	$id("editor-original-dialog").close();
	showOriginalEditButton(true);
	saveSettings();
}

function finishOriginalDialog() {
	if (!originalDialogAccepted && originalDialogRestoreValue) {
		$id("editor-wordlist").value = originalDialogRestoreValue;
		onWordlistChange();
	}
	originalDialogRestoreValue = null;
}

// いま選択されている単語リストのエントリ。自作リストのときは編集欄の内容を
// 正規化CSVにして持たせる(csvText契約: 書き出しJSONを自己完結させる)
function pickedWordlistEntry() {
	const sel = $id("editor-wordlist");
	const picked = wordlistCatalog && sel && wordlistCatalog.get(sel.value);
	if (!picked) return data.wordlist;
	if (picked.value !== "ORIGINAL") return Object.assign({}, picked);
	return originalDraftEntry || (data.wordlist?.value === "ORIGINAL" ? data.wordlist : {
		value: "ORIGINAL", text: picked.text, csvText: "",
	});
}

// conf/setting.json から単語リストの選択肢を組み立てる(生成画面と同じ情報源)。
// 取得できない環境(スタンドアロン配置・テスト)ではセクションを出さないだけで、
// 引き継いだリストでの編集は従来どおり動く
async function setupWordlistPicker() {
	const sel = $id("editor-wordlist");
	if (!sel) return;
	let config;
	try {
		config = await fetchJson("conf/setting.json");
	} catch (err) {
		console.warn("単語リスト一覧を取得できませんでした(選択UIを出しません):", err);
		return;
	}
	const items = (config && Array.isArray(config.wordlist)) ? config.wordlist : [];
	const catalog = new Map();
	const addOption = (parent, entry) => {
		const opt = document.createElement("option");
		opt.value = entry.value;
		opt.textContent = entry.text || entry.value;
		parent.appendChild(opt);
		catalog.set(entry.value, entry);
	};
	// 引き継いだリストがカタログに無い(親アプリ独自のエントリ等)ときは先頭に足し、
	// 選択表示と実際に使っているリストが食い違わないようにする
	const current = data.wordlist || {};
	const known = items.flatMap((it) => (it.items ? it.items : [it]));
	if (current.value && current.value !== "ORIGINAL"
		&& !known.some((e) => e.value === current.value)) {
		addOption(sel, current);
	}
	for (const item of items) {
		if (!item.items) {
			addOption(sel, item);
			continue;
		}
		const group = document.createElement("optgroup");
		group.label = item.label;
		for (const entry of item.items) addOption(group, entry);
		sel.appendChild(group);
	}
	addOption(sel, { value: "ORIGINAL", text: "自作リストを使う" });
	wordlistCatalog = catalog;

	const ta = $id("editor-original-text");
	// 自作リストの内容は「このリストを使う」で生成画面と共有する(localStorage)。
	// ファイル・クリップボードはtextareaに流し込むところまで同じ経路を使う。
	const fileInput = $id("original-file");
	$id("btn-original-edit").addEventListener("click", () => openOriginalDialog());
	$id("btn-original-paste").addEventListener("click", pasteOriginalText);
	$id("btn-original-file").addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", () => {
		const file = fileInput.files && fileInput.files[0];
		fileInput.value = ""; // 同じファイルの選び直しでもchangeが発火するように
		if (file) loadOriginalFile(file);
	});
	$id("btn-original-register").addEventListener("click", acceptOriginalDialog);
	$id("btn-original-cancel").addEventListener("click", cancelOriginalDialog);
	$id("btn-original-close").addEventListener("click", cancelOriginalDialog);
	$id("editor-original-dialog").addEventListener("close", finishOriginalDialog);
	// phrasesだけで開かれた(単語リスト未指定の)ときは、生成画面と同じ既定
	// (conf の active。無ければ先頭)を初期選択にして、絞り込み表示とも揃える
	if (!data.wordlist || !data.wordlist.value) {
		const def = known.find((e) => e.active) || known[0];
		if (def) {
			data.wordlist = Object.assign({}, def);
			sel.value = def.value;
		}
	}
	sel.addEventListener("change", onWordlistChange);
	syncWordlistUi();
	$id("editor-wordlist-field").hidden = false;
}

function showSettingsStatus(message = "") {
	for (const id of ["settings-progress", "editor-settings-status"]) {
		$id(id).textContent = message;
		$id(id).hidden = !message;
	}
}

function setSettingsBusy(busy) {
	settingsUpdating = busy;
	$id("editor-settings").setAttribute("aria-busy", String(busy));
	$id("btn-regenerate").disabled = busy || !db || !!regeneration;
	syncLineActions();
	updateHistoryButtons();
	if (busy) scheduleReverseSearch();
}

// Settings apply to future edits and generation. Existing lyrics and locks stay
// intact, including when IDs happen to overlap between different word lists.
async function saveSettings() {
	if (setupMode || regeneration || $id("editor-original-dialog").open) return;
	settingsDirty = true;
	if (!settingsReady || !appFor) return;
	settingsDirty = false;
	const revision = ++settingsRevision;
	const previousEntry = data.wordlist;
	const nextEntry = pickedWordlistEntry();
	const listChanged = wordlistKey(nextEntry) !== wordlistKey(data.wordlist);
	const alpha = Number($id("editor-note-length-alpha").value);
	const next = {
		param: { ...data.param, ...paramControls.getParam() },
		wordlist: nextEntry,
		where: hasFacets(nextEntry) ? compileWhere($id("editor-facets"), nextEntry)
			: listChanged ? undefined : data.where,
		noteLengthAlpha: Array.isArray(data.noteLengthRawList)
			? Number.isFinite(alpha) && alpha >= 0 ? Math.min(2, alpha) : DEFAULT_NOTE_LENGTH_ALPHA
			: data.noteLengthAlpha,
	};
	if (engineMatches() && !listChanged && next.where === data.where && next.noteLengthAlpha === data.noteLengthAlpha
		&& JSON.stringify(next.param) === JSON.stringify(data.param)) {
		setSettingsBusy(false);
		showSettingsStatus();
		scheduleReverseSearch();
		renderPanel();
		return;
	}
	setSettingsBusy(true);
	showSettingsStatus("設定を反映中…");
	renderPanel();
	try {
		const engine = await prepareEngine(next);
		const previousSource = data.wordlistSource || await wordlistSource(previousEntry);
		if (revision !== settingsRevision) return;
		pushHistory();
		if (listChanged) {
			data.results = data.results.map((words) => generatedWords(words, previousSource, true));
		}
		Object.assign(data, next);
		if (originalDraftEntry === nextEntry) originalDraftEntry = null;
		useEngine(engine, next);
		data.dirtyLines = data.results.map((_, i) => i);
		saveData();
		setSettingsBusy(false);
		showSettingsStatus();
		renderAll();
		renderPanel();
	} catch (error) {
		if (revision !== settingsRevision) return;
		setSettingsBusy(false);
		originalDraftEntry = null;
		syncSettingsUi();
		showSettingsStatus("設定を反映できませんでした: " + error.message);
		scheduleReverseSearch();
		renderPanel();
	}
}

function setupSettingsPanel() {
	const dialog = $id("editor-settings");
	if (!dialog) return;
	paramControls = createParamControls({
		paramArea: $id("editor-param-area"),
		presetArea: $id("editor-preset-buttons"),
		duplicateArea: $id("editor-duplicate-buttons"),
		values: valuesFromParam(data.param),
		onChange: saveSettings,
	});
	syncSettingsUi();
	// 絞り込みは単語リスト設定に facets があるときだけ(自作リスト等では出さない)。
	// リスト切替で出たり消えたりするので、リスナはコンテナに固定で付けておく
	syncWordlistUi();
	$id("editor-facets").addEventListener("change", saveSettings);
	$id("editor-note-length-alpha").addEventListener("input", saveSettings);
	// 単語リストの選択肢は conf の取得を待つので、あとから足す
	setupWordlistPicker().catch((err) => console.error(err));
	$id("btn-settings").addEventListener("click", () => dialog.showModal());
	$id("btn-settings-close").addEventListener("click", () => dialog.close());
	// バックドロップ(ダイアログの外側)のクリックで閉じる。ダイアログ自身の
	// 余白を押したときも target は dialog になるため、座標で内外を判定する
	dialog.addEventListener("click", (e) => {
		if (e.target !== dialog) return;
		const r = dialog.getBoundingClientRect();
		const outside = e.clientX < r.left || e.clientX > r.right
			|| e.clientY < r.top || e.clientY > r.bottom;
		if (outside) dialog.close();
	});
}

// ---- セットアップ画面(第1ステップ) ----
// 編集画面がメインで設定はオプションだが、起動時だけは 設定 → 編集画面 の順で出す。
// エディタがゼロから変換するのに要るのは phrases(行ごとの歌詞)だけで、
// tokensList が渡されていれば確定済みの読み・単語境界・文節を保持して使う。
// 渡されていないときは phrases から解析し、unitsList / results を導出する。
// 設定UI(単語リスト・パラメータ・絞り込み)は⚙モーダルと同じ実体を借りる:
// セットアップ画面と⚙モーダルは同時に出ないので、#editor-settings-body を
// DOMごと付け替えれば paramControls も含めてまるごと共有できる

// 旧セッション/旧エクスポートの param には母音・子音の掛け算ハック
// (SAME_VOWEL_REWARD:0.2 / SAME_CONSONANT_REWARD:0.9)が残っていることがある。
// 現行の monophoneタイブレーク行列(#102)ではこのハックはスコアを汚すため除去する
// (未指定=lib既定1で無効化)。VOWEL_RATIO 未指定は現行既定 0.8 とみなす。
function normalizeParam() {
	if (data.param && typeof data.param === "object") {
		delete data.param.SAME_VOWEL_REWARD;
		delete data.param.SAME_CONSONANT_REWARD;
		if (data.param.VOWEL_RATIO == null) data.param.VOWEL_RATIO = 0.8;
		// ン/ッ/ーの変換コストは母音準一致セル相当を vowelRatio に連動させる(#105)。
		// 旧セッション(未指定)は VOWEL_RATIO から導出し、候補・再生成を生成画面と揃える。
		if (data.param.VARIATION_COST == null) {
			data.param.VARIATION_COST = 20 * Number(data.param.VOWEL_RATIO);
		}
	}
}

function hasResults() {
	return Array.isArray(data.results) && data.results.length > 0
		&& Array.isArray(data.unitsList) && data.unitsList.length === data.results.length;
}

function moveSettingsBody(toSetup) {
	const body = $id("editor-settings-body");
	if (!body) return;
	if (toSetup) {
		$id("setup-settings-slot").appendChild(body);
		return;
	}
	const dialog = $id("editor-settings");
	dialog.insertBefore(body, $id("editor-settings-status"));
}

function enterSetup() {
	setupMode = true;
	moveSettingsBody(true);
	$id("editor-setup").hidden = false;
	$id("editor-toolbar").hidden = true;
	$id("editor-lines").hidden = true;
	renderSongField();
	renderLyricsField();
	// 未変換なら変換だけが出口。変換済み(setupFirst)で開いたときだけ離脱できる
	$id("btn-setup-back").hidden = !hasResults();
}

// セットアップ画面を畳んで編集画面に入る。第1ステップは起動時だけなので、
// ここで setupFirst を落としてリロードでも戻らないようにする
function leaveSetup() {
	setupMode = false;
	$id("editor-setup").hidden = true;
	moveSettingsBody(false);
	$id("editor-toolbar").hidden = false;
	$id("editor-lines").hidden = false;
	if (data.setupFirst) {
		delete data.setupFirst;
		saveData();
	}
}

// セットアップ画面の操作可否をまとめて反映する。変換中とホストへの依頼中は、
// 多重実行・多重依頼を防ぐため画面内の操作をすべて止める
function syncSetupControls() {
	const busy = setupConverting || songRequest !== null;
	for (const el of $id("editor-setup").querySelectorAll("button, input, select, textarea")) {
		el.disabled = busy;
	}
	for (const el of $id("editor-midi-dialog").querySelectorAll("button, textarea")) {
		if (el.id === "btn-setup-midi-close") continue;
		el.disabled = busy;
	}
	$id("btn-setup-convert").disabled = busy || !app;
}

function setSetupBusy(busy) {
	setupConverting = busy;
	syncSetupControls();
}

// ---- 曲の選択(ホストへの依頼) ----
// soramimic はMIDIの実体も解析も持たないので、曲の切替は埋め込み元(ホスト)に頼む。
// エディタは共有ペイロード(sessionStorage)に hostRequest を書いて待機し、ホストが
// phrases / song / noteLengthRawList を差し替えて hostRequest を消したら、新しい曲で
// セットアップ画面を描き直す。host が無い単体運用では曲セクションの見た目も
// 挙動も従来どおり(曲名の読み取り専用表示)のまま

function hostInfo() {
	return (data && data.host && typeof data.host === "object") ? data.host : {};
}

// ホストが選ばせたい曲の一覧。idの無いエントリは依頼できないので捨てる
function hostSongs() {
	const songs = hostInfo().songs;
	if (!Array.isArray(songs)) return [];
	return songs.filter((s) => s && typeof s.id === "string" && s.id !== "");
}

function setSongStatus(text) {
	const el = $id("setup-song-status");
	if (el) {
		el.textContent = text || "";
		el.hidden = !text;
	}
	const modal = $id("setup-midi-status");
	if (modal) {
		modal.textContent = text || "";
		modal.hidden = !text;
	}
}

// 曲セクションを data.host / data.song に合わせて描き直す。
// host.songs があれば「サンプルから選ぶ」の折りたたみ、host.canUploadSong があれば
// 持ち込みボタン、どちらも無ければ曲名を出すだけ(無ければセクションごと出さない)。
// いまの曲名は折りたたみを開かなくても分かるよう常に出す
function renderSongField() {
	const songs = hostSongs();
	const canUpload = hostInfo().canUploadSong === true;
	const title = (data.song && data.song.title) || "";
	const sel = $id("setup-song-select");
	const samples = $id("setup-song-samples");
	samples.hidden = songs.length === 0;
	// 描き直すのは初回とホストの応答後。いまの曲名が上に出ているので畳んでおく
	samples.open = false;
	$id("setup-song-actions").hidden = !canUpload;
	$id("setup-song-title").textContent = title;
	$id("setup-song-title").hidden = title === "";
	$id("setup-midi-title").textContent = title || "MIDIファイルを選んでください";
	if (songs.length > 0) {
		const current = (data.song && data.song.id) || "";
		const known = current !== "" && songs.some((s) => s.id === current);
		sel.innerHTML = "";
		// いまの曲が一覧に無い(持ち込みMIDI等)ときは、その曲名の項目を先頭に足して
		// 表示と実際の曲が食い違わないようにする(選んでも依頼は出さない)
		if (!known) {
			const opt = document.createElement("option");
			opt.value = "";
			opt.textContent = title || "(曲を選ぶ)";
			sel.appendChild(opt);
		}
		for (const s of songs) {
			const opt = document.createElement("option");
			opt.value = s.id;
			opt.textContent = s.title || s.id;
			sel.appendChild(opt);
		}
		sel.value = known ? current : "";
	}
	$id("setup-song-field").hidden = songs.length === 0 && !canUpload && title === "";
}

// ホストに依頼を出して待機に入る。応答(hostRequestの消滅)まで画面の操作は止める
function requestHostSong(type, id) {
	if (!data || setupConverting || songRequest) return;
	const req = { type, nonce: Date.now() };
	if (id) req.id = id;
	data.hostRequest = req;
	songRequest = req;
	saveData();
	songRequestDeadline = Date.now() + HOST_TIMEOUT_MS;
	setSongStatus(type === "song-upload"
		? "MIDIファイルの選択を待っています..."
		: "曲を切り替えています...");
	syncSetupControls();
	clearInterval(songRequestTimer);
	songRequestTimer = setInterval(pollHostResponse, HOST_POLL_MS);
}

function endSongRequest() {
	clearInterval(songRequestTimer);
	songRequestTimer = null;
	songRequest = null;
	syncSetupControls();
}

// ホストとは同じ sessionStorage を共有しているだけでイベントは飛んでこないので、
// 自分が書いた hostRequest が消えるのをポーリングで見張る。応答が来ないまま
// 期限を過ぎたら依頼を取り下げて操作を戻す(永久ロックを避ける)
function pollHostResponse() {
	if (!songRequest) {
		endSongRequest();
		return;
	}
	let next = null;
	try {
		next = JSON.parse(sessionStorage.getItem(EDITOR_STORAGE_KEY));
	} catch (err) {
		console.warn("ホストの応答を読めませんでした:", err);
	}
	if (!next || typeof next !== "object") next = null;
	const waiting = next && next.hostRequest && next.hostRequest.nonce === songRequest.nonce;
	if (waiting) {
		if (Date.now() < songRequestDeadline) return;
		delete data.hostRequest;
		saveData();
		endSongRequest();
		renderSongField(); // 選び直した表示を現在の曲に戻す
		setSongStatus("曲の切り替えに応答がありませんでした。もう一度お試しください。");
		return;
	}
	endSongRequest();
	applyHostResponse(next);
}

// ホストの応答を取り込む。phrases が差し替わっていれば新しい曲として描き直し、
// 変わっていなければキャンセル(ファイル選択をやめた等)として待機解除だけにする
function applyHostResponse(next) {
	const changed = !!next && Array.isArray(next.phrases) && next.phrases.length > 0
		&& JSON.stringify(next.phrases) !== JSON.stringify(data.phrases);
	if (!changed) {
		delete data.hostRequest;
		saveData();
		renderSongField(); // 選び直した表示を現在の曲に戻す
		setSongStatus("");
		return;
	}
	// 差し替え前に古い曲への参照(選択)を落としておく
	setSelection(null);
	// ホストが書き戻したペイロードをそのまま採用する。単語リスト・パラメータの
	// 選択はUI(DOM)側に残っているので、曲だけが差し替わる
	data = next;
	delete data.hostRequest;
	if (!Array.isArray(data.results)) data.results = [];
	if (!Array.isArray(data.unitsList)) data.unitsList = [];
	// 新しい曲は未変換。中途半端な結果が残っていても捨てる
	if (!hasResults()) {
		data.results = [];
		data.unitsList = [];
	}
	if (!Array.isArray(data.weightsList)) delete data.weightsList;
	normalizeNoteLengthSetting();
	normalizeParam();
	// 行ごとの元歌詞は前の曲の phrases に対する対応づけなので、新しい曲で作り直す
	//(ホストが元歌詞ごと差し替えていれば、その元歌詞で対応づけ直す)
	syncOriginalLines();
	data.history = [];
	data.future = [];
	data.dirtyLines = [];
	saveData();
	renderAll(); // 前の曲の結果が残っていれば消える
	updateHistoryButtons();
	renderSongField();
	renderLyricsField();
	setSongStatus("");
	// 変換済みで開いた(setupFirst)場合でも、新しい曲は未変換なので出口は変換だけ
	$id("btn-setup-back").hidden = !hasResults();
}

// ---- 元歌詞(字幕用) ----
// 埋め込み元(soramimic-video)は元歌詞を字幕に使う。エディタ側で入力・確認できる
// ようにして、行ごとの対応づけ(originalLines: phrases と同じ長さ・対応づかない行は
// 空文字)まで作ってホストへ渡す。対応づけはMIDI取り込みと同じ xfAlign を使う。
// 元歌詞は変換の入力には使わない(今回は字幕用のみ)

// 元歌詞欄を出すのはホスト(埋め込み元)から開かれたとき、または元歌詞を
// 渡されたときだけ。単体運用(soramimic.com)は字幕を作らないので従来どおり出さない
function lyricsEnabled() {
	return typeof data.lyrics === "string"
		|| (!!data.host && typeof data.host === "object");
}

// data.lyrics と phrases を対応づけて data.originalLines を作り直す。
// 元歌詞が空(または行が無い)なら originalLines ごと落とす
function syncOriginalLines() {
	// Review uses the host's analyzed alignment, also used for video subtitles.
	if (isVideoReview(data)) return;
	const text = typeof data.lyrics === "string" ? data.lyrics : "";
	const phrases = Array.isArray(data.phrases) ? data.phrases : [];
	if (text.trim() === "" || phrases.length === 0) {
		delete data.originalLines;
		return;
	}
	data.originalLines = alignLyricsToLines(phrases, text).originalLines;
}

// 何行が対応づいたかを出す(生成画面のMIDI取り込みと同じ流儀)。
// 表示は data.originalLines から導くので、状態と食い違わない
function renderLyricsStatus() {
	const el = $id("setup-lyrics-status");
	const lines = data.originalLines;
	if (!Array.isArray(lines) || lines.length === 0) {
		el.textContent = "";
		el.hidden = true;
		return;
	}
	const matched = lines.filter((t) => t !== "").length;
	// 元歌詞の1行をまるごと採れた行と、行の途中で区切りを推定した行を分けて出す。
	// 「n/m行」だけだと、区切りがずれていても全行そのまま対応づいたように見える
	const whole = new Set((data.lyrics || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
	const guessed = lines.filter((t) => t !== "" && !whole.has(t.trim())).length;
	el.textContent = `対応づけ: ${matched}/${lines.length}行`
		+ (matched < lines.length ? "(対応づかなかった行は字幕に出ません)" : "")
		+ (guessed > 0 ? `(うち${guessed}行は行の途中で区切り)` : "");
	el.hidden = false;
}

// 入力を取り込んで対応づけ・保存・状態表示までやる
function applyLyrics(text) {
	data.lyrics = text;
	syncOriginalLines();
	saveData();
	renderLyricsStatus();
}

// 元歌詞欄を data に合わせて描き直す(初回・ホストの応答後)
function renderLyricsField() {
	const enabled = lyricsEnabled();
	$id("setup-lyrics-field").hidden = !enabled;
	$id("setup-lyrics").value =
		(enabled && typeof data.lyrics === "string") ? data.lyrics : "";
	renderLyricsStatus();
}

function openMidiDialog() {
	renderLyricsField();
	setSongStatus("");
	$id("editor-midi-dialog").showModal();
}

function closeMidiDialog() {
	$id("editor-midi-dialog").close();
}

// 「この設定で変換」。phrases → tokensList → unitsList → results の順に作り、
// 生成画面から「編集ツールで開く」で渡ってくるのと同じ形のデータにする
async function setupConvert() {
	if (!app || setupConverting) return;
	const progress = $id("setup-progress");
	setSetupBusy(true);
	progress.hidden = false;
	progress.textContent = "準備中...";
	// 親アプリ独自のパラメータ(ノート長重視α等)を消さないよう既存に重ねる
	data.param = Object.assign({}, data.param, paramControls.getParam());
	applyNoteLengthSetting();
	data.wordlist = pickedWordlistEntry();
	originalDraftEntry = null;
	facetsEnabled = hasFacets(data.wordlist);
	data.where = facetsEnabled
		? compileWhere($id("editor-facets"), data.wordlist)
		: undefined; // エントリ既定の where を使う
	let tokensList;
	let unitsList;
	try {
		await syncEngine();
		// tokensList は読み修正やホストの解析結果の正本。カナだけの phrases
		// から再解析すると、元歌詞の単語・文節境界と確定した読みが失われる。
		tokensList = Array.isArray(data.tokensList)
			&& data.tokensList.length === data.phrases.length
			&& data.tokensList.every(Array.isArray)
			? structuredClone(data.tokensList)
			: app.textAnalyzer.tokenizeTogether(data.phrases);
		unitsList = unitsListFromTokens(app, tokensList);
	} catch (err) {
		console.error(err);
		progress.textContent = "変換の準備に失敗しました: " + err.message;
		setSetupBusy(false);
		return;
	}
	progress.textContent = `変換中... 0/${data.phrases.length}`;
	app.soramimiMaker.generateFromTokens(
		tokensList, db, data.param,
		(result, i) => {
			progress.textContent = `変換中... ${i + 1}/${data.phrases.length}`;
		},
		(results) => {
			data.tokensList = tokensList;
			data.unitsList = unitsList;
			data.results = results.map((words) => generatedWords(words, data.wordlistSource));
			data.dirtyLines = []; // 変換直後はどの行も編集済みでない
			data.history = [];
			data.future = [];
			saveData();
			progress.hidden = true;
			setSetupBusy(false);
			leaveSetup();
			renderAll();
			updateHistoryButtons();
			$id("btn-regenerate").disabled = false;
		},
		null, noteLengthWeights());
}

function setupSetupScreen() {
	$id("btn-setup-convert").addEventListener("click", setupConvert);
	// 元歌詞は打鍵のたびに対応づけを走らせず、少し止まってからまとめて反映する
	const lyrics = $id("setup-lyrics");
	let lyricsTimer = null;
	lyrics.addEventListener("input", () => {
		clearTimeout(lyricsTimer);
		lyricsTimer = setTimeout(() => applyLyrics(lyrics.value), 300);
	});
	// 曲の選択・MIDIの持ち込みはホストへの依頼(選択即依頼)。
	// プレースホルダ("")やいまの曲を選び直しただけのときは何もしない
	$id("setup-song-select").addEventListener("change", () => {
		const id = $id("setup-song-select").value;
		if (!id || (data.song && data.song.id === id)) return;
		requestHostSong("song", id);
	});
	$id("btn-setup-song-upload").addEventListener("click", openMidiDialog);
	$id("btn-setup-midi-file").addEventListener("click", () => {
		requestHostSong("song-upload");
	});
	$id("btn-setup-midi-close").addEventListener("click", closeMidiDialog);
	$id("btn-setup-midi-done").addEventListener("click", closeMidiDialog);
	$id("btn-setup-back").addEventListener("click", () => {
		if (setupConverting) return;
		leaveSetup();
	});
}

async function copyResult() {
	const btn = $id("btn-copy");
	let text = makeResultText(data.results, $id("copy-format").value);
	// 末尾に使用単語の元表記(フルネーム等)を登場順で付ける。
	// filler(未変換=元歌詞のまま)は使った単語ではないので載せない
	const originals = [];
	for (const words of data.results) {
		for (const w of words || []) {
			if (w.filler) continue;
			originals.push(w.original || w.surface);
		}
	}
	if (originals.length > 0) {
		text += "\n使用単語一覧：\n" + originals.join("\n");
	}
	try {
		await writeClipboard(text);
		btn.textContent = "コピーしました";
	} catch (err) {
		console.error(err);
		btn.textContent = "コピーに失敗しました";
	}
	setTimeout(() => {
		btn.textContent = "コピー";
	}, 1500);
}

// ---- 読み込み・書き出し ----
// 編集状態をJSONファイルで持ち出し/再開できるようにする(#17)。
// soramimic-video などの外部ツールが生成した変換結果を編集する入口でもある。

export const EXPORT_FORMAT = "soramimic-editor/1";

// 読み込むデータの最低条件(生成画面からの受け渡しと同じ形)
export function validateEditorData(obj) {
	if (!obj || typeof obj !== "object") return "JSONオブジェクトではありません";
	if (!Array.isArray(obj.results)) return "results(行ごとの単語列)がありません";
	if (!Array.isArray(obj.unitsList)) return "unitsList(行ごとの発音ユニット列)がありません";
	if (obj.results.length !== obj.unitsList.length) {
		return "resultsとunitsListの行数が一致しません";
	}
	return null;
}

// ホスト固有の一時情報(host / hostRequest)は載せない。書き出しJSONは
// 単体の編集ツールでも読み直せる自己完結した内容だけにする
function exportPayload() {
	const payload = {
		format: EXPORT_FORMAT,
		phrases: data.phrases,
		tokensList: data.tokensList,
		results: data.results,
		param: data.param,
		wordlist: data.wordlist,
		wordlistSource: data.wordlistSource,
		where: data.where,
		unitsList: data.unitsList,
		// 生ノート長があるときは現在のαで再計算し、旧版向け互換値も古くしない。
		weightsList: noteLengthWeights(),
		noteLengthRawList: data.noteLengthRawList || null,
		noteLengthAlpha: data.noteLengthAlpha,
	};
	// 元歌詞(字幕用)は持っているときだけ載せる。ホストはこれを字幕に使う
	if (typeof data.lyrics === "string") payload.lyrics = data.lyrics;
	if (Array.isArray(data.originalLines)) payload.originalLines = data.originalLines;
	if (data.song?.title) payload.song = { title: data.song.title };
	return payload;
}

function exportData() {
	const payload = exportPayload();
	const blob = new Blob([JSON.stringify(payload, null, 1)], {
		type: "application/json",
	});
	const a = document.createElement("a");
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
	a.href = URL.createObjectURL(blob);
	a.download = `soramimic-edit-${stamp}.json`;
	a.click();
	URL.revokeObjectURL(a.href);
}

async function importFile(file) {
	let obj;
	try {
		obj = JSON.parse(await file.text());
	} catch (err) {
		alert("JSONの読み込みに失敗しました: " + err.message);
		return;
	}
	const problem = validateEditorData(obj);
	if (problem) {
		alert("読み込めないファイルです: " + problem);
		return;
	}
	// 履歴は持ち込まない。sessionStorageに入れてリロードすれば
	// 生成画面から開いたときと同じ起動フローに乗る
	delete obj.format;
	obj.history = [];
	obj.future = [];
	try {
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		alert("読み込んだデータの保存に失敗しました: " + err.message);
		return;
	}
	location.reload();
}

function setupImportExport() {
	const input = $id("import-file");
	input.addEventListener("change", () => {
		if (input.files && input.files[0]) importFile(input.files[0]);
		input.value = ""; // 同じファイルの再選択でもchangeが発火するように
	});
	for (const id of ["btn-import", "btn-import-empty"]) {
		const btn = $id(id);
		if (btn) btn.addEventListener("click", () => input.click());
	}
	const exportBtn = $id("btn-export");
	if (exportBtn) exportBtn.addEventListener("click", exportData);
	const videoBtn = $id("btn-video");
	videoBtn.hidden = !videoPeer || window.parent !== window;
	videoBtn.addEventListener("click", async () => {
		const status = $id("bridge-status");
		status.hidden = false;
		status.textContent = "ビデオへ歌詞を渡しています…";
		videoBtn.disabled = true;
		try {
			const payload = window.SoramimicBridge.portable(exportPayload());
			await window.SoramimicBridge.send(videoPeer, () => payload);
			status.textContent = "ビデオへ歌詞を渡しました。開いた画面で同じ曲の音源またはMIDIを選んでください。";
		} catch (error) { status.textContent = error.message; }
		finally { videoBtn.disabled = false; }
	});
}

// ---- 起動 ----

async function start() {
	const empty = $id("editor-empty");
	setupImportExport();
	setupReadingFixDialog();
	setupReverseSearch();

	try {
		data = JSON.parse(sessionStorage.getItem(EDITOR_STORAGE_KEY));
	} catch (err) {
		console.error("編集データの読み込みに失敗:", err);
	}
	if (!data || typeof data !== "object") {
		data = null; // 壊れたデータで編集操作が動かないように
		empty.hidden = false;
		return;
	}
	// 変換済みの results があれば従来どおり編集画面から開く(後方互換)。
	// 無ければ phrases(行ごとの歌詞)からブラウザで変換するセットアップ画面から始める。
	// ホストが setupFirst を立てていれば、results があってもセットアップ画面から
	const converted = hasResults();
	const convertible = Array.isArray(data.phrases) && data.phrases.length > 0;
	if (!converted && !convertible) {
		data = null;
		empty.hidden = false;
		return;
	}
	setupMode = !converted || data.setupFirst === true;
	{
		setupReviewToolbar(isVideoReview(data));
		const panel = $id("editor-panel");
		panel.addEventListener("cancel", (event) => {
			event.preventDefault();
			if (freeInputOpen) closeFreeInput();
			else setSelection(null);
		});
		panel.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			const controls = [...panel.querySelectorAll("button, input, summary")]
				.filter((node) => !node.disabled && node.getClientRects().length);
			const first = controls[0], last = controls.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault(); last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault(); first?.focus();
			}
		});
	}
	// 未変換でも以降の処理が同じ形を前提にできるよう、空配列で埋めておく
	if (!Array.isArray(data.results)) data.results = [];
	if (!Array.isArray(data.unitsList)) data.unitsList = [];
	normalizeParam();

	// 親アプリ(soramimic-video等)から渡る行ごとの位置別重み(任意フィールド)。
	// 配列でなければ「重みなし」として扱う(長さの検証はエンジン側がやる)
	if (!Array.isArray(data.weightsList)) delete data.weightsList;
	normalizeNoteLengthSetting();

	if (!Array.isArray(data.history)) data.history = [];
	if (!Array.isArray(data.future)) data.future = [];
	// 旧形式(resultsのみの配列)の履歴は捨てる
	data.history = data.history.filter((h) => h && h.results);
	data.future = data.future.filter((h) => h && h.results);
	// 編集行の記録がなければ全行を再計算対象にしておく(安全側)
	if (!Array.isArray(data.dirtyLines)) {
		data.dirtyLines = data.results.map((_, i) => i);
	}

	// 元歌詞(字幕用)は読み込み直後に行対応づけまで済ませておく。ホストはいつ
	// ペイロードを読んでも、いまの phrases に対応した originalLines を見られる
	if (lyricsEnabled()) {
		syncOriginalLines();
		saveData();
	}

	// まず読み取り専用のアライン表示を出し、候補機能は裏で初期化する
	renderAll();

	const toolbar = $id("editor-toolbar");
	toolbar.hidden = false;
	$id("btn-regenerate").disabled = true; // DB初期化が済むまで再生成は不可
	$id("btn-regenerate").addEventListener("click", () => regenerate().catch(showRegenerationError));
	$id("btn-copy").addEventListener("click", copyResult);
	$id("btn-undo").addEventListener("click", undo);
	$id("btn-redo").addEventListener("click", redo);
	updateHistoryButtons();
	setupSettingsPanel();
	setupSetupScreen();
	if (setupMode) enterSetup();

	const status = $id("editor-status");
	// セットアップ画面では準備中の表示もその中(#setup-progress)に出す
	if (setupMode) {
		$id("setup-progress").hidden = false;
		$id("setup-progress").textContent = "準備中...";
	} else {
		status.hidden = false;
	}
	try {
		// 生成画面の「音の合わせ方」(vowelRatio)を引き継いで候補計算を揃える
		const core = await initSoramimicApp({
			vowelRatio: data.param && data.param.VOWEL_RATIO,
		});
		app = core.app;
		appFor = core.appFor;
		engineVowelRatio = data.param?.VOWEL_RATIO;
		mecab = core.mecab;
		// 自作リストで来た(生成画面から/旧データ)場合は、DB構築に使う正規化CSVを
		// エントリに焼き付けてから組む。以後は localStorage を書き換えても
		// この編集セッションのDBはぶれず、書き出しJSONも自己完結する(csvText契約)
		if (data.wordlist && data.wordlist.value === "ORIGINAL"
			&& typeof data.wordlist.csvText !== "string") {
			data.wordlist = Object.assign({}, data.wordlist, {
				csvText: originalTextToCsv(
					localStorage.getItem(ORIGINAL_STORAGE_KEY) || "", app),
			});
			saveData();
		}
		// 生成時のファセット絞り込み(where)も引き継ぐ。旧データでwhereが
		// 無い場合はundefinedとなり、従来どおりエントリ既定のwhereが使われる
		// 単語リスト未指定でセットアップ画面から始めた場合はまだDBを組めない。
		// 「この設定で変換」の syncEngine() が、選ばれたリストで組む。
		// 編集画面から始めるのに単語リストが無いのは従来どおりエラー扱い
		if (!setupMode || data.wordlist) {
			db = await buildDatabase(app, data.wordlist, data.where);
			dbWhere = data.where;
			dbWordlistKey = wordlistKey(data.wordlist);
			data.wordlistSource = await wordlistSource(data.wordlist);
			saveData();
		}
		status.hidden = true;
		settingsReady = true;
		$id("btn-regenerate").disabled = !db;
		syncLineActions();
		scheduleReverseSearch();
		if (setupMode) {
			$id("setup-progress").hidden = true;
			// 初期化前に曲を選ぶ操作をしていたら、依頼中のロックは維持する
			syncSetupControls();
		}
		renderPanel(); // 読み込み中表示のパネルが開いていたら差し替える
		if (settingsDirty) saveSettings();
	} catch (err) {
		console.error(err);
		status.textContent = "候補機能の初期化に失敗しました: " + err.message;
		status.hidden = false;
		$id("setup-progress").hidden = true;
	}
}

setupEmbedNavigation();
setupReplacementPanel();
const initialization = (async () => {
	const status = $id("bridge-status");
	try {
		if (new URL(location.href).searchParams.has("lyrics-transfer")) {
			status.hidden = false;
			status.textContent = "ビデオから歌詞を受け取っています…";
		}
		const received = await window.SoramimicBridge.receive(videoPeer, (payload) => {
			const problem = validateEditorData(payload);
			if (problem) throw new Error(problem);
			sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(payload));
		});
		if (received) status.textContent = "ビデオの歌詞を読み込みました。";
	} catch (error) {
		status.hidden = false;
		status.textContent = error.message;
		// A failed handoff must not present an unrelated previous edit as this job.
		setupImportExport();
		$id("editor-empty").hidden = false;
		return;
	}
	await start();
})();
// The same-origin video host waits for completion before reading shared storage.
window.soramimicVideoReview = {
	async regenerateUnlocked() {
		let timer;
		try {
			await Promise.race([
				initialization,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("候補の準備に時間がかかっています。もう一度お試しください")), 60000);
				}),
			]);
		} finally { clearTimeout(timer); }
		if (!isVideoReview(data)) throw new Error("歌詞確認画面を開き直してください");
		if (regeneration) await regeneration;
		await regenerate({ allUnlocked: true });
	},
};
