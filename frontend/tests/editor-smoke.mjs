// 編集ツール(#17)のE2Eスモークテスト: ビルド済みアプリを実ブラウザで駆動し、
// 「変換 → 編集ツールを開く → 読み修正 → 候補差し替え → 再生成 → 戻る → コピー」
// の編集フロー一式が生きていることを確認する。
// 実行: npm run build && node tests/editor-smoke.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4299;

function waitForServer(url, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		(async function poll() {
			try {
				const res = await fetch(url);
				if (res.ok) return resolve();
			} catch {}
			if (Date.now() - started > timeoutMs) {
				return reject(new Error("preview server did not start"));
			}
			setTimeout(poll, 300);
		})();
	});
}

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

// detached + プロセスグループkillで、子のviteプロセスも確実に始末する
const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
	stdio: "ignore",
	detached: true,
});

let exitCode = 1;
try {
	await waitForServer(`http://localhost:${PORT}/`);
	const browser = await chromium.launch();
	const context = await browser.newContext();
	// 外部リクエスト(読みAPI・GA等)を遮断し、常にkuromojiフォールバックの
	// 決定的なトークナイズでテストする
	await context.route(
		(url) => url.hostname !== "localhost",
		(route) => route.abort(),
	);
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e));

	// ---- 生成画面: 変換して編集ツールを開く ----
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		undefined, { timeout: 60000 },
	);
	// 「故郷」は読みがコキョーと推定される(読み修正のテスト対象)。2行目の
	// 複数桁数字は、仮読みからジュウニへ修正する回帰テストに使う。
	await page.fill("#input-text", "忘れがたき故郷\n深夜12時をすぎたって\n漢字");
	await page.click("#btn-convert");
	await page.waitForFunction(
		() => {
			const out = document.getElementById("output-text");
			return !document.getElementById("output-field").hidden && out.value.length > 0;
		},
		undefined, { timeout: 120000 },
	);

	const [editor] = await Promise.all([
		context.waitForEvent("page"),
		page.click("#btn-open-editor"),
	]);
	editor.on("pageerror", (e) => pageErrors.push(e));

	// ---- 編集画面: アライン表示と初期化完了(候補DB構築)を待つ ----
	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 60000 });
	assert(await editor.inputValue("#copy-format") === "4",
		"編集画面の既定コピー形式が対応区切りではない");
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);
	assert(await editor.locator("#editor-hint").count() === 0,
		"冒頭の操作説明が残っている");
	const rowLabels = await editor.$$eval(".editor-line:first-child .editor-row-label",
		(els) => els.map((e) => e.textContent));
	assert(JSON.stringify(rowLabels) === JSON.stringify(["元歌詞の読み", "替え歌"]),
		"行の役割がラベルで示されていない: " + JSON.stringify(rowLabels));
	assert(await editor.textContent("#btn-regenerate") === "固定中以外を再生成",
		"再生成ボタンから固定単語の扱いが分からない");
	const kanaBefore = await editor.$$eval(".chip-unit", (els) => els.map((e) => e.textContent).join(""));
	assert(kanaBefore === "ワスレガタキコキョーシンヤイチニジヲスギタッテカンジ",
		"アライン表示の読みが想定外: " + kanaBefore);

	// 替え歌単語チップの詳細(ホバーの標準ツールチップ)にidまで含まれること
	const wordTitle = await editor.getAttribute(".chip-word", "title");
	assert(wordTitle && wordTitle.includes("→") && wordTitle.includes("ID:"),
		"替え歌単語チップの詳細が想定外: " + wordTitle);

	// 固定操作は3行目を増やさず、単語と同じ行の鍵アイコンで完結する
	const firstWord = editor.locator(".chip-word:not(.filler)").first();
	assert(await firstWord.locator(":scope > .chip-word-main + .chip-word-kana").count() === 1,
		"単語チップが表記／読みの2行構造になっていない");
	const chipRows = await firstWord.evaluate((el) => {
		const surface = el.querySelector(".chip-word-surface").getBoundingClientRect();
		const kana = el.querySelector(".chip-word-kana").getBoundingClientRect();
		const lock = el.querySelector(".chip-lock").getBoundingClientRect();
		return {
			surfaceTop: surface.top, surfaceBottom: surface.bottom,
			kanaTop: kana.top, lockCenter: lock.top + lock.height / 2,
		};
	});
	assert(chipRows.kanaTop >= chipRows.surfaceBottom - 1,
		"表記と読みが2段に並んでいない: " + JSON.stringify(chipRows));
	assert(chipRows.lockCenter >= chipRows.surfaceTop - 2 &&
		chipRows.lockCenter <= chipRows.surfaceBottom + 2,
		"固定アイコンが3段目に配置されている: " + JSON.stringify(chipRows));
	const firstLock = firstWord.locator(".chip-lock-input");
	const initiallyLocked = await firstLock.isChecked();
	const iconState = () => firstWord.evaluate((el) => ({
		open: getComputedStyle(el.querySelector(".chip-lock-icon-open")).display !== "none",
		closed: getComputedStyle(el.querySelector(".chip-lock-icon-closed")).display !== "none",
	}));
	const iconBefore = await iconState();
	assert(iconBefore.open === !initiallyLocked && iconBefore.closed === initiallyLocked,
		"固定状態と鍵アイコンが一致しない: " + JSON.stringify(iconBefore));
	await firstLock.click();
	assert(await firstWord.locator(".chip-lock-input").isChecked() === !initiallyLocked,
		"鍵アイコンで固定状態を切り替えられない");
	const iconAfter = await iconState();
	assert(iconAfter.open === initiallyLocked && iconAfter.closed === !initiallyLocked,
		"固定切り替え後に鍵の形が変わらない: " + JSON.stringify(iconAfter));
	assert(await firstWord.evaluate((el) => el.classList.contains("locked")) === !initiallyLocked,
		"鍵アイコンと固定中の見た目が一致しない");
	assert(await firstWord.locator(".chip-lock-input").evaluate((el) => el === document.activeElement),
		"固定切り替え後に鍵アイコンからフォーカスが失われた");
	assert(!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))),
		"鍵アイコンの押下で候補パネルが開いた");
	await firstWord.locator(".chip-lock-input").click(); // 初期状態へ戻す

	// 選択パネルもチップと同じ単色の開錠／施錠アイコンを使う
	await firstWord.click();
	await editor.waitForSelector(".editor-panel.open .panel-lock");
	const panelLock = editor.locator(".panel-lock");
	assert(!/[🔒🔓]/u.test(await panelLock.textContent()),
		"選択パネルに絵文字の鍵が残っている");
	assert(await panelLock.locator(".chip-lock-icon").count() === 1,
		"選択パネルに共通の鍵アイコンがない");
	const panelInitiallyLocked = await panelLock.getAttribute("aria-pressed") === "true";
	await panelLock.click();
	assert((await editor.locator(".panel-lock").getAttribute("aria-pressed") === "true") === !panelInitiallyLocked,
		"選択パネルから固定状態を切り替えられない");
	const panelIconAfter = await editor.locator(".panel-lock").evaluate((el) => ({
		open: getComputedStyle(el.querySelector(".chip-lock-icon-open")).display !== "none",
		closed: getComputedStyle(el.querySelector(".chip-lock-icon-closed")).display !== "none",
	}));
	assert(panelIconAfter.open === panelInitiallyLocked && panelIconAfter.closed === !panelInitiallyLocked,
		"選択パネルの鍵の形が固定状態に追従しない: " + JSON.stringify(panelIconAfter));
	await editor.locator(".panel-lock").click(); // 初期状態へ戻す
	await editor.locator(".panel-close").click();

	// ---- 自由入力は通常時には畳み、歌詞と読みを一緒に確定できる ----
	await editor.locator('.editor-line[data-line="0"] .chip-unit').first().click();
	assert(await editor.locator(".panel-free-surface").count() === 0,
		"希少な自由入力欄が最初から表示されている");
	const beforeFree = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	await editor.click(".panel-free-toggle");
	await editor.fill(".panel-free-surface", "あ");
	await editor.fill(".panel-free-reading", "あ");
	assert(await editor.evaluate(() => document.activeElement?.matches(".panel-free-reading")),
		"自由入力の読み欄を編集できない");
	const afterFreeDraft = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	assert(afterFreeDraft === beforeFree,
		"自由入力の確定前に編集結果が変更された");
	await editor.click(".panel-free-apply");
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	const custom = await editor.evaluate(() =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")).results.flat()
			.find((w) => w.surface === "あ" && w.locked));
	assert(custom && String(custom.id).startsWith("custom-") && custom.kana === "ア" &&
		Array.isArray(custom.pronunciation),
		"自由入力の歌詞と読みがcustom語として保存されない: " + JSON.stringify(custom));
	await editor.click("#btn-undo");
	await editor.waitForTimeout(300);

	// ---- 回帰ガード: 複数桁数字の読み修正で拗音を分割しない ----
	// 12は1トークンだが、表示上は複数ユニット。どれをタップしても対象全体が
	// 12(イチニ)へスナップし、ジュウニへの修正後もジュウ/ニの2音節になる。
	await editor.locator('.editor-line[data-line="1"] .chip-unit').nth(2).click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const numberEditLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	assert(numberEditLabel.includes("12") && numberEditLabel.includes("イチニ"),
		"複数桁数字が読み修正の対象になっていない: " + numberEditLabel);
	assert(await editor.textContent(".panel-yomi-toggle") === "✏️",
		"元歌詞の読み修正が鉛筆だけの表示になっていない");
	assert((await editor.getAttribute(".panel-yomi-toggle", "aria-label")).includes("読みを修正"),
		"鉛筆に読み修正のアクセシブルな名前がない");
	const numberPanelBefore = await editor.evaluate(() => ({
		surface: document.querySelector(".panel-original-surface")?.textContent,
		reading: document.querySelector(".panel-original-reading")?.textContent,
		selected: [...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit.selected')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	const numberTokensBeforeDialog = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList));
	await editor.click(".panel-yomi-toggle");
	assert(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open),
		"読み修正専用の小窓が開かない");
	const numberPanelWhileDialog = await editor.evaluate(() => ({
		surface: document.querySelector(".panel-original-surface")?.textContent,
		reading: document.querySelector(".panel-original-reading")?.textContent,
		selected: [...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit.selected')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	assert(JSON.stringify(numberPanelWhileDialog) === JSON.stringify(numberPanelBefore),
		"読み修正を開いただけで背後の選択または候補が変わった: " +
		JSON.stringify({ before: numberPanelBefore, after: numberPanelWhileDialog }));
	assert(await editor.textContent("#reading-fix-target") === "「12」の読み",
		"読み修正小窓に実際の対象が表示されない");
	const numberScopeNote = await editor.textContent(".panel-yomi-scope-note");
	assert(numberScopeNote.includes(`選んだ「${numberPanelBefore.surface}」`) &&
		numberScopeNote.includes("「12」全体") && numberScopeNote.includes("単語区切り"),
		"読み修正範囲を広げた理由が表示されない: " + numberScopeNote);
	await editor.fill(".panel-yomi .input", "abc");
	await editor.click(".panel-yomi .btn-primary");
	assert(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open) &&
		(await editor.textContent(".panel-yomi-note")).includes("かなで入力"),
		"無効な読みで専用小窓に留まらない");
	assert(await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList)
	) === numberTokensBeforeDialog, "無効な読みでデータが変更された");
	// キャンセルとEscapeでは、入力中の値も背後の候補も保存データも変えない。
	await editor.fill(".panel-yomi .input", "キャンセルテスト");
	await editor.click("#btn-reading-fix-cancel");
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)),
		"キャンセルで読み修正小窓が閉じない");
	assert(await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList)
	) === numberTokensBeforeDialog, "キャンセルで読みデータが変更された");
	await editor.click(".panel-yomi-toggle");
	await editor.press(".panel-yomi .input", "Escape");
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)),
		"Escapeで読み修正小窓が閉じない");
	await editor.click(".panel-yomi-toggle");
	await editor.mouse.click(1, 1);
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)),
		"小窓の外側クリックで読み修正小窓が閉じない");
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ジュウニ");
	const beforeImeCommit = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList));
	await editor.locator(".panel-yomi .input").evaluate((input) => {
		input.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter", code: "Enter", keyCode: 13, isComposing: true, bubbles: true,
		}));
	});
	assert(await editor.locator(".panel-yomi .input").count() === 1 &&
		await editor.inputValue(".panel-yomi .input") === "ジュウニ",
		"IME変換確定のEnterで読み修正フォームが確定された");
	const afterImeCommit = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList));
	assert(afterImeCommit === beforeImeCommit,
		"IME変換確定のEnterで読みデータが更新された");
	await editor.press(".panel-yomi .input", "Enter");
	await editor.waitForFunction(() =>
		[...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit')]
			.map((e) => e.textContent).join("|") === "シン|ヤ|ジュウ|ニ|ジ|ヲ|ス|ギ|タッ|テ",
		undefined, { timeout: 10000 });
	const readingUiAfterApply = await editor.evaluate(() => ({
		dialogOpen: document.querySelector("#editor-reading-dialog")?.open,
		panelOpen: document.querySelector("#editor-panel")?.classList.contains("open"),
		selected: document.querySelectorAll(".chip-unit.selected").length,
	}));
	assert(!readingUiAfterApply.dialogOpen && !readingUiAfterApply.panelOpen,
		"読み更新後に小窓または古い候補パネルが残っている: " + JSON.stringify(readingUiAfterApply));
	assert(await editor.locator(".chip-unit.selected").count() === 0,
		"読み更新後も古い候補範囲が選択されたままになっている");
	assert(await editor.locator(".panel-yomi-scope-note").isHidden(),
		"読み修正の確定後も範囲拡張の説明が残っている");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);
	const numberReadingAfterUndo = await editor.$$eval(
		'.editor-line[data-line="1"] .chip-unit',
		(els) => els.map((e) => e.textContent).join("|"));
	assert(numberReadingAfterUndo === "シン|ヤ|イ|チ|ニ|ジ|ヲ|ス|ギ|タッ|テ",
		"読み修正のUndoで元の読みへ戻らない: " + numberReadingAfterUndo);

	// ---- 公開版での最小再現: 複数漢字の読み修正 ----
	// 漢字→ジュウで「字漢」「ジ|ュ|ウ」にならず、表層順と拗音を保つ。
	await editor.locator('.editor-line[data-line="2"] .chip-unit').first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ジュウ");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		[...document.querySelectorAll('.editor-line[data-line="2"] .chip-unit')]
			.map((e) => e.textContent).join("|") === "ジュウ",
		undefined, { timeout: 10000 });
	const kanjiTokenAfter = await editor.evaluate(() => {
		const tokens = JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList[2];
		return {
			surface: tokens.map((t) => t.surface_form).join(""),
			reading: tokens.map((t) => t.pronunciation).join(""),
		};
	});
	assert(kanjiTokenAfter.surface === "漢字" && kanjiTokenAfter.reading === "ジュウ",
		"複数漢字の読み修正で表層順が変わった: " + JSON.stringify(kanjiTokenAfter));
	assert(!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))),
		"複数漢字の読み更新後に古い候補パネルが残っている");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 公開版の報告操作: 深夜12時を、の読みをまとめて修正 ----
	// 読みAPIが使えず12の読みが欠落した公開版では、表示されたヤ〜ヲのカナを
	// 選ぶと、内部の読み修正範囲が深夜12時をへ広がる。シンヤジューニジヲを
	// 割り当てた際、時=ジが先頭側のジへ
	// 誤対応して、表層が深夜時12を、読みがシン|ヤ|ジ|ュ|ー|ニ|ジ|ヲになっていた。
	await editor.locator('.editor-line[data-line="0"] .chip-unit').first().click();
	const mixedLineUnits = editor.locator('.editor-line[data-line="1"] .chip-unit');
	await mixedLineUnits.nth(1).click();
	await editor.waitForTimeout(300);
	await mixedLineUnits.nth(6).click({ modifiers: ["Shift"] });
	await editor.waitForFunction(() =>
		document.querySelector(".panel-yomi-toggle")?.getAttribute("aria-label")?.includes(
			"深夜12時を（シンヤイチニジヲ）"),
		undefined, { timeout: 10000 });
	const mixedSelectedSurface = await editor.textContent(".panel-original-surface");
	assert(mixedSelectedSurface !== "深夜12時を",
		"複数の単語区切りにまたがる部分選択を再現できていない");
	const mixedPanelBefore = await editor.evaluate(() => ({
		surface: document.querySelector(".panel-original-surface")?.textContent,
		reading: document.querySelector(".panel-original-reading")?.textContent,
		selected: [...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit.selected')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	const mixedResultsBefore = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	await editor.click(".panel-yomi-toggle");
	const mixedPanelWhileDialog = await editor.evaluate(() => ({
		surface: document.querySelector(".panel-original-surface")?.textContent,
		reading: document.querySelector(".panel-original-reading")?.textContent,
		selected: [...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit.selected')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	assert(JSON.stringify(mixedPanelWhileDialog) === JSON.stringify(mixedPanelBefore),
		"複数単語の読み修正を開いただけで候補範囲が変わった");
	assert(await editor.textContent("#reading-fix-target") === "「深夜12時を」の読み",
		"複数単語の読み修正対象が小窓に表示されない");
	const mixedScopeNote = await editor.textContent(".panel-yomi-scope-note");
	assert(mixedScopeNote.includes(`選んだ「${mixedSelectedSurface}」`) &&
		mixedScopeNote.includes("「深夜12時を」全体"),
		"複数の単語区切りにまたがる範囲拡張の理由が表示されない: " + mixedScopeNote);
	assert(await editor.locator("#editor-reading-dialog .panel-align").isVisible(),
		"複数単語の読み修正小窓に文字ごとの対応調整が表示されない");
	// 範囲全体の文字対応だけを変えても、背後の替え歌候補は維持する。
	const mixedAlignBefore = await editor.$$eval(".panel-align .align-cell",
		(els) => els.map((e) => e.textContent).join("|"));
	const mixedAlignArrows = editor.locator(".panel-align .align-arrow");
	let mixedAlignChanged = false;
	for (let i = 0; i < await mixedAlignArrows.count(); i += 1) {
		await mixedAlignArrows.nth(i).click();
		const after = await editor.$$eval(".panel-align .align-cell",
			(els) => els.map((e) => e.textContent).join("|"));
		if (after !== mixedAlignBefore) {
			mixedAlignChanged = true;
			break;
		}
	}
	assert(mixedAlignChanged, "複数単語の文字対応を矢印で変更できない");
	await editor.click("#btn-reading-fix-apply");
	await editor.waitForFunction(() => {
		const tokens = JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList[1];
		return Array.isArray(tokens.find((t) => t.surface_form === "深夜12時を")?.manualAlign);
	}, undefined, { timeout: 10000 });
	assert(await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results)
	) === mixedResultsBefore, "文字対応だけの変更で替え歌候補が変わった");
	await editor.click("#btn-undo");
	await editor.waitForTimeout(300);

	// 同じ範囲を選び直し、今度は読みそのものを更新する。
	await mixedLineUnits.nth(1).click();
	await editor.waitForTimeout(300);
	await mixedLineUnits.nth(6).click({ modifiers: ["Shift"] });
	await editor.waitForFunction(() =>
		document.querySelector(".panel-yomi-toggle")?.getAttribute("aria-label")?.includes(
			"深夜12時を（シンヤイチニジヲ）"),
		undefined, { timeout: 10000 });
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "シンヤジューニジヲ");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForTimeout(300);
	const mixedUnitsAfterReading = await editor.$$eval(
		'.editor-line[data-line="1"] .chip-unit',
		(els) => els.map((e) => e.textContent).join("|"));
	assert(mixedUnitsAfterReading === "シン|ヤ|ジュー|ニ|ジ|ヲ|ス|ギ|タッ|テ",
		"複数単語の読み修正後の単位が想定外: " + mixedUnitsAfterReading);
	const mixedTokenAfter = await editor.evaluate(() => {
		const tokens = JSON.parse(sessionStorage.getItem("soramimic-editor")).tokensList[1];
		return {
			surface: tokens.map((t) => t.surface_form).join(""),
			reading: tokens.map((t) => t.pronunciation).join(""),
		};
	});
	assert(mixedTokenAfter.surface === "深夜12時をすぎたって" &&
		mixedTokenAfter.reading === "シンヤジューニジヲスギタッテ",
		"複数単語の読み修正後に表層または読みが変わった: " + JSON.stringify(mixedTokenAfter));
	assert(!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))),
		"複数単語の読み更新後に古い候補パネルが残っている");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);
	const mixedReadingAfterUndo = await editor.$$eval(
		'.editor-line[data-line="1"] .chip-unit',
		(els) => els.map((e) => e.textContent).join(""));
	assert(mixedReadingAfterUndo === "シンヤイチニジヲスギタッテ",
		"戻る操作で複数単語の読みが復元されない: " + mixedReadingAfterUndo);
	assert(await editor.locator(".panel-yomi-scope-note").isHidden(),
		"戻る操作後も範囲拡張の説明が残っている");

	// ---- 回帰ガード: かな区間の読みを長くしてもサーフェスが重複しないこと ----
	// (getYomiAndPhraseBreakは読み>サーフェスのモーラ数だとかなサーフェスを複製する。
	//  例: したい+シタイシタイ → したいしたい。applyReadingFixはそれを避ける)
	await editor.locator(".chip-unit", { hasText: "ガ" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const kanaEditLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	const kanaSurface = kanaEditLabel.match(/^「(.+?)（/)[1];
	const kanaLineSurfaceBefore = await editor.$$eval(
		'.editor-line[data-line="0"] .chip-unit',
		(els) => els.map((e) => e.title).join(""));
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ガタガタ"); // 元より長い読み
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		!document.getElementById("editor-reading-dialog").open,
		undefined, { timeout: 10000 });
	const kanaLineSurfaceAfter = await editor.$$eval(
		'.editor-line[data-line="0"] .chip-unit',
		(els) => els.map((e) => e.title).join(""));
	assert(kanaLineSurfaceAfter === kanaLineSurfaceBefore,
		`かな読み修正でサーフェスが重複: 対象="${kanaSurface}" ` +
		`期待="${kanaLineSurfaceBefore}" 実際="${kanaLineSurfaceAfter}"`);
	await editor.click("#btn-undo"); // 状態を戻して後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 手動割当: 表層↔モーラの境界をユーザが動かせる ----
	// 「忘れ」(ワスレ)を選択 → 自動では 忘=ワス/れ=レ。▶で 忘 を1モーラ減らすと
	// 忘=ワ になり、そのモーラのチップ表層が付け替わること
	await editor.locator(".chip-unit", { hasText: "ワ" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const alignStateBefore = await editor.evaluate(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return JSON.stringify({ tokens: state.tokensList, history: state.history });
	});
	const alignSelectionBefore = await editor.$$eval(".chip-unit.selected",
		(els) => els.map((e) => e.textContent).join(""));
	await editor.click(".panel-yomi-toggle");
	await editor.waitForSelector("#editor-reading-dialog[open] .panel-align", { timeout: 10000 });
	const alignBefore = await editor.textContent(".panel-align .align-cell");
	assert(alignBefore.includes("忘") && alignBefore.includes("ワス"),
		"手動割当の初期表示が想定外: " + alignBefore);
	// 境界の▶は小窓内の下書きだけを変え、背景や保存データにはまだ反映しない。
	await editor.locator(".align-boundary .align-arrow").nth(1).click();
	await editor.waitForFunction(() => {
		const cell = document.querySelector(".panel-align .align-cell");
		return cell && cell.textContent.includes("忘") && cell.textContent.includes("ワ") &&
			!cell.textContent.includes("ワス");
	}, undefined, { timeout: 10000 });
	assert(await editor.evaluate(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return JSON.stringify({ tokens: state.tokensList, history: state.history });
	}) === alignStateBefore, "文字対応の下書きだけで保存データが変わった");
	assert(await editor.$$eval(".chip-unit.selected",
		(els) => els.map((e) => e.textContent).join("")) === alignSelectionBefore,
		"文字対応の下書きだけで背後の選択が変わった");
	await editor.click("#btn-reading-fix-cancel");
	assert(await editor.evaluate(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return JSON.stringify({ tokens: state.tokensList, history: state.history });
	}) === alignStateBefore, "文字対応をキャンセルしても変更が残った");

	// 改めて同じ変更を作り、「変更を適用」で読みと一緒に1履歴として確定する。
	await editor.click(".panel-yomi-toggle");
	await editor.locator(".align-boundary .align-arrow").nth(1).click();
	await editor.click("#btn-reading-fix-apply");
	await editor.waitForFunction(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		const token = state.tokensList[0].find((t) => t.surface_form === "忘れ");
		return JSON.stringify(token?.manualAlign) === JSON.stringify([["忘", "ワ"], ["れ", "スレ"]]);
	}, undefined, { timeout: 10000 });
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)) &&
		await editor.locator(".chip-unit.selected").count() === 0,
		"文字対応の適用後に小窓または古い選択が残った");
	await editor.click("#btn-undo"); // 後続テストに影響させないため戻す
	await editor.waitForFunction(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		const token = state.tokensList[0].find((t) => t.surface_form === "忘れ");
		return token && !token.manualAlign;
	}, undefined, { timeout: 10000 });

	// ---- 読み修正: コキョー → フルサト ----
	// 「コ」のユニットをタップ → トークン境界スナップで対象が「故郷」になる
	await editor.locator(".chip-unit", { hasText: "コ" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const sourceEditLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	assert(sourceEditLabel.includes("故郷") && sourceEditLabel.includes("コキョー"),
		"読み修正の対象が想定外: " + sourceEditLabel);
	await editor.click(".panel-yomi-toggle");
	assert(await editor.evaluate(() => document.activeElement?.matches(".panel-yomi .input")),
		"読み修正フォームを開いても読み入力欄にフォーカスされない");
	await editor.fill(".panel-yomi .input", "ふるさと");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(
		() => [...document.querySelectorAll(".chip-unit")].map((e) => e.textContent).join("")
			=== "ワスレガタキフルサトシンヤイチニジヲスギタッテカンジ",
		undefined, { timeout: 10000 },
	);
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)) &&
		!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))),
		"読み更新後に読み小窓または古い候補パネルが残っている");
	// 読みの変更後は古い候補範囲を引き継がない。修正済みの箇所を選び直す。
	const correctedLineUnits = editor.locator('.editor-line[data-line="0"] .chip-unit');
	const correctedUnitTexts = await correctedLineUnits.allTextContents();
	const correctedStart = correctedUnitTexts.indexOf("フ");
	assert(correctedStart >= 0, "修正済みの「フルサト」が見つからない");
	for (let i = correctedStart; i < correctedStart + 4; i += 1) {
		await correctedLineUnits.nth(i).click();
	}
	await editor.waitForSelector(".editor-panel.open .panel-candidates .candidate", { timeout: 30000 });
	const selectedReading = await editor.textContent(".panel-original-reading");
	assert(selectedReading.includes("フルサト"),
		"読み修正後の選択範囲が想定外: " + selectedReading);

	// ---- 候補差し替え: 候補選択はドラフト、読みと一緒に確定すると自動固定 ----
	const candidate = editor.locator(".candidate:not(:has(.candidate-count))").first();
	const candSurface = await candidate.locator(".candidate-surface").textContent();
	const candKana = await candidate.locator(".candidate-kana").textContent();
	const candId = await candidate.getAttribute("data-candidate-id");
	assert(candId, "候補の安定IDをUIから取得できない");
	const beforeDraft = await editor.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return { results: JSON.stringify(data.results), history: data.history.length };
	});
	await candidate.click();
	assert(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open")),
		"候補選択だけでパネルが閉じた");
	assert(await editor.textContent(".panel-draft-surface") === candSurface,
		"選択した候補がドラフトに反映されない");
	assert(await editor.inputValue(".panel-draft-reading") === candKana.replace("・使用中", ""),
		"候補の読みがドラフトに反映されない");
	const draftVisible = await editor.locator(".panel-replacement-draft").evaluate((draft) => {
		const panel = document.getElementById("editor-panel");
		const d = draft.getBoundingClientRect();
		const p = panel.getBoundingClientRect();
		return d.top >= p.top && d.top < p.bottom && d.bottom <= p.bottom;
	});
	assert(draftVisible, "候補選択後の読み調整欄がパネル内に見えていない");
	const afterDraft = await editor.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return { results: JSON.stringify(data.results), history: data.history.length };
	});
	assert(afterDraft.results === beforeDraft.results && afterDraft.history === beforeDraft.history,
		"候補選択だけで編集結果または履歴が変更された");
	await editor.fill(".panel-draft-reading", "ふるさた");
	if (await editor.locator(".panel-more").count()) {
		await editor.click(".panel-more");
		assert(await editor.inputValue(".panel-draft-reading") === "ふるさた",
			"候補一覧の再描画で未確定の読みが消えた");
	}
	await editor.fill(".panel-draft-reading", "ン".repeat(20));
	await editor.click(".panel-candidate-apply");
	const invalidReadingNote = await editor.textContent(".panel-replacement-note");
	assert(invalidReadingNote.includes("合わせられる読み"),
		"発音候補が過大な読みを安全に拒否しない: " + invalidReadingNote);
	const afterInvalid = await editor.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return { results: JSON.stringify(data.results), history: data.history.length };
	});
	assert(afterInvalid.results === beforeDraft.results && afterInvalid.history === beforeDraft.history,
		"無効な読みで編集結果または履歴が変更された");
	await editor.fill(".panel-draft-reading", "ふるさた");
	await editor.click(".panel-candidate-apply");
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	assert(await editor.isChecked(".chip-word.locked .chip-lock-input"),
		"差し替え後の自動固定が鍵アイコンに反映されない");
	const lockedSurface = await editor.textContent(".chip-word.locked .chip-word-surface");
	assert(candSurface.startsWith(lockedSurface),
		`差し替えた単語がチップに反映されていない: 候補=${candSurface} チップ=${lockedSurface}`);
	const committed = await editor.evaluate((surface) => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return data.results.flat().find((w) => w.surface === surface && w.locked);
	}, lockedSurface);
	assert(committed && String(committed.id) === candId && committed.kana === "フルサタ" &&
		Array.isArray(committed.pronunciation) && committed.pronunciation.length > 0,
		"候補IDを保った読み調整が保存されない: " + JSON.stringify(committed));

	// ---- 固定中以外を再生成: 固定した単語が保持される ----
	await editor.click("#btn-regenerate");
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);
	const lockedAfter = await editor.$$eval(".chip-word.locked .chip-word-surface",
		(els) => els.map((e) => e.textContent));
	assert(lockedAfter.includes(lockedSurface), "再生成で固定単語が失われた");

	// ---- 戻る(undo): 再生成前の状態に戻せる ----
	const wordsAfterRegen = await editor.$$eval(".chip-word-surface", (els) => els.length);
	assert(!(await editor.isDisabled("#btn-undo")), "編集後なのに戻るボタンが無効");
	await editor.click("#btn-undo");
	await editor.waitForFunction(
		() => !document.getElementById("btn-redo").disabled,
		undefined, { timeout: 10000 },
	);
	assert(wordsAfterRegen > 0, "再生成後の単語が空");

	// ---- コピー: 末尾に使用単語一覧が付く ----
	await editor.evaluate(() => {
		window.__copied = null;
		navigator.clipboard.writeText = (t) => {
			window.__copied = t;
			return Promise.resolve();
		};
	});
	await editor.click("#btn-copy");
	await editor.waitForFunction(() => window.__copied !== null, undefined, { timeout: 10000 });
	const copied = await editor.evaluate(() => window.__copied);
	assert(copied.includes("使用単語一覧："), "コピー結果に使用単語一覧がない:\n" + copied);
	assert(copied.includes(lockedSurface), "コピー結果に差し替えた単語がない:\n" + copied);

	// ---- 書き出し→読み込み: 編集状態をファイルで往復できる ----
	const wordsBeforeImport = await editor.$$eval(".chip-word-surface",
		(els) => els.map((e) => e.textContent).join("|"));
	const [download] = await Promise.all([
		editor.waitForEvent("download"),
		editor.click("#btn-export"),
	]);
	const exportPath = await download.path();
	// 空の編集画面(sessionStorageなし)から読み込んで再開できること
	await editor.evaluate(() => sessionStorage.clear());
	await editor.reload();
	await editor.waitForSelector("#editor-empty:not([hidden])", { timeout: 10000 });
	await editor.setInputFiles("#import-file", exportPath);
	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 30000 });
	const wordsAfterImport = await editor.$$eval(".chip-word-surface",
		(els) => els.map((e) => e.textContent).join("|"));
	assert(wordsAfterImport === wordsBeforeImport,
		`読み込みで単語列が変わった: ${wordsBeforeImport} -> ${wordsAfterImport}`);
	// wordlist情報も引き継がれ、候補機能(再生成)が使える状態になる
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor smoke test passed");
	exitCode = 0;
	await browser.close();
} catch (err) {
	console.error("[FAIL]", err.message);
} finally {
	try {
		process.kill(-preview.pid);
	} catch {}
	process.exit(exitCode);
}
