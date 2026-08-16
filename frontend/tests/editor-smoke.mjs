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
	await page.fill("#input-text", "忘れがたき故郷\n12時\n漢字");
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
	const kanaBefore = await editor.$$eval(".chip-unit", (els) => els.map((e) => e.textContent).join(""));
	assert(kanaBefore === "ワスレガタキコキョーイチニジカンジ", "アライン表示の読みが想定外: " + kanaBefore);

	// 替え歌単語チップの詳細(ホバーの標準ツールチップ)にidまで含まれること
	const wordTitle = await editor.getAttribute(".chip-word", "title");
	assert(wordTitle && wordTitle.includes("→") && wordTitle.includes("ID:"),
		"替え歌単語チップの詳細が想定外: " + wordTitle);

	// ---- 回帰ガード: 複数桁数字の読み修正で拗音を分割しない ----
	// 12は1トークンだが、表示上は複数ユニット。どれをタップしても対象全体が
	// 12(イチニ)へスナップし、ジュウニへの修正後もジュウ/ニの2音節になる。
	await editor.locator('.editor-line[data-line="1"] .chip-unit').first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const numberToggle = await editor.textContent(".panel-yomi-toggle");
	assert(numberToggle.includes("12") && numberToggle.includes("イチニ"),
		"複数桁数字が読み修正の対象になっていない: " + numberToggle);
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ジュウニ");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		[...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit')]
			.map((e) => e.textContent).join("|") === "ジュウ|ニ|ジ",
		undefined, { timeout: 10000 });
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	assert(await editor.locator(".panel-candidates .candidate").count() > 0,
		"ジュウニへの読み修正後に候補が表示されない");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);

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
	assert((await editor.textContent(".panel-title")).includes("漢字(ジュウ)"),
		"複数漢字の読み修正で表層順が変わった");
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 回帰ガード: 数字＋漢字をまとめた読み修正でも拗音を分割しない ----
	// 12時の全ユニットを選びジュウニジを割り当てる。以前は時=ジが先頭のジへ
	// 誤対応し、残りがュから始まる別単位になって候補が消えていた。
	// いったん別行へ選択を移し、数字行では先頭を新しいアンカーにする。
	await editor.locator('.editor-line[data-line="0"] .chip-unit').first().click();
	const mixedLineUnits = editor.locator('.editor-line[data-line="1"] .chip-unit');
	await mixedLineUnits.first().click();
	await editor.waitForTimeout(300);
	await mixedLineUnits.last().click({ modifiers: ["Shift"] });
	await editor.waitForFunction(() =>
		document.querySelector(".panel-title")?.textContent.includes("12時(イチニジ)"),
		undefined, { timeout: 10000 });
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ジュウニジ");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(() =>
		[...document.querySelectorAll('.editor-line[data-line="1"] .chip-unit')]
			.map((e) => e.textContent).join("|") === "ジュウ|ニ|ジ",
		undefined, { timeout: 10000 });
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	assert(await editor.locator(".panel-candidates .candidate").count() > 0,
		"12時をまとめた読み修正後に候補が表示されない");
	await editor.click("#btn-undo"); // 後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 回帰ガード: かな区間の読みを長くしてもサーフェスが重複しないこと ----
	// (getYomiAndPhraseBreakは読み>サーフェスのモーラ数だとかなサーフェスを複製する。
	//  例: したい+シタイシタイ → したいしたい。applyReadingFixはそれを避ける)
	await editor.locator(".chip-unit", { hasText: "ガ" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const kanaToggle = await editor.textContent(".panel-yomi-toggle");
	const kanaSurface = kanaToggle.match(/元歌詞の読みを修正:\s*(.+?)\(/)[1]; // 対象サーフェス
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ガタガタ"); // 元より長い読み
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForSelector(".panel-title", { timeout: 10000 });
	const kanaSel = await editor.textContent(".panel-title");
	// 選択範囲表示は「サーフェス(読み)」形式。サーフェスが重複していないこと
	const kanaSelSurface = kanaSel.match(/選択範囲:\s*(.+?)\(/)[1];
	assert(kanaSelSurface === kanaSurface,
		`かな読み修正でサーフェスが重複: 期待="${kanaSurface}" 実際="${kanaSelSurface}"`);
	await editor.click("#btn-undo"); // 状態を戻して後続テストに影響させない
	await editor.waitForTimeout(300);

	// ---- 手動割当: 表層↔モーラの境界をユーザが動かせる ----
	// 「忘れ」(ワスレ)を選択 → 自動では 忘=ワス/れ=レ。▶で 忘 を1モーラ減らすと
	// 忘=ワ になり、そのモーラのチップ表層が付け替わること
	await editor.locator(".chip-unit", { hasText: "ワ" }).first().click();
	// 割当調整は「読みを修正」を開くと直接出る
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	await editor.click(".panel-yomi-toggle");
	await editor.waitForSelector(".editor-panel.open .panel-align", { timeout: 10000 });
	const alignBefore = await editor.textContent(".panel-align .align-cell");
	assert(alignBefore.includes("忘") && alignBefore.includes("ワス"),
		"手動割当の初期表示が想定外: " + alignBefore);
	// 境界の▶(右の文字へ1モーラ寄せる)を押す
	await editor.locator(".align-boundary .align-arrow").nth(1).click();
	await editor.waitForFunction(() => {
		const cell = document.querySelector(".panel-align .align-cell");
		return cell && cell.textContent.includes("忘") && cell.textContent.includes("ワ") &&
			!cell.textContent.includes("ワス");
	}, undefined, { timeout: 10000 });
	await editor.click("#btn-undo"); // 後続テストに影響させないため戻す
	await editor.waitForTimeout(300);

	// ---- 読み修正: コキョー → フルサト ----
	// 「コ」のユニットをタップ → トークン境界スナップで対象が「故郷」になる
	await editor.locator(".chip-unit", { hasText: "コ" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const toggleText = await editor.textContent(".panel-yomi-toggle");
	assert(toggleText.includes("故郷") && toggleText.includes("コキョー"),
		"読み修正の対象が想定外: " + toggleText);
	await editor.click(".panel-yomi-toggle");
	assert(await editor.evaluate(() => document.activeElement?.matches(".panel-yomi .input")),
		"読み修正フォームを開いても読み入力欄にフォーカスされない");
	await editor.fill(".panel-yomi .input", "ふるさと");
	await editor.click(".panel-yomi .btn-primary");
	await editor.waitForFunction(
		() => [...document.querySelectorAll(".chip-unit")].map((e) => e.textContent).join("")
			=== "ワスレガタキフルサトイチニジカンジ",
		undefined, { timeout: 10000 },
	);
	const selTitle = await editor.textContent(".panel-title");
	assert(selTitle.includes("フルサト"), "読み修正後の選択範囲が想定外: " + selTitle);

	// ---- 候補差し替え: 修正後の読みでの候補を選ぶと自動固定される ----
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	const candSurface = await editor.textContent(".candidate .candidate-surface");
	await editor.click(".panel-candidates .candidate");
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	const lockedSurface = await editor.textContent(".chip-word.locked .chip-word-surface");
	assert(candSurface.startsWith(lockedSurface),
		`差し替えた単語がチップに反映されていない: 候補=${candSurface} チップ=${lockedSurface}`);

	// ---- 固定以外を再生成: 固定した単語が保持される ----
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
