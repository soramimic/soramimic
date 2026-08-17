// 回帰テスト: 読み修正で「かなsurfaceに、そのかなが途中一致する長い読み」を与えても
// クラッシュ・状態汚染・undo/redo不整合が起きないこと。
//
// 再現していた不具合:
//   - character.js kanaAllocate が、かな区間が先頭セグメント(i===0)のとき
//     separated_surface[-1]=undefined を参照してthrow。
//   - editor.js applyReadingFix が「先にtokensList書き換え→後で導出」だったため、
//     導出がthrowするとtokensListだけ汚染(読み二重化)され unitsList は古いまま。
//     undo/redoでその不整合が保存・再露出し、以降の再導出で再throw=レンダラ固着。
//
// 最小再現: 「変換する」→編集ツール→かなトークン「する」(チップ「ス」)を選択→
//   読み修正フォームに「ヘンカンスル」(するのカナが末尾=途中一致、先頭に非対応の
//   ヘンカンが付く)を入力→修正実行。
//
// 実行: npm run build && node tests/regression-readingfix-kana.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4499;
const STORAGE_KEY = "soramimic-editor";

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

	// ---- 生成画面: 「変換する」を変換して編集ツールを開く ----
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	await page.fill("#input-text", "変換する");
	await page.click("#btn-convert");
	await page.waitForFunction(
		() => {
			const out = document.getElementById("output-text");
			return !document.getElementById("output-field").hidden && out.value.length > 0;
		},
		{ timeout: 120000 },
	);

	const [editor] = await Promise.all([
		context.waitForEvent("page"),
		page.click("#btn-open-editor"),
	]);
	editor.on("pageerror", (e) => pageErrors.push(e));

	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 60000 });
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		{ timeout: 120000 },
	);

	// 前提確認: 「変換する」がヘンカンスルと読まれていること
	const kanaBefore = await editor.$$eval(".chip-unit",
		(els) => els.map((e) => e.textContent).join(""));
	assert(kanaBefore === "ヘンカンスル",
		"前提: アライン表示の読みが想定外(kuromoji非決定?): " + kanaBefore);

	// ---- かなトークン「する」を選択(チップ「ス」をクリック→トークン境界スナップ) ----
	await editor.locator(".chip-unit", { hasText: "ス" }).first().click();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const editLabel = await editor.getAttribute(".panel-yomi-toggle", "aria-label");
	// 対象が かなトークン「する」(読みスル) であること = 先頭セグメントかな経路を通す前提
	assert(editLabel.includes("する") && editLabel.includes("スル"),
		"読み修正の対象が「する」でない: " + editLabel);

	// ---- 読み修正: する に「ヘンカンスル」(するが末尾で途中一致する長い読み)を与える ----
	await editor.click(".panel-yomi-toggle");
	await editor.fill(".panel-yomi .input", "ヘンカンスル");
	await editor.click(".panel-yomi .btn-primary");
	// 修正が受理された(=「かなで入力してください」等のエラー表示が出ない)こと。
	// applyReadingFixが成功すると選択が張り直され panel-title が更新される。
	await editor.waitForFunction(
		() => {
			const note = document.querySelector(".panel-yomi-note");
			return !note || note.textContent === "";
		},
		{ timeout: 10000 },
	);
	// 描画の静定を待つ
	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 10000 });
	await editor.waitForTimeout(300);

	// (a) この時点までにページエラー(kanaAllocateのthrow等)が出ていないこと
	assert(pageErrors.length === 0,
		"読み修正でページエラー: " + pageErrors.map((e) => e.message).join("; "));

	// (b) tokensList(正データ)が汚染されていないこと:
	//     どのトークンのpronunciationにも「ヘンカンヘンカン」等の二重化が無い。
	const stateAfterFix = await editor.evaluate((key) => {
		const raw = sessionStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	}, STORAGE_KEY);
	assert(stateAfterFix && Array.isArray(stateAfterFix.tokensList),
		"sessionStorageからtokensListが取得できない");
	const flatPron = stateAfterFix.tokensList
		.flat()
		.map((t) => t.pronunciation || "")
		.join("|");
	assert(!flatPron.includes("ヘンカンヘンカン"),
		"tokensListのpronunciationが二重化: " + flatPron);
	// unitsListのsurfaceも「するする」等に複製されていないこと
	const flatUnitSurface = (stateAfterFix.unitsList || [])
		.flat()
		.map((u) => u.surface_form || "")
		.join("");
	assert(!flatUnitSurface.includes("するする"),
		"unitsListのsurfaceが複製された: " + flatUnitSurface);

	// 修正が実際に反映され、表示が変化していること(=テストが意味を持つことの確認)
	const kanaAfterFix = await editor.$$eval(".chip-unit",
		(els) => els.map((e) => e.textContent).join(""));
	assert(kanaAfterFix !== kanaBefore,
		"読み修正が反映されていない(表示が変わらない): " + kanaAfterFix);

	// (c) undo→redo しても状態が一貫し、pageerror/再throwが起きないこと
	assert(!(await editor.isDisabled("#btn-undo")), "読み修正後なのに戻るボタンが無効");
	await editor.click("#btn-undo");
	await editor.waitForFunction(
		() => !document.getElementById("btn-redo").disabled,
		{ timeout: 10000 },
	);
	await editor.waitForTimeout(200);
	const kanaAfterUndo = await editor.$$eval(".chip-unit",
		(els) => els.map((e) => e.textContent).join(""));
	assert(kanaAfterUndo === kanaBefore,
		`undoで元の読みに戻らない: 期待="${kanaBefore}" 実際="${kanaAfterUndo}"`);

	await editor.click("#btn-redo");
	await editor.waitForFunction(
		() => !document.getElementById("btn-undo").disabled,
		{ timeout: 10000 },
	);
	await editor.waitForTimeout(200);
	const kanaAfterRedo = await editor.$$eval(".chip-unit",
		(els) => els.map((e) => e.textContent).join(""));
	assert(kanaAfterRedo === kanaAfterFix,
		`redoで修正後の状態に戻らない: 期待="${kanaAfterFix}" 実際="${kanaAfterRedo}"`);

	// redo後のtokensListも汚染されていないこと(undo/redoで不整合が再露出しない)
	const stateAfterRedo = await editor.evaluate((key) => {
		const raw = sessionStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	}, STORAGE_KEY);
	const flatPronRedo = stateAfterRedo.tokensList
		.flat()
		.map((t) => t.pronunciation || "")
		.join("|");
	assert(!flatPronRedo.includes("ヘンカンヘンカン"),
		"redo後のtokensListが二重化: " + flatPronRedo);

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] regression-readingfix-kana test passed");
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
