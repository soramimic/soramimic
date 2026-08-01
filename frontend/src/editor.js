// 編集ツール(#17)のエントリ。
// ステップ1: アライン表示 / ステップ2: 候補選択・差し替え・自由入力 /
// ステップ3: 🔒固定+部分再生成、コピー /
// 以降: タップ・ドラッグ選択、候補グループ化・使用中表示・長押し詳細、戻る/進む
import "./style.css";
import "./editor.css";
import { initSoramimicApp, buildDatabase, ORIGINAL_STORAGE_KEY } from "./appCore.js";
import { originalTextToCsv } from "./wordlistInput.js";
import { fetchJson } from "./api.js";
import { makeResultText } from "./convert.js";
import { absorbSmallKana } from "./lib/kanaToSyllable.js";
import {
	createParamControls, valuesFromParam,
	hasFacets, renderFacets, compileWhere, restoreFacets,
} from "./convertControls.js";

export const EDITOR_STORAGE_KEY = "soramimic-editor";
const GROUP_PAGE = 30; // 「もっと見る」1回で増える候補グループ数
const GROUP_MAX = 100; // 候補グループの最大表示数
const RAW_FETCH = 300; // グループ化(同姓同名まとめ)前に取得する候補数
const HISTORY_MAX = 50; // 「戻る」履歴の上限
const LONG_PRESS_MS = 500; // 候補詳細を出す長押しの判定時間

let data = null;
// 候補提示の基盤(初期化完了までnull)。mecabは自由入力の読み付与に使う
let app = null;
let mecab = null;
let db = null;
let appFor = null; // 「音の合わせ方」別のエンジンを取り直すためのファクトリ
let currentVowelRatio = null; // いまの app を作った VOWEL_RATIO
let dbWhere = undefined; // いまの db を作った where(ファセット絞り込み)
let dbWordlistKey = null; // いまの db を作った単語リスト(wordlistKey)
let paramControls = null; // 変換設定パネルのパラメータUI(生成画面と共有)
let facetsEnabled = false; // 単語リストに facets があるときだけ絞り込みを出す
let wordlistCatalog = null; // value → エントリ(conf/setting.json 由来。取得失敗時null)
let reconverting = false; // 再変換中(多重実行を防ぐ)

// 選択中の範囲: {line, start, end}(endは排他)。単語チップ選択もperiodをこの形にする
let selection = null;
let anchorUnit = null; // Shiftクリック範囲選択の起点 {line, index}
let pendingUnit = null; // pointerdownしたユニット {line, index, x, y, slop}(タップ/ドラッグ未確定)
let dragging = false; // 移動量が閾値を超えたらドラッグ確定
let suppressClickUntil = 0; // ポインタ側で処理済みのタップのclickを二重処理しないための期限

let panelShown = GROUP_PAGE; // 表示中の候補グループ数(「もっと見る」で増える)
let openGroupKey = null; // 展開中の同名候補グループ(surface+kana)
let readingFixOpen = false; // 元歌詞の読み修正フォームの開閉

function $id(id) {
	return document.getElementById(id);
}

function saveData() {
	try {
		sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(data));
	} catch (err) {
		// 容量超過時は履歴を削って保存し直す(編集内容の保存を優先)
		console.warn("保存失敗、履歴を切り詰めます:", err);
		data.history = data.history.slice(-5);
		data.future = data.future.slice(-5);
		try {
			sessionStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(data));
		} catch (err2) {
			console.error(err2);
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
		// 変換設定も一緒に積むので、「この設定で再変換」も戻る1回で取り消せる。
		// 単語リストも含めるので、リスト切替(=固定の全解除+全行作り直し)も
		// 戻る1回で完全に元へ戻る。
		// where は undefined(=エントリ既定)と区別するため null にして持つ
		param: data.param,
		wordlist: data.wordlist,
		where: data.where === undefined ? null : data.where,
	}));
}

function restoreState(s) {
	data.results = s.results;
	data.tokensList = s.tokensList;
	data.unitsList = s.unitsList;
	// 旧セッションの履歴には設定が入っていないので、あるときだけ戻す
	if (s.param) data.param = s.param;
	if (s.wordlist) data.wordlist = s.wordlist;
	if ("where" in s) data.where = s.where === null ? undefined : s.where;
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
	if (appFor) syncEngine().then(() => renderPanel()).catch((err) => console.error(err));
}

// 編集した行を記録する。「固定以外を再生成」は編集の影響がありうる行だけを
// 計算し直す(それ以外の行は現在の単語を丸ごと固定してDPをスキップさせる)
function markDirty(line) {
	if (!data.dirtyLines.includes(line)) data.dirtyLines.push(line);
}

function updateHistoryButtons() {
	$id("btn-undo").disabled = data.history.length === 0;
	$id("btn-redo").disabled = data.future.length === 0;
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

function renderLine(line) {
	const units = unitsOf(line);
	const words = data.results[line] || [];
	const el = document.createElement("div");
	el.className = "editor-line";
	el.dataset.line = String(line);

	// 空行(改行だけの行)は行間スペーサとして表示する
	if (units.length === 0) {
		el.classList.add("editor-line-blank");
		return el;
	}

	const caption = document.createElement("div");
	caption.className = "editor-line-caption";
	caption.textContent = (data.phrases && data.phrases[line]) || "";
	el.appendChild(caption);

	// 1行 = 発音ユニット数分の列を持つグリッド。
	// 上段: 元歌詞のユニットチップ(1列ずつ)
	// 下段: 替え歌単語チップ(period[開始,終了) の列にまたがる)
	const grid = document.createElement("div");
	grid.className = "editor-grid";
	grid.style.gridTemplateColumns = `repeat(${units.length}, minmax(2.4em, max-content))`;

	const inSelection = (i) =>
		selection && selection.line === line && i >= selection.start && i < selection.end;

	// 読み修正フォームを開いている間は、実際に読みが変わるトークン範囲を
	// 選択とは別に薄く示す(選択自体はユニット単位のまま)。サブトークンを
	// 選んでも読み修正はトークン全体に及ぶため、その差分を可視化して明示する。
	const readingScope =
		readingFixOpen && selection && selection.line === line
			? tokenSpanForSelection(line, selection.start, selection.end)
			: null;
	const inReadingScope = (i) =>
		readingScope && i >= readingScope.unitStart && i < readingScope.unitEnd;

	units.forEach((unit, i) => {
		const chip = document.createElement("span");
		chip.className = "chip chip-unit";
		// 文節の切れ目を視覚的に示す
		if (i > 0 && unit.phrase !== units[i - 1].phrase) {
			chip.classList.add("phrase-start");
		}
		if (inSelection(i)) chip.classList.add("selected");
		if (inReadingScope(i) && !inSelection(i)) chip.classList.add("reading-scope");
		chip.textContent = unit.pronunciation;
		chip.title = unit.surface_form;
		chip.dataset.index = String(i);
		chip.style.gridRow = "1";
		chip.style.gridColumn = `${i + 1}`;
		chip.addEventListener("click", (e) => onUnitClick(line, i, e.shiftKey));
		chip.addEventListener("pointerdown", (e) => onUnitPointerDown(line, i, e));
		grid.appendChild(chip);
	});

	for (const word of words) {
		const chip = document.createElement("span");
		chip.className = "chip chip-word";
		// filler(未変換=元歌詞のまま)は破線グレーの控えめな見た目にする。
		// タップすれば通常の単語と同じように候補パネルが開き、差し替えられる
		if (word.filler) chip.classList.add("filler");
		if (word.locked) chip.classList.add("locked");
		if (selection && selection.line === line &&
			selection.start === word.period[0] && selection.end === word.period[1]) {
			chip.classList.add("selected");
		}
		chip.style.gridRow = "2";
		chip.style.gridColumn = `${word.period[0] + 1} / ${word.period[1] + 1}`;
		const surface = document.createElement("span");
		surface.className = "chip-word-surface";
		surface.textContent = word.surface;
		const kana = document.createElement("span");
		kana.className = "chip-word-kana";
		kana.textContent = word.kana;
		if (word.filler) {
			// 未変換なので表記と読みが同じ。二重に出さず、🔒(固定)も出さない
			// (元歌詞のままの区間を固定しても意味がないため)
			chip.append(surface);
			chip.title = wordDetail(word);
			attachLongPress(chip, () => wordDetail(word));
			chip.addEventListener("click", () => onWordClick(line, word));
			grid.appendChild(chip);
			continue;
		}
		const lock = document.createElement("button");
		lock.className = "chip-lock";
		lock.textContent = word.locked ? "🔒" : "🔓";
		lock.title = word.locked ? "固定を解除" : "この単語を固定";
		lock.addEventListener("click", (e) => {
			e.stopPropagation();
			toggleLock(line, word);
		});
		// 🔒への操作でチップの長押し(詳細表示)が誤発火しないようにする
		lock.addEventListener("pointerdown", (e) => e.stopPropagation());
		chip.append(surface, kana, lock);
		// PCはホバーで詳細(標準ツールチップ)、スマホは長押しでポップオーバー。
		// 候補パネルと同じく、どのidの単語かまで分かるようにする
		chip.title = wordDetail(word);
		attachLongPress(chip, () => wordDetail(word));
		chip.addEventListener("click", () => onWordClick(line, word));
		grid.appendChild(chip);
	}

	el.appendChild(grid);
	return el;
}

function rerenderLine(line) {
	const old = document.querySelector(`.editor-line[data-line="${line}"]`);
	if (!old) return;
	// 長い行の横スクロール位置を保つ(ドラッグ選択中の再描画で先頭に戻らないように)
	const scrollLeft = old.scrollLeft;
	const el = renderLine(line);
	old.replaceWith(el);
	el.scrollLeft = scrollLeft;
}

function renderAll() {
	const container = $id("editor-lines");
	container.textContent = "";
	data.results.forEach((_, i) => container.appendChild(renderLine(i)));
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
	readingFixOpen = false;
	const prev = selection;
	selection = next;
	if (prev) rerenderLine(prev.line);
	if (next && (!prev || prev.line !== next.line)) rerenderLine(next.line);
	// ドラッグ中はパネルを出さない。下部の行をドラッグ中にパネルが現れると
	// チップに覆い被さって、なぞっている位置がずれるため(表示はドラッグ終了時)
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
function onUnitClick(line, index, shift) {
	if (performance.now() < suppressClickUntil) return;
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

// 長い行で画面外までドラッグ選択できるよう、行の端に近づいたら自動スクロール
function autoScrollLine(e) {
	const lineEl = document.querySelector(`.editor-line[data-line="${pendingUnit.line}"]`);
	if (!lineEl || lineEl.scrollWidth <= lineEl.clientWidth) return;
	const r = lineEl.getBoundingClientRect();
	if (e.clientX > r.right - 36) lineEl.scrollLeft += 16;
	else if (e.clientX < r.left + 36) lineEl.scrollLeft -= 16;
}

function onDragMove(e) {
	if (!pendingUnit) return;
	if (!dragging) {
		const dx = e.clientX - pendingUnit.x;
		const dy = e.clientY - pendingUnit.y;
		if (dx * dx + dy * dy < pendingUnit.slop * pendingUnit.slop) return;
		dragging = true;
		anchorUnit = { line: pendingUnit.line, index: pendingUnit.index };
		// 開いていたパネルはドラッグ中は退ける(下の行のチップに覆い被さるため)。
		// パネルはfixedオーバーレイなので、消してもチップの位置はずれない
		$id("editor-panel").classList.remove("open");
	}
	autoScrollLine(e);
	// setSelectionで行が再描画されて要素が入れ替わるため、毎回座標から引き直す
	const el = document.elementFromPoint(e.clientX, e.clientY);
	const chip = el && el.closest(".chip-unit");
	if (!chip) return;
	const lineEl = chip.closest(".editor-line");
	if (!lineEl || Number(lineEl.dataset.line) !== pendingUnit.line) return;
	const index = Number(chip.dataset.index);
	const start = Math.min(pendingUnit.index, index);
	const end = Math.max(pendingUnit.index, index) + 1;
	if (selection && selection.line === pendingUnit.line &&
		selection.start === start && selection.end === end) return;
	setSelection({ line: pendingUnit.line, start, end });
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
		renderPanel(); // ドラッグ中に抑制していたパネルをここで出す
	} else if (pending && e.type === "pointerup") {
		unitTapAction(pending.line, pending.index); // タップはここで確定する
	}
}

// ---- 差し替え ----

// 選択範囲を候補単語(または自由入力単語)で差し替える。
// 範囲に重なる既存単語は取り除き、periodと元歌詞情報を付けて挿入する。
// 手で選んだ単語は再生成で消えないよう自動で固定する(🔓で解除可能)
function replaceSelection(word) {
	pushHistory();
	const { line, start, end } = selection;
	markDirty(line);
	const placed = Object.assign({}, word, {
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
	setSelection(null);
}

// 自由入力から結果単語オブジェクトを作る(読みはトークナイザで付与)
function makeCustomWord(text) {
	const yomi = mecab.getYomi(text) || text;
	return {
		id: "custom-" + Date.now(),
		surface: text,
		pronunciation: yomi,
		kana: yomi,
		original: text,
		sim: 0,
	};
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
	lines.push(String(word.id).startsWith("custom-") ? "自由入力" : "ID: " + word.id);
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

// 読みを修正し、ユニット列を作り直して後続単語のperiodをずらす。
// 修正範囲に重なっていた単語は読みが変わるため外す(再選択・再生成で入れ直せる)
function applyReadingFix(line, span, newYomiRaw) {
	// 手入力の読みも「ウッセェ」のような小書きカナを吸収してから使う
	// (単独の小書きは単語リスト側に存在せず、候補0件の行になってしまうため)
	const kata = absorbSmallKana(hiraToKata(newYomiRaw.trim()));
	if (kata === "" || !/^[ァ-ヴー]+$/.test(kata)) return false;
	// derive-before-commit: 正データ(tokensList)を書き換える前に、変更を反映した候補
	// トークン列を別に作り、そこからユニット導出まで通してから確定する。途中で導出が
	// 失敗しても正データ・履歴・unitsListを不整合なまま残さない(以前は先にpushHistory＆
	// pronunciation書き換えをしてから導出していたため、導出が投げるとtokensListだけ
	// 汚染され、undo/redoでその不整合が保存・再露出していた)。
	const tokens = data.tokensList[line].map((t) => Object.assign({}, t));
	if (span.arrEnd - span.arrStart === 1) {
		tokens[span.arrStart].pronunciation = kata;
		// 読みが変わると手動割当は陳腐化するので破棄(自動割当に戻す)
		delete tokens[span.arrStart].manualAlign;
	} else {
		// 複数トークンにまたがる場合は1トークンに束ねて読みを付け直す
		const merged = Object.assign({}, tokens[span.arrStart], {
			surface_form: tokens.slice(span.arrStart, span.arrEnd)
				.map((t) => t.surface_form).join(""),
			pronunciation: kata,
		});
		delete merged.manualAlign; // 束ね直したので旧割当は破棄
		tokens.splice(span.arrStart, span.arrEnd - span.arrStart, merged);
	}
	// 編集後のトークンからユニット列を導出し直す(tokensListを唯一の正とし、
	// 生成時と同じ関数で導出するので表示と再生成が一致する)。
	let derived;
	try {
		derived = app.textAnalyzer.getYomiAndPhraseBreak(tokens);
	} catch (e) {
		console.error("applyReadingFix: 読みの導出に失敗したため変更を中止しました", e);
		return false;
	}
	const newUnits = derived.map((u) => ({
		surface_form: u.surface_form,
		pronunciation: u.pronunciation,
		phrase: u.phrase,
	}));
	// ここから確定: 履歴を積んでから正データ(tokensList)を差し替える
	pushHistory();
	markDirty(line);
	data.tokensList[line] = tokens;
	const oldUnits = data.unitsList[line];
	const unitsAfter = oldUnits.length - span.unitEnd;
	const newSpanEnd = newUnits.length - unitsAfter;
	const delta = newSpanEnd - span.unitEnd;
	data.unitsList[line] = newUnits;
	data.results[line] = (data.results[line] || [])
		.filter((w) => w.period[1] <= span.unitStart || w.period[0] >= span.unitEnd)
		.map((w) => w.period[0] >= span.unitEnd
			? Object.assign({}, w, { period: [w.period[0] + delta, w.period[1] + delta] })
			: w);
	saveData();
	// 修正した範囲を選択し直す(新しい読みでの候補がそのまま出る)
	setSelection({ line, start: span.unitStart, end: newSpanEnd });
	return true;
}

// ---- 候補パネル ----

// 歌詞全体で使用中の単語id集合。差し替え対象(選択範囲に重なる単語)は除く
function usedIdSet(excludeLine, start, end) {
	const used = new Set();
	data.results.forEach((words, li) => {
		for (const w of words || []) {
			if (w.filler) continue; // fillerは実単語ではないので使用済みに数えない
			if (li === excludeLine && !(w.period[1] <= start || end <= w.period[0])) continue;
			used.add(w.id);
		}
	});
	return used;
}

// 選択中の行がパネルに隠れていたら、パネルの上に見えるまでスクロールする
// (タップした場所がパネルの裏に消えて見失わないように)
function ensureSelectionVisible(line) {
	const lineEl = document.querySelector(`.editor-line[data-line="${line}"]`);
	const panel = $id("editor-panel");
	if (!lineEl) return;
	const panelTop = window.innerHeight - panel.offsetHeight;
	const r = lineEl.getBoundingClientRect();
	if (r.bottom > panelTop - 8) {
		window.scrollBy({ top: r.bottom - (panelTop - 8), behavior: "smooth" });
	}
}

function renderPanel() {
	buildPanel();
	if (selection) ensureSelectionVisible(selection.line);
}

// ---- 表層↔モーラの手動割当 ----

// トークンの手動割当を設定/解除し、ユニット列を導出し直す。
// 割当はモーラ数を変えない(表層の帰属だけ変える)ので period はそのまま。
function applyManualAlign(line, arrIndex, align) {
	// applyReadingFix と同じ derive-before-commit。正データを書き換える前にコピー上で
	// ユニット導出まで通し、途中で投げても tokensList / unitsList / 履歴を不整合に
	// しない。
	const tokens = data.tokensList[line].map((t) => Object.assign({}, t));
	if (align) tokens[arrIndex].manualAlign = align;
	else delete tokens[arrIndex].manualAlign;
	let derived;
	try {
		derived = app.textAnalyzer.getYomiAndPhraseBreak(tokens);
	} catch (e) {
		console.error("applyManualAlign: 読みの導出に失敗したため変更を中止しました", e);
		return;
	}
	pushHistory();
	markDirty(line);
	data.tokensList[line] = tokens;
	data.unitsList[line] = derived.map((u) => ({
		surface_form: u.surface_form,
		pronunciation: u.pronunciation,
		phrase: u.phrase,
	}));
	saveData();
	rerenderLine(line);
	renderPanel();
}

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
function alignModel(line, arrIndex) {
	const tokens = data.tokensList[line];
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
function buildAlignEditor(line, arrIndex, model) {
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
		applyManualAlign(line, arrIndex, buildAlign(cs));
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
			left.textContent = "◀";
			left.title = "左の文字へ1モーラ寄せる";
			left.addEventListener("click", () => moveBoundary(i - 1, -1));
			const right = document.createElement("button");
			right.className = "btn align-arrow";
			right.textContent = "▶";
			right.title = "右の文字へ1モーラ寄せる";
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
		reset.textContent = "自動に戻す";
		reset.addEventListener("click", () => applyManualAlign(line, arrIndex, null));
		box.appendChild(reset);
	}
	return box;
}

function buildPanel() {
	const panel = $id("editor-panel");
	hidePopover();
	if (!selection) {
		// 中身は残したまま下へスライドアウトさせる
		panel.classList.remove("open");
		return;
	}
	panel.textContent = "";
	panel.classList.add("open");
	const { line, start, end } = selection;

	const header = document.createElement("div");
	header.className = "panel-header";
	const title = document.createElement("span");
	title.className = "panel-title";
	// 「元歌詞の読みを修正」表示や元歌詞(よみ)と同じ 表記(よみ) の並びに揃える
	title.textContent =
		`選択範囲: ${rangeSurface(line, start, end)}(${rangeKana(line, start, end)})`;
	header.appendChild(title);
	// 選択範囲がそのまま既存単語なら、パネルからも固定を切り替えられるようにする
	// (チップ上の🔒はスマホだと小さいため)
	const word = (data.results[line] || []).find(
		(w) => w.period[0] === start && w.period[1] === end);
	if (word) {
		const lockBtn = document.createElement("button");
		lockBtn.className = "btn panel-lock";
		lockBtn.textContent = word.locked ? "🔒 固定を解除" : "🔓 固定する";
		lockBtn.addEventListener("click", () => toggleLock(line, word));
		header.appendChild(lockBtn);
	}
	const close = document.createElement("button");
	close.className = "btn panel-close";
	close.textContent = "✕";
	close.addEventListener("click", () => setSelection(null));
	header.appendChild(close);
	panel.appendChild(header);

	// 自由入力
	const free = document.createElement("div");
	free.className = "panel-free";
	const input = document.createElement("input");
	input.className = "input";
	input.placeholder = "自由入力で差し替え(読みは自動付与)";
	const apply = document.createElement("button");
	apply.className = "btn btn-primary";
	apply.textContent = "差し替え";
	apply.disabled = !db;
	const applyFree = () => {
		const text = input.value.trim();
		if (text === "") return;
		replaceSelection(makeCustomWord(text));
	};
	apply.addEventListener("click", applyFree);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") applyFree();
	});
	free.append(input, apply);

	// 元歌詞の読み修正(読み推定ミスをここで直せる)。対象はトークン境界にスナップ。
	// 「元の読みを直す」→「差し替えを選ぶ」の流れが自然なので、自由入力より上に置く
	const span = db ? tokenSpanForSelection(line, start, end) : null;
	if (span) {
		const yomiRow = document.createElement("div");
		yomiRow.className = "panel-yomi";
		if (!readingFixOpen) {
			const toggle = document.createElement("button");
			toggle.className = "btn panel-yomi-toggle";
			toggle.textContent = `元歌詞の読みを修正: ${span.surface}(${span.yomi})`;
			toggle.addEventListener("click", () => {
				readingFixOpen = true;
				rerenderLine(line); // 読みが変わるトークン範囲をチップ側にも反映
				renderPanel();
			});
			yomiRow.appendChild(toggle);
		} else {
			const label = document.createElement("span");
			label.className = "panel-yomi-label";
			label.textContent = `「${span.surface}」の読み:`;
			const yomiInput = document.createElement("input");
			yomiInput.className = "input";
			yomiInput.value = span.yomi;
			const yomiApply = document.createElement("button");
			yomiApply.className = "btn btn-primary";
			yomiApply.textContent = "修正";
			const note = document.createElement("span");
			note.className = "panel-yomi-note";
			const applyYomi = () => {
				if (!applyReadingFix(line, span, yomiInput.value)) {
					note.textContent = "かなで入力してください";
				}
			};
			yomiApply.addEventListener("click", applyYomi);
			yomiInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") applyYomi();
			});
			yomiRow.append(label, yomiInput, yomiApply, note);
		}
		panel.appendChild(yomiRow);
	}

	// 表層↔モーラの手動割当(選択が単一の漢字系トークンのときのみ)。読みの微調整の
	// 一種なので、パネルのごちゃつきを避けて「読みを修正」を開いた時だけ出す。
	if (readingFixOpen && span && span.arrEnd - span.arrStart === 1) {
		const model = alignModel(line, span.arrStart);
		if (model) panel.appendChild(buildAlignEditor(line, span.arrStart, model));
	}

	// 差し替え手段(自由入力)は読み修正の下・候補リストの直上にまとめる
	panel.appendChild(free);

	if (!db) {
		const note = document.createElement("p");
		note.className = "panel-note";
		note.textContent = "候補を読み込み中...(単語リスト初期化中)";
		panel.appendChild(note);
		return;
	}

	// 候補の取得と同姓同名(表記+読みが同じでidが違う)のグループ化。
	// 単語重複なしの判定はid単位なので、同名でも別idはそれぞれ選べるようにする
	const target = unitsOf(line).slice(start, end).map((u) => u.pronunciation);
	// 位置別の重み(親アプリから渡る weightsList。ノート長重視など)があれば、
	// 選択範囲に対応する区間を切り出して候補計算にも効かせる
	const rangeWeights = data.weightsList && Array.isArray(data.weightsList[line])
		? data.weightsList[line].slice(start, end)
		: null;
	const fetched = app.soramimiMaker.getCandidates(db, target, data.param, RAW_FETCH, rangeWeights);
	const used = usedIdSet(line, start, end);
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
		renderGroupPicker(panel, byKey.get(openGroupKey), used);
		return;
	}

	const list = document.createElement("div");
	list.className = "panel-candidates";
	const shown = groups.slice(0, Math.min(panelShown, GROUP_MAX));
	if (shown.length === 0) {
		const note = document.createElement("p");
		note.className = "panel-note";
		note.textContent = "候補が見つかりませんでした。自由入力をお使いください。";
		list.appendChild(note);
	}
	for (const g of shown) {
		const cand = g.cands[0];
		const allUsed = g.cands.every((c) => used.has(c.id));
		const btn = document.createElement("button");
		btn.className = "btn candidate";
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
		if (g.cands.length === 1) {
			btn.title = candidateDetail(cand, used.has(cand.id));
			attachLongPress(btn, () => candidateDetail(cand, used.has(cand.id)));
			btn.addEventListener("click", () => replaceSelection(cand));
		} else {
			btn.title = `${g.cands.length}件の同名候補(タップして選ぶ)`;
			attachLongPress(btn, () =>
				`${g.cands.length}件の同名候補:\n` +
				g.cands.slice(0, 8).map((c) => c.original || c.surface).join("\n") +
				(g.cands.length > 8 ? "\n…" : ""));
			btn.addEventListener("click", () => {
				openGroupKey = g.key;
				renderPanel();
			});
		}
		list.appendChild(btn);
	}
	if (groups.length > shown.length && shown.length < GROUP_MAX) {
		const more = document.createElement("button");
		more.className = "btn panel-more";
		more.textContent =
			`もっと見る(${shown.length}/${Math.min(groups.length, GROUP_MAX)}件表示中)`;
		more.addEventListener("click", () => {
			panelShown += GROUP_PAGE;
			renderPanel();
		});
		list.appendChild(more);
	}
	panel.appendChild(list);
}

// 同名候補(id違い)の個別選択リスト
function renderGroupPicker(panel, group, used) {
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
		if (isUsed) row.classList.add("used");
		const main = document.createElement("span");
		main.textContent = cand.original || cand.surface;
		const sub = document.createElement("span");
		sub.className = "group-entry-sub";
		sub.textContent = `#${cand.id}・${isUsed ? "使用中" : "未使用"}`;
		row.append(main, sub);
		row.title = candidateDetail(cand, isUsed);
		attachLongPress(row, () => candidateDetail(cand, isUsed));
		row.addEventListener("click", () => replaceSelection(cand));
		list.appendChild(row);
	}
	panel.appendChild(list);
}

// ---- 再生成・コピー ----

// 🔒固定した単語(と差し替え済み単語)を残し、それ以外を作り直す
function regenerate() {
	if (reconverting) return;
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
		(words || []).filter((w) => !w.filler && (atRisk(i) ? w.locked : true)));
	btn.disabled = true;
	progress.hidden = false;
	progress.textContent = `再生成中... 0/${data.results.length}`;
	setSelection(null);
	app.soramimiMaker.generateFromTokens(
		data.tokensList, db, data.param,
		(result, i) => {
			progress.textContent = `再生成中... ${i + 1}/${data.results.length}`;
		},
		(results) => {
			pushHistory();
			data.results = results;
			data.dirtyLines = []; // 再生成直後はどの行も編集済みでない
			saveData();
			renderAll();
			btn.disabled = false;
			progress.hidden = true;
		},
		locksPerLine, data.weightsList || null);
}

// ---- 「変換のしかた」モーダル(パラメータ・絞り込み) ----
// 生成画面へ戻らなくても変換のしかたを変えられるようにする(#17の続き)。
// ツールバーの⚙から開くモーダル(dialog)で、パラメータUIは生成画面と同じ
// 共有部品(convertControls.js)。初期値は引き継いだ data.param から逆算する

// 単語リストエントリの同一性キー。自作リストは中身(正規化CSV)まで含めて
// 比較する(テキストを書き換えたら別のリスト扱いにするため)
function wordlistKey(entry) {
	if (!entry) return "";
	if (entry.value === "ORIGINAL") return "ORIGINAL\t" + (entry.csvText || "");
	return [entry.value, entry.filepath, entry.dbtype].join("\t");
}

// 候補計算に使うエンジンとDBを、現在の data.param / data.wordlist / data.where に合わせる。
// 「音の合わせ方」は類似度行列そのものが変わるためエンジンを取り直し、
// 単語リストか絞り込み(where)が変わったら単語リストDBを作り直す
async function syncEngine() {
	if (!appFor) return;
	const ratio = data.param && data.param.VOWEL_RATIO;
	if (ratio !== currentVowelRatio) {
		app = appFor(ratio);
		currentVowelRatio = ratio;
	}
	const key = wordlistKey(data.wordlist);
	if (data.where !== dbWhere || key !== dbWordlistKey) {
		db = await buildDatabase(app, data.wordlist, data.where);
		dbWhere = data.where;
		dbWordlistKey = key;
	}
}

// 表示を現在の data.param / data.wordlist / data.where に合わせ直す(戻る/進むのあと)。
// モーダルが閉じていてもDOMは生きているので、次に開いたときに正しい表示になる
function syncSettingsUi() {
	if (!paramControls) return;
	paramControls.setValues(valuesFromParam(data.param));
	paramControls.syncPreset();
	syncWordlistUi();
}

// 単語リスト選択・自作リストの編集欄・ファセットを data.wordlist / data.where に
// 合わせ直す。単語リストの選択UIは conf が取れた環境にしか無いので、
// 無ければファセットだけ面倒を見る
function syncWordlistUi() {
	const entry = data.wordlist || {};
	const sel = $id("editor-wordlist");
	if (wordlistCatalog && sel) {
		if (entry.value) sel.value = entry.value;
		$id("editor-original-text").hidden = entry.value !== "ORIGINAL";
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

// 単語リストの選択が変わったとき。適用はしない(「この設定で再変換」に集約)。
// ファセットだけは新しいリストのもので組み直す(チェックは既定に戻る)
function onWordlistChange() {
	const entry = wordlistCatalog && wordlistCatalog.get($id("editor-wordlist").value);
	if (!entry) return;
	$id("editor-original-text").hidden = entry.value !== "ORIGINAL";
	facetsEnabled = hasFacets(entry);
	$id("editor-facet-field").hidden = !facetsEnabled;
	renderFacets($id("editor-facets"), entry);
	// いま適用中のリストへ選び直しただけなら、現在の絞り込みを保つ
	// (選び直しで絞り込みが黙って既定に戻るのを避ける)
	if (facetsEnabled && entry.value === (data.wordlist && data.wordlist.value)) {
		restoreFacets($id("editor-facets"), data.where);
	}
}

// いま選択されている単語リストのエントリ。自作リストのときは編集欄の内容を
// 正規化CSVにして持たせる(csvText契約: 書き出しJSONを自己完結させる)
function pickedWordlistEntry() {
	const sel = $id("editor-wordlist");
	const picked = wordlistCatalog && sel && wordlistCatalog.get(sel.value);
	if (!picked) return data.wordlist;
	if (picked.value !== "ORIGINAL") return Object.assign({}, picked);
	return {
		value: "ORIGINAL",
		text: picked.text,
		csvText: originalTextToCsv($id("editor-original-text").value, app),
	};
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
	addOption(sel, { value: "ORIGINAL", text: "自作リスト" });
	wordlistCatalog = catalog;

	const ta = $id("editor-original-text");
	// 自作リストの内容は生成画面と共有する(localStorage)
	ta.value = localStorage.getItem(ORIGINAL_STORAGE_KEY) || "";
	ta.addEventListener("input", () => {
		try {
			localStorage.setItem(ORIGINAL_STORAGE_KEY, ta.value);
		} catch (err) {
			console.warn("自作リストの保存に失敗:", err);
		}
	});
	sel.addEventListener("change", onWordlistChange);
	syncWordlistUi();
	$id("editor-wordlist-field").hidden = false;
}

function setReconverting(busy) {
	reconverting = busy;
	$id("btn-regenerate").disabled = busy || !db;
	// 再変換中に⚙からモーダルを開いても設定をいじれないようにする。
	// 閉じる操作だけは残したいので×は対象外
	for (const el of $id("editor-settings").querySelectorAll("button, input, select, textarea")) {
		if (el.id === "btn-settings-close") continue;
		el.disabled = busy;
	}
	$id("btn-reconvert").disabled = busy || !db;
}

// モーダルの設定で全行を変換し直す。固定(🔒)した単語だけは持ち越すので、
// 差し替えた単語は残る(未固定の手編集は作り直される)。直前の状態は
// 結果・パラメータ・単語リスト・絞り込みをまとめて履歴に積むので、
// 「↩ 戻る」1回で戻せる。
// 単語リストの切替もここで適用する(select単体では再変換しない)。リストが
// 変わったときだけは固定を全解除して全行を作り直す: 別リストの単語を持ち越すと
// idが衝突して単語重複なしの判定が壊れるため
async function reconvertAll() {
	if (!app || !db || !paramControls || reconverting) return;
	const progress = $id("reconvert-progress");
	const nextEntry = pickedWordlistEntry();
	const listChanged = wordlistKey(nextEntry) !== wordlistKey(data.wordlist);
	setReconverting(true);
	progress.hidden = false;
	progress.textContent = `再変換中... 0/${data.results.length}`;
	setSelection(null);
	pushHistory();
	// 親アプリ独自のパラメータ(ノート長重視α等)を消さないよう既存に重ねる
	data.param = Object.assign({}, data.param, paramControls.getParam());
	if (listChanged) {
		data.wordlist = nextEntry;
		facetsEnabled = hasFacets(nextEntry);
	}
	if (facetsEnabled) data.where = compileWhere($id("editor-facets"), data.wordlist);
	else if (listChanged) data.where = undefined; // 新しいリストのエントリ既定に戻す
	try {
		await syncEngine();
	} catch (err) {
		console.error(err);
		restoreState(data.history.pop()); // 設定ごと巻き戻す
		updateHistoryButtons();
		syncSettingsUi();
		progress.textContent = "単語リストの再構築に失敗しました: " + err.message;
		setReconverting(false);
		return;
	}
	// 固定単語は新しい絞り込みの対象外になっていても固定のまま渡す。
	// ただしリストごと変わったときは持ち越さない(idが別リストのものになるため)
	// filler(未変換の区間)は持ち越さず、新しい設定で埋め直しを試みる
	const locksPerLine = listChanged
		? data.results.map(() => [])
		: data.results.map((words) => (words || []).filter((w) => w.locked && !w.filler));
	app.soramimiMaker.generateFromTokens(
		data.tokensList, db, data.param,
		(result, i) => {
			progress.textContent = `再変換中... ${i + 1}/${data.results.length}`;
		},
		(results) => {
			data.results = results;
			data.dirtyLines = []; // 全行を作り直したので編集済みの行はない
			saveData();
			renderAll();
			progress.hidden = true;
			setReconverting(false);
		},
		locksPerLine, data.weightsList || null);
}

// 絞り込みは選択即実行。チェックの連打をまとめるため少しだけ待ってから走らせる。
// 単語リストの切替が保留されていれば、それも一緒に適用される(絞り込みだけを
// 古いリストに対して当てても意味のある結果にならないため)
let facetTimer = null;
function onFacetChange() {
	if (!facetsEnabled) return;
	clearTimeout(facetTimer);
	facetTimer = setTimeout(reconvertAll, 400);
}

function setupSettingsPanel() {
	const dialog = $id("editor-settings");
	if (!dialog) return;
	paramControls = createParamControls({
		paramArea: $id("editor-param-area"),
		presetArea: $id("editor-preset-buttons"),
		duplicateArea: $id("editor-duplicate-buttons"),
		values: valuesFromParam(data.param),
	});
	// 絞り込みは単語リスト設定に facets があるときだけ(自作リスト等では出さない)。
	// リスト切替で出たり消えたりするので、リスナはコンテナに固定で付けておく
	syncWordlistUi();
	$id("editor-facets").addEventListener("change", onFacetChange);
	// 単語リストの選択肢は conf の取得を待つので、あとから足す
	setupWordlistPicker().catch((err) => console.error(err));
	// 再変換の進捗はツールバー側(#reconvert-progress)に出るので、押したら閉じる。
	// モーダルに隠れて進捗が見えない状態を作らないため
	$id("btn-reconvert").addEventListener("click", () => {
		dialog.close();
		reconvertAll();
	});
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

// Clipboard APIはHTTPS(または localhost)でしか使えないため、
// LAN実機確認のようなhttp環境ではテキストエリア+execCommandで代替する
async function writeClipboard(text) {
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.focus();
	ta.select();
	const ok = document.execCommand("copy");
	ta.remove();
	if (!ok) throw new Error("クリップボードに書き込めませんでした");
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

function exportData() {
	const payload = {
		format: EXPORT_FORMAT,
		phrases: data.phrases,
		tokensList: data.tokensList,
		results: data.results,
		param: data.param,
		wordlist: data.wordlist,
		where: data.where,
		unitsList: data.unitsList,
		weightsList: data.weightsList || null,
	};
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
}

// ---- 起動 ----

async function start() {
	const empty = $id("editor-empty");
	setupImportExport();

	try {
		data = JSON.parse(sessionStorage.getItem(EDITOR_STORAGE_KEY));
	} catch (err) {
		console.error("編集データの読み込みに失敗:", err);
	}
	if (!data || !Array.isArray(data.results) || !Array.isArray(data.unitsList)) {
		data = null; // 壊れたデータで編集操作が動かないように
		empty.hidden = false;
		return;
	}
	// 旧セッション/旧エクスポートの param には母音・子音の掛け算ハック
	// (SAME_VOWEL_REWARD:0.2 / SAME_CONSONANT_REWARD:0.9)が残っていることがある。
	// 現行の monophoneタイブレーク行列(#102)ではこのハックはスコアを汚すため除去する
	// (未指定=lib既定1で無効化)。VOWEL_RATIO 未指定は現行既定 0.8 とみなす。
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

	// 親アプリ(soramimic-video等)から渡る行ごとの位置別重み(任意フィールド)。
	// 配列でなければ「重みなし」として扱う(長さの検証はエンジン側がやる)
	if (!Array.isArray(data.weightsList)) delete data.weightsList;

	if (!Array.isArray(data.history)) data.history = [];
	if (!Array.isArray(data.future)) data.future = [];
	// 旧形式(resultsのみの配列)の履歴は捨てる
	data.history = data.history.filter((h) => h && h.results);
	data.future = data.future.filter((h) => h && h.results);
	// 編集行の記録がなければ全行を再計算対象にしておく(安全側)
	if (!Array.isArray(data.dirtyLines)) {
		data.dirtyLines = data.results.map((_, i) => i);
	}

	// まず読み取り専用のアライン表示を出し、候補機能は裏で初期化する
	renderAll();

	const toolbar = $id("editor-toolbar");
	toolbar.hidden = false;
	$id("btn-regenerate").disabled = true; // DB初期化が済むまで再生成は不可
	$id("btn-regenerate").addEventListener("click", regenerate);
	$id("btn-copy").addEventListener("click", copyResult);
	$id("btn-undo").addEventListener("click", undo);
	$id("btn-redo").addEventListener("click", redo);
	updateHistoryButtons();
	setupSettingsPanel();

	const status = $id("editor-status");
	status.hidden = false;
	try {
		// 生成画面の「音の合わせ方」(vowelRatio)を引き継いで候補計算を揃える
		const core = await initSoramimicApp({
			vowelRatio: data.param && data.param.VOWEL_RATIO,
		});
		app = core.app;
		appFor = core.appFor;
		currentVowelRatio = data.param && data.param.VOWEL_RATIO;
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
		db = await buildDatabase(app, data.wordlist, data.where);
		dbWhere = data.where;
		dbWordlistKey = wordlistKey(data.wordlist);
		status.hidden = true;
		$id("btn-regenerate").disabled = false;
		$id("btn-reconvert").disabled = false;
		renderPanel(); // 読み込み中表示のパネルが開いていたら差し替える
	} catch (err) {
		console.error(err);
		status.textContent = "候補機能の初期化に失敗しました: " + err.message;
	}
}

start();
