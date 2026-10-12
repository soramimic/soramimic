import { regenerateAll, openLine, selectRange, selectReading, menuAction } from "./editor-ui.mjs";
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
	await editor.waitForSelector(".editor-line .review-word", { timeout: 60000 });
	assert(await editor.inputValue("#copy-format") === "4",
		"編集画面の既定コピー形式が対応区切りではない");
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);
	assert(await editor.locator("#editor-hint").count() === 0,
		"冒頭の操作説明が残っている");
	assert(await editor.locator(".review-line .review-unit").count() === 0,
		"読みの範囲が歌詞一覧に常駐している");
	assert(await editor.getByRole("button", { name: "固定中以外を再生成", exact: true }).isVisible(),
		"再生成を直接実行できない");
	for (const id of ["#btn-settings", "#btn-copy", "#btn-export", "#btn-import"]) {
		assert(await editor.locator(id).isHidden(), `${id}が通常画面に常駐している`);
	}
	const kanaBefore = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor"))
		.unitsList.flat().map((unit) => unit.pronunciation).join(""));
	assert(kanaBefore === "ワスレガタキコキョーシンヤイチニジヲスギタッテカンジ",
		"元の読みが想定外: " + kanaBefore);
	const wordTitle = await editor.getAttribute(".review-word", "title");
	assert(wordTitle && wordTitle.includes("→") && wordTitle.includes("ID:"), "単語詳細が失われた");
	const firstWord = editor.locator(".review-word:not(.filler)").first();
	await firstWord.click();
	const panelLock = editor.locator(".panel-lock");
	const initiallyLocked = await panelLock.getAttribute("aria-pressed") === "true";
	await panelLock.click();
	assert((await panelLock.getAttribute("aria-pressed") === "true") === !initiallyLocked,
		"固定を切り替えられない");
	assert(await firstWord.evaluate((node) => node.classList.contains("locked")) === !initiallyLocked,
		"一覧の固定表示が更新されない");
	assert(await firstWord.locator(".chip-lock-icon").count() === (initiallyLocked ? 0 : 1),
		"固定中だけ鍵が表示されない");
	await panelLock.click();
	await editor.locator(".panel-close").click();

	// ---- 自由入力は通常時には畳み、歌詞と読みを一緒に確定できる ----
	await selectRange(editor, 0, 0);
	assert(await editor.locator(".panel-free-surface").count() === 0,
		"希少な自由入力欄が最初から表示されている");
	const beforeFree = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	await editor.click(".panel-free-toggle");
	assert(await editor.locator(".panel-candidates").count() === 0,
		"自由入力中にも候補一覧が表示されている");
	assert(await editor.locator(".panel-free-back").evaluate((button) => {
		const box = button.getBoundingClientRect();
		return button.closest(".panel-free-actions") && box.width >= 44 && box.height >= 44;
	}), "キャンセルが入力欄の操作エリアにないか、押せる大きさではない");
	await editor.click(".panel-free-back");
	assert(await editor.locator(".panel-free").count() === 0 &&
		await editor.locator(".panel-candidates").count() === 1,
		"候補選択へ戻るボタンの1回のクリックで候補一覧へ戻らない");
	await editor.click(".panel-free-toggle");
	await editor.fill(".panel-free-surface", "あ");
	const historyBeforeInvalid = await editor.evaluate(() =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")).history.length);
	await editor.click(".review-reading-input summary");
	for (const reading of ["漢字", "ア".repeat(101)]) {
		await editor.fill(".panel-free-reading", reading);
		await editor.click(".panel-free-apply");
		assert((await editor.textContent(".panel-replacement-note")).includes("ひらがな・カタカナ"),
			"無効な読みで入力方法が案内されない");
		assert(await editor.evaluate(() =>
			JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results)) === beforeFree &&
			await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).history.length) === historyBeforeInvalid,
			"無効な自由入力の読みで編集結果または履歴が変更された");
	}
	await editor.fill(".panel-free-reading", "あ");
	assert(await editor.evaluate(() => document.activeElement?.matches(".panel-free-reading")),
		"自由入力の読み欄を編集できない");
	const afterFreeDraft = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	assert(afterFreeDraft === beforeFree,
		"自由入力の確定前に編集結果が変更された");
	await editor.click(".panel-free-apply");
	await editor.waitForSelector(".review-word.locked", { timeout: 10000 });
	const custom = await editor.evaluate(() =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")).results.flat()
			.find((w) => w.surface === "あ" && w.locked));
	assert(custom && String(custom.id).startsWith("custom-") && custom.kana === "ア" &&
		Array.isArray(custom.pronunciation),
		"自由入力の歌詞と読みがcustom語として保存されない: " + JSON.stringify(custom));
	assert(await editor.locator("#editor-panel").evaluate((panel) => panel.open) &&
		await editor.locator(".panel-free").count() === 0,
		"手入力の確定後に候補選択へ戻らない");
	await editor.click(".panel-close");
	await editor.click("#btn-undo");
	await editor.waitForTimeout(300);

	// ---- 手入力は音・音数が違っても、元の選択範囲にそのまま保存する ----
	const snapshot = () => editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const customCases = [
		{ surface: "かしおと", reading: "", kana: "カシオト", end: 0 },
		{ surface: "あ", reading: "", kana: "ア", end: 3 },
		{ surface: "自由な歌詞", reading: "うみねこ", kana: "ウミネコ", end: 3 },
		{ surface: "長い読み", reading: "ン".repeat(20), kana: "ン".repeat(20), end: 0 },
	];
	for (const [index, input] of customCases.entries()) {
		const before = await snapshot();
		await selectRange(editor, 0, 0, input.end);
		await editor.click(".panel-free-toggle");
		await editor.fill(".panel-free-surface", input.surface);
		if (input.reading) {
			await editor.click(".review-reading-input summary");
			await editor.fill(".panel-free-reading", input.reading);
		}
		await editor.click(".panel-free-apply");
		await editor.locator(".panel-free").waitFor({ state: "detached" });
		const after = await snapshot();
		const saved = after.results[0].find((word) => word.surface === input.surface && word.locked);
		assert(saved?.kana === input.kana && saved.pronunciation.join("") === input.kana,
			"音数が違う手入力の読みが保存されない: " + JSON.stringify(saved));
		assert(!("sim" in saved) && !("score" in saved),
			"手入力に計算していない類似度が保存された");
		assert(JSON.stringify(saved.period) === JSON.stringify([0, input.end + 1]),
			"手入力の音数に合わせて選択範囲が変わった");
		assert(JSON.stringify(after.unitsList) === JSON.stringify(before.unitsList) &&
			JSON.stringify(after.tokensList) === JSON.stringify(before.tokensList),
			"手入力で元歌詞の読みが変わった");
		assert(JSON.stringify(after.results.slice(1)) === JSON.stringify(before.results.slice(1)) &&
			JSON.stringify(after.results[0].filter((word) => word.period[0] > input.end)) ===
			JSON.stringify(before.results[0].filter((word) => word.period[0] > input.end)),
			"手入力で選択範囲外の単語が変わった");
		await editor.click(".panel-close");
		if (index === 0) {
			await editor.reload();
			await editor.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
			assert(JSON.stringify((await snapshot()).results) === JSON.stringify(after.results),
				"音数が違う手入力を再読込で復元できない");
			await regenerateAll(editor);
			await editor.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
			assert(JSON.stringify((await snapshot()).results[0].find((word) => word.id === saved.id)) === JSON.stringify(saved),
				"再生成で音数が違う手入力が失われた");
			await editor.click("#btn-undo");
		}
		await editor.click("#btn-undo");
		assert(JSON.stringify((await snapshot()).results) === JSON.stringify(before.results),
			"音数が違う手入力を取り消せない");
		await editor.click("#btn-redo");
		assert(JSON.stringify((await snapshot()).results) === JSON.stringify(after.results),
			"音数が違う手入力をやり直せない");
		await editor.click("#btn-undo");
	}

	// ---- 回帰ガード: 複数桁数字の読み修正で拗音を分割しない ----
	// 12は1トークンだが、表示上は複数ユニット。どれをタップしても対象全体が
	// 12(イチニ)へスナップし、ジュウニへの修正後もジュウ/ニの2音節になる。
	await selectRange(editor, 1, 2);
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const numberEditLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	assert(numberEditLabel.includes("12") && numberEditLabel.includes("イチニ"),
		"複数桁数字が読み修正の対象になっていない: " + numberEditLabel);
	assert(await editor.textContent(".panel-yomi-toggle") === "✏️",
		"元歌詞の読み修正が鉛筆だけの表示になっていない");
	assert((await editor.getAttribute(".panel-yomi-toggle", "aria-label")).includes("読みを修正"),
		"鉛筆に読み修正のアクセシブルな名前がない");
	const numberPanelBefore = await editor.evaluate(() => ({
		surface: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.title).join(""),
		reading: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.textContent).join(""),
		selected: [...document.querySelectorAll('.review-range[data-line="1"] .review-unit[aria-pressed=true]')]
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
		surface: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.title).join(""),
		reading: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.textContent).join(""),
		selected: [...document.querySelectorAll('.review-range[data-line="1"] .review-unit[aria-pressed=true]')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	assert(JSON.stringify(numberPanelWhileDialog) === JSON.stringify(numberPanelBefore),
		"読み修正を開いただけで背後の選択または候補が変わった: " +
		JSON.stringify({ before: numberPanelBefore, after: numberPanelWhileDialog }));
	assert(await editor.textContent("#reading-fix-target") === "12",
		"読み修正小窓に実際の対象が表示されない: " + await editor.textContent("#reading-fix-target"));
	assert(await editor.textContent(".reading-fix-description") ===
		"選択部分を含む単語全体を修正します",
		"読みを単語単位で修正する説明が表示されない");
	assert((await editor.textContent("#reading-fix-target .reading-fix-selection")) !== "",
		"読み修正小窓で選択部分が示されない");
	assert(JSON.stringify(await editor.locator(
		"#editor-reading-dialog .panel-yomi-label").allTextContents()) ===
		JSON.stringify(["元歌詞", "元歌詞読み"]),
		"読み修正小窓の項目名が想定外");
	assert(await editor.textContent("#reading-fix-align-details > summary") ===
		"表記と読みの対応を調整", "読みの対応調整の表記が想定外");
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
		JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[1].map((unit) => unit.pronunciation).join("|") === "シン|ヤ|ジュウ|ニ|ジ|ヲ|ス|ギ|タッ|テ",
		undefined, { timeout: 10000 });
	const readingUiAfterApply = await editor.evaluate(() => ({
		dialogOpen: document.querySelector("#editor-reading-dialog")?.open,
		panelOpen: document.querySelector("#editor-panel")?.classList.contains("open"),
		selected: document.querySelectorAll(".review-unit[aria-pressed=true]").length,
	}));
	assert(!readingUiAfterApply.dialogOpen && !readingUiAfterApply.panelOpen,
		"読み更新後に小窓または古い候補パネルが残っている: " + JSON.stringify(readingUiAfterApply));
	assert(await editor.locator(".review-unit[aria-pressed=true]").count() === 0,
		"読み更新後も古い候補範囲が選択されたままになっている");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);
	const numberReadingAfterUndo = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[1].map((unit) => unit.pronunciation).join("|"));
	assert(numberReadingAfterUndo === "シン|ヤ|イ|チ|ニ|ジ|ヲ|ス|ギ|タッ|テ",
		"読み修正のUndoで元の読みへ戻らない: " + numberReadingAfterUndo);

	// ---- 公開版での最小再現: 複数漢字の読み修正 ----
	// 漢字→ジュウで「字漢」「ジ|ュ|ウ」にならず、表層順と拗音を保つ。
	await selectRange(editor, 2, 0);
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ジュウ");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[2].map((unit) => unit.pronunciation).join("|") === "ジュウ",
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
	await selectRange(editor, 0, 0);
	const mixedLineUnits = editor.locator(".review-unit");
	await selectRange(editor, 1, 1);
	await editor.waitForTimeout(300);
	await mixedLineUnits.nth(6).click({ modifiers: ["Shift"] });
	await editor.waitForFunction(() =>
		document.querySelector(".panel-yomi-toggle")?.getAttribute("aria-label")?.includes(
			"深夜12時を（シンヤイチニジヲ）"),
		undefined, { timeout: 10000 });
	const mixedSelectedSurface = await editor.$$eval(".review-unit[aria-pressed=true]", (units) => units.map((unit) => unit.title).join(""));
	assert(mixedSelectedSurface !== "深夜12時を",
		"複数の単語区切りにまたがる部分選択を再現できていない");
	const mixedPanelBefore = await editor.evaluate(() => ({
		surface: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.title).join(""),
		reading: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.textContent).join(""),
		selected: [...document.querySelectorAll('.review-range[data-line="1"] .review-unit[aria-pressed=true]')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	const mixedResultsBefore = await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	await editor.click(".panel-yomi-toggle");
	const mixedPanelWhileDialog = await editor.evaluate(() => ({
		surface: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.title).join(""),
		reading: [...document.querySelectorAll(".review-unit[aria-pressed=true]")].map((unit) => unit.textContent).join(""),
		selected: [...document.querySelectorAll('.review-range[data-line="1"] .review-unit[aria-pressed=true]')]
			.map((e) => e.textContent).join(""),
		candidates: [...document.querySelectorAll(".candidate")]
			.map((e) => e.dataset.candidateId || e.textContent).join("|"),
	}));
	assert(JSON.stringify(mixedPanelWhileDialog) === JSON.stringify(mixedPanelBefore),
		"複数単語の読み修正を開いただけで候補範囲が変わった");
	assert(await editor.textContent("#reading-fix-target") === "深夜12時を",
		"複数単語の読み修正対象が小窓に表示されない");
	assert(await editor.textContent("#reading-fix-target .reading-fix-selection") ===
		mixedSelectedSurface, "複数単語の読み修正で元の選択部分が示されない");
	assert(!(await editor.locator("#reading-fix-align-details").evaluate((el) => el.open)) &&
		await editor.locator("#editor-reading-dialog .panel-align").isHidden(),
		"文字ごとの対応調整が初期状態で閉じていない");
	await editor.click("#reading-fix-align-details > summary");
	await editor.waitForSelector("#editor-reading-dialog .panel-align", { timeout: 10000 });
	// 範囲全体の文字対応だけを変えても、背後の替え歌候補は維持する。
	const mixedAlignBefore = await editor.$$eval(".panel-align .align-cell",
		(els) => els.map((e) => e.textContent).join("|"));
	const mixedAlignArrows = editor.locator(".panel-align .align-arrow");
	let mixedAlignChanged = false;
	for (let i = 0; i < await mixedAlignArrows.count(); i += 1) {
		if (await mixedAlignArrows.nth(i).isDisabled()) continue;
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
	await selectRange(editor, 1, 1);
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
	const mixedUnitsAfterReading = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[1].map((unit) => unit.pronunciation).join("|"));
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
	const mixedReadingAfterUndo = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[1].map((unit) => unit.pronunciation).join(""));
	assert(mixedReadingAfterUndo === "シンヤイチニジヲスギタッテ",
		"戻る操作で複数単語の読みが復元されない: " + mixedReadingAfterUndo);

	// ---- 回帰ガード: かな区間の読みを長くしてもサーフェスが重複しないこと ----
	// (getYomiAndPhraseBreakは読み>サーフェスのモーラ数だとかなサーフェスを複製する。
	//  例: したい+シタイシタイ → したいしたい。applyReadingFixはそれを避ける)
	await selectReading(editor, 0, "ガ");
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const kanaEditLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	const kanaSurface = kanaEditLabel.match(/^「(.+?)（/)[1];
	const kanaLineSurfaceBefore = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[0].map((unit) => unit.surface_form).join(""));
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ガタガタ"); // 元より長い読み
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		!document.getElementById("editor-reading-dialog").open,
		undefined, { timeout: 10000 });
	const kanaLineSurfaceAfter = await editor.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList[0].map((unit) => unit.surface_form).join(""));
	assert(kanaLineSurfaceAfter === kanaLineSurfaceBefore,
		`かな読み修正でサーフェスが重複: 対象="${kanaSurface}" ` +
		`期待="${kanaLineSurfaceBefore}" 実際="${kanaLineSurfaceAfter}"`);
	await editor.click("#btn-undo"); // 状態を戻して後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 手動割当: 表層↔モーラの境界をユーザが動かせる ----
	// 「忘れ」(ワスレ)を選択 → 自動では 忘=ワス/れ=レ。▶で 忘 を1モーラ減らすと
	// 忘=ワ になり、そのモーラのチップ表層が付け替わること
	await selectReading(editor, 0, "ワ");
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const alignStateBefore = await editor.evaluate(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return JSON.stringify({ tokens: state.tokensList, history: state.history });
	});
	const alignSelectionBefore = await editor.$$eval(".review-unit[aria-pressed=true]",
		(els) => els.map((e) => e.textContent).join(""));
	await editor.click(".panel-yomi-toggle");
	assert(!(await editor.locator("#reading-fix-align-details").evaluate((el) => el.open)),
		"文字ごとの対応調整が初期状態で閉じていない");
	await editor.click("#reading-fix-align-details > summary");
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
	assert(await editor.$$eval(".review-unit[aria-pressed=true]",
		(els) => els.map((e) => e.textContent).join("")) === alignSelectionBefore,
		"文字対応の下書きだけで背後の選択が変わった");
	await editor.click("#btn-reading-fix-cancel");
	assert(await editor.evaluate(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return JSON.stringify({ tokens: state.tokensList, history: state.history });
	}) === alignStateBefore, "文字対応をキャンセルしても変更が残った");

	// 改めて同じ変更を作り、「変更を適用」で読みと一緒に1履歴として確定する。
	await editor.click(".panel-yomi-toggle");
	await editor.click("#reading-fix-align-details > summary");
	await editor.locator(".align-boundary .align-arrow").nth(1).click();
	await editor.click("#btn-reading-fix-apply");
	await editor.waitForFunction(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		const token = state.tokensList[0].find((t) => t.surface_form === "忘れ");
		return JSON.stringify(token?.manualAlign) === JSON.stringify([["忘", "ワ"], ["れ", "スレ"]]);
	}, undefined, { timeout: 10000 });
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)) &&
		await editor.locator(".review-unit[aria-pressed=true]").count() === 0,
		"文字対応の適用後に小窓または古い選択が残った");
	await editor.click("#btn-undo"); // 後続テストに影響させないため戻す
	await editor.waitForFunction(() => {
		const state = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		const token = state.tokensList[0].find((t) => t.surface_form === "忘れ");
		return token && !token.manualAlign;
	}, undefined, { timeout: 10000 });

	// ---- 読み修正: コキョー → フルサト ----
	// 「コ」のユニットをタップ → トークン境界スナップで対象が「故郷」になる
	await selectReading(editor, 0, "コ");
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
		() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList.flat().map((unit) => unit.pronunciation).join("")
			=== "ワスレガタキフルサトシンヤイチニジヲスギタッテカンジ",
		undefined, { timeout: 10000 },
	);
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)) &&
		!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))),
		"読み更新後に読み小窓または古い候補パネルが残っている");
	// 読みの変更後は古い候補範囲を引き継がない。修正済みの箇所を選び直す。
	await openLine(editor, 0);
	const correctedLineUnits = editor.locator(".review-unit");
	const correctedUnitTexts = await correctedLineUnits.allTextContents();
	const correctedStart = correctedUnitTexts.indexOf("フ");
	assert(correctedStart >= 0, "修正済みの「フルサト」が見つからない");
	await selectRange(editor, 0, correctedStart, correctedStart + 3);
	await editor.waitForSelector(".editor-panel.open .panel-candidates .candidate", { timeout: 30000 });
	const selectedReading = await editor.$$eval(".review-unit[aria-pressed=true]", (units) => units.map((unit) => unit.textContent).join(""));
	assert(selectedReading.includes("フルサト"),
		"読み修正後の選択範囲が想定外: " + selectedReading);

	// ---- 候補差し替え: 候補をクリックすると即座に差し替えて自動固定 ----
	const candidate = editor.locator(".candidate:not(:has(.candidate-count))").first();
	const candSurface = await candidate.locator(".candidate-surface").textContent();
	const candKana = (await candidate.locator(".candidate-kana").textContent()).replace("・使用中", "");
	const candId = await candidate.getAttribute("data-candidate-id");
	assert(candId, "候補の安定IDをUIから取得できない");
	const beforeReplacement = await editor.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return { results: JSON.stringify(data.results), history: data.history.length };
	});
	await candidate.click();
	assert(await editor.locator("#editor-panel").evaluate((el) => el.open),
		"候補をクリックすると確認前にパネルが閉じた");
	assert(await editor.textContent(".review-selected-word") === candSurface,
		"選択した候補が上部に反映されない");
	await editor.getByRole("button", { name: "決定して歌詞一覧に戻る", exact: true }).click();
	assert(await editor.locator("#editor-panel").evaluate((el) => !el.open),
		"決定ボタンで候補を確定して歌詞一覧に戻れない");
	await editor.waitForSelector(".review-word.locked", { timeout: 10000 });
	assert(await editor.locator(".review-word.locked .chip-lock-icon").count() > 0,
		"差し替え後の自動固定が鍵アイコンに反映されない");
	const lockedSurface = await editor.textContent(".review-word.locked .review-word-surface");
	assert(candSurface.startsWith(lockedSurface),
		`差し替えた単語がチップに反映されていない: 候補=${candSurface} チップ=${lockedSurface}`);
	const committed = await editor.evaluate((surface) => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return data.results.flat().find((w) => w.surface === surface && w.locked);
	}, lockedSurface);
	assert(committed && String(committed.id) === candId && committed.kana === candKana &&
		Array.isArray(committed.pronunciation) && committed.pronunciation.length > 0,
		"候補のIDと読みを保って差し替えが保存されない: " + JSON.stringify(committed));

	const afterReplacement = await editor.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return { results: JSON.stringify(data.results), history: data.history.length };
	});
	assert(afterReplacement.history === beforeReplacement.history + 1,
		"候補のクリックが1回の変更履歴として保存されない");
	await editor.click("#btn-undo");
	assert(await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results)) === beforeReplacement.results,
		"1回の取り消しで候補選択前の歌詞に戻らない");
	await editor.click("#btn-redo");
	assert(await editor.evaluate(() =>
		JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results)) === afterReplacement.results,
		"やり直しで候補の差し替えが復元されない");

	// ---- 固定中以外を再生成: 固定した単語が保持される ----
	await regenerateAll(editor);
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);
	const lockedAfter = await editor.$$eval(".review-word.locked .review-word-surface",
		(els) => els.map((e) => e.textContent));
	assert(lockedAfter.includes(lockedSurface), "再生成で固定単語が失われた");

	// ---- 戻る(undo): 再生成前の状態に戻せる ----
	const wordsAfterRegen = await editor.$$eval(".review-word-surface", (els) => els.length);
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
	await menuAction(editor, "#btn-copy");
	await editor.waitForFunction(() => window.__copied !== null, undefined, { timeout: 10000 });
	const copied = await editor.evaluate(() => window.__copied);
	assert(copied.includes("使用単語一覧："), "コピー結果に使用単語一覧がない:\n" + copied);
	assert(copied.includes(lockedSurface), "コピー結果に差し替えた単語がない:\n" + copied);

	// ---- 書き出し→読み込み: 編集状態をファイルで往復できる ----
	const wordsBeforeImport = await editor.$$eval(".review-word-surface",
		(els) => els.map((e) => e.textContent).join("|"));
	const [download] = await Promise.all([
		editor.waitForEvent("download"),
		menuAction(editor, "#btn-export"),
	]);
	const exportPath = await download.path();
	// 空の編集画面(sessionStorageなし)から読み込んで再開できること
	await editor.evaluate(() => sessionStorage.clear());
	await editor.reload();
	await editor.waitForSelector("#editor-empty:not([hidden])", { timeout: 10000 });
	await editor.setInputFiles("#import-file", exportPath);
	await editor.waitForSelector(".editor-line .review-word", { timeout: 30000 });
	const wordsAfterImport = await editor.$$eval(".review-word-surface",
		(els) => els.map((e) => e.textContent).join("|"));
	assert(wordsAfterImport === wordsBeforeImport,
		`読み込みで単語列が変わった: ${wordsBeforeImport} -> ${wordsAfterImport}`);
	// wordlist情報も引き継がれ、候補機能(再生成)が使える状態になる
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 120000 },
	);

	// ---- 音節単位の対応: 一音節に複数の文字がある語 ----
	await page.fill("#input-text", "赤とんぼ\n赤ちゃん\n東京");
	await page.click("#btn-convert");
	await page.waitForFunction(() => !document.getElementById("btn-convert").disabled,
		undefined, { timeout: 120000 });
	const [alignmentEditor] = await Promise.all([
		context.waitForEvent("page"), page.click("#btn-open-editor"),
	]);
	alignmentEditor.on("pageerror", (e) => pageErrors.push(e));
	const waitForAlignmentEditor = async () => {
		await alignmentEditor.waitForSelector(".editor-line .review-word", { timeout: 60000 });
		await alignmentEditor.waitForFunction(() => !document.getElementById("btn-regenerate").disabled,
			undefined, { timeout: 120000 });
	};
	await waitForAlignmentEditor();
	const alignmentState = () => alignmentEditor.evaluate(() =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const readAlignment = () => alignmentEditor.$$eval(".panel-align .align-cell",
		(cells) => cells.map((cell) => [cell.querySelector(".align-surface").textContent,
			cell.querySelector(".align-yomi").textContent]));
	const expectAlignment = async (expected) => assert(
		JSON.stringify(await readAlignment()) === JSON.stringify(expected),
		`音節と表記の対応が違う: ${JSON.stringify(await readAlignment())}`);
	const openAlignment = async (line = 0) => {
		await selectRange(alignmentEditor, line, 0);
		await alignmentEditor.click(".panel-yomi-toggle");
		await alignmentEditor.click("#reading-fix-align-details > summary");
	};
	const automaticAlignment = [["赤", "アカ"], ["とん", "トン"], ["ぼ", "ボ"]];
	const movedAlignment = [["赤", "ア"], ["とん", "カトン"], ["ぼ", "ボ"]];
	const originalAlignmentState = await alignmentState();
	await openAlignment();
	await expectAlignment(automaticAlignment);
	await alignmentEditor.click("#btn-reading-fix-apply");
	assert(JSON.stringify(await alignmentState()) === JSON.stringify(originalAlignmentState),
		"無変更で適用しても保存状態を変えないこと");
	await openAlignment();
	await alignmentEditor.getByRole("button", { name: "とんへ読みを1つ移す", exact: true }).first().click();
	await expectAlignment(movedAlignment);
	await alignmentEditor.click("#btn-reading-fix-cancel");
	assert(JSON.stringify(await alignmentState()) === JSON.stringify(originalAlignmentState),
		"音節の移動をキャンセルすると保存状態を変えないこと");
	await openAlignment();
	await alignmentEditor.getByRole("button", { name: "とんへ読みを1つ移す", exact: true }).first().click();
	await alignmentEditor.click("#btn-reading-fix-apply");
	const movedAlignmentState = await alignmentState();
	assert(JSON.stringify(movedAlignmentState.tokensList[0][0].manualAlign) === JSON.stringify(movedAlignment),
		"複数文字への音節の移動を保存できない");
	assert(JSON.stringify(movedAlignmentState.unitsList[0].map((u) => [u.surface_form, u.pronunciation])) ===
		JSON.stringify([["赤", "ア"], ["とん", "カ"], ["", "トン"], ["ぼ", "ボ"]]),
		"保存後の発音ユニットに手動の表記対応が反映されない");
	assert(JSON.stringify(movedAlignmentState.results) === JSON.stringify(originalAlignmentState.results),
		"対応だけの変更で候補が変わった");
	await alignmentEditor.click("#btn-undo");
	assert(JSON.stringify((await alignmentState()).unitsList) === JSON.stringify(originalAlignmentState.unitsList),
		"取り消しで音節と表記の対応が戻らない");
	await alignmentEditor.click("#btn-redo");
	await alignmentEditor.reload();
	await waitForAlignmentEditor();
	await openAlignment();
	await expectAlignment(movedAlignment);
	await alignmentEditor.click(".align-reset");
	await expectAlignment(automaticAlignment);
	await alignmentEditor.click("#btn-reading-fix-apply");
	assert(JSON.stringify((await alignmentState()).unitsList) === JSON.stringify(originalAlignmentState.unitsList),
		"自動に戻した対応が保存されない");
	assert(!(await alignmentState()).tokensList[0][0].manualAlign, "リセット後に手動対応が残った");
	await openAlignment(1);
	await expectAlignment([["赤", "アカ"], ["ちゃん", "チャン"]]);
	await alignmentEditor.getByRole("button", { name: "ちゃんへ読みを1つ移す", exact: true }).click();
	await expectAlignment([["赤", "ア"], ["ちゃん", "カチャン"]]);
	await alignmentEditor.click("#btn-reading-fix-cancel");
	await openAlignment(2);
	await expectAlignment([["東", "トー"], ["京", "キョー"]]);
	assert(await alignmentEditor.locator(".align-arrow:enabled").count() === 0,
		"分割できない音節の境界で矢印が有効になっている");
	await alignmentEditor.click("#btn-reading-fix-cancel");
	await alignmentEditor.setViewportSize({ width: 390, height: 844 });
	await openAlignment();
	await expectAlignment(automaticAlignment);
	assert(await alignmentEditor.locator(".panel-align-row").evaluate((row) => {
		const rect = row.getBoundingClientRect();
		return rect.left >= 0 && rect.right <= window.innerWidth && row.scrollWidth <= row.clientWidth;
	}), "スマートフォン幅で表記と読みの対応がはみ出す");
	await alignmentEditor.click("#btn-reading-fix-cancel");

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor smoke test passed");
	exitCode = 0;
	await browser.close();
} catch (err) {
	console.error("[FAIL]", err);
} finally {
	try {
		process.kill(-preview.pid);
	} catch {}
	process.exit(exitCode);
}
