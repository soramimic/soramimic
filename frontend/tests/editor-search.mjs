import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { buildApp } from "../../tests/golden/harness-lib.mjs";

const print = console.log.bind(console);
const { app } = await buildApp();
const phrases = ["あ空", "空", "", "風"];
const tokensList = app.textAnalyzer.tokenizeTogether(phrases);
const unitsList = tokensList.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row));
const csvText = "id,original,surface,pronunciation\n1,空,空,ソラ\n2,風,風,カゼ\n3,花,花,ハナ\n4,宇宙,宇宙,ソラ";
const db = await app.wordList.parseTidy(csvText, "");
const param = { DUPLICATE: false, VARIATION_COST: 16, VOWEL_RATIO: .8,
	SAME_PHRASE_BREAK_REWARD: 0, MID_PHRASE_BREAK_PENALTY: 20, WORD_NUMBER_PENALTY: 20 };
const word = app.soramimiMaker.getCandidates(db, ["ソ", "ラ"], param, 1)[0];
const seed = {
	phrases, tokensList, unitsList, param,
	wordlist: { value: "ORIGINAL", text: "テスト", csvText },
	results: [[{
		id: "custom-fixed", surface: "あ", kana: "ア", pronunciation: ["ア"],
		period: [0, 1], original_surface: "あ", originalkana: "ア", locked: true,
	}, { filler: true, surface: "ソラ", period: [1, 3] }], [
		{ ...word, period: [0, 2], original_surface: "空", originalkana: "ソラ" },
	], [], []],
	dirtyLines: [0, 3], history: [], future: [],
	weightsList: [[1, 2, 1], [1, 1], [], [1, 1]],
};
const port = 4613;
const base = `http://localhost:${port}`;
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
	stdio: "ignore", detached: true,
});
let browser;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (i > 100) throw new Error("preview server did not start");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 740 } });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const ready = () => page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled, undefined, { timeout: 60000 });
	const searchDone = () => page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("ハイライト"));
	for (const review of [false, true]) {
		const session = structuredClone(seed);
		if (review) {
			session.host = { review: true };
			session.originalLines = ["あ、空", "空", "", "風"];
		}
		await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), session);
		await page.reload();
		await ready();
		assert.equal(await page.locator(".line-regenerate").count(), 3, "blank lines have no regenerate action");
		await page.click("#reverse-search > summary");
		assert.equal(await page.locator("#reverse-search input").count(), 1, "search uses a single reading field");
		assert.equal(await page.locator("#reverse-clear").isVisible(), false, "empty input has no clear icon");
		const initial = await state();
		await page.getByLabel("使いたい単語の読み", { exact: true }).fill("ソラ");
		await searchDone();
		assert.deepEqual((await state()).results, initial.results, "search must not edit lyrics");
		assert.deepEqual((await state()).history, initial.history, "search must not add history");
		const firstMatch = page.locator('[data-line="0"] .reverse-highlight[data-start="1"][data-end="3"]');
		assert.equal(await firstMatch.getAttribute("data-start"), "1");
		assert.equal(await firstMatch.getAttribute("data-end"), "3");
		assert.equal(await firstMatch.textContent(), review ? "あ、空" : "空");
		assert.equal(await page.locator('[data-line="0"] .review-original').textContent(), review ? "あ、空" : "あ空",
			"highlighting preserves the displayed original lyrics");
		assert.equal(await page.locator(".reverse-choices, .reverse-match").count(), 0, "no separate candidate cards");
		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme });
			for (const width of [320, 390, 1200]) {
				await page.setViewportSize({ width, height: 740 });
				const inputBox = await page.locator("#reverse-word").boundingBox();
				const clearBox = await page.getByRole("button", { name: "入力を消す", exact: true }).boundingBox();
				assert(clearBox.width >= 44 && clearBox.height >= 44, "clear icon keeps a touch-sized target");
				assert(clearBox.x >= inputBox.x && clearBox.x + clearBox.width <= inputBox.x + inputBox.width,
					"clear icon is inside the input's right edge");
				const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")]
					.filter((node) => node.getBoundingClientRect().right > innerWidth + 1 && node.getClientRects().length)
					.map((node) => ({ tag: node.tagName, id: node.id, class: node.className, right: node.getBoundingClientRect().right })));
				const dimensions = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
				assert(dimensions[0] <= dimensions[1], `search should fit ${width}px: ${JSON.stringify({ dimensions, overflow })}`);
			}
		}
		await page.setViewportSize({ width: 390, height: 740 });
		if (process.env.EDITOR_SCREENSHOTS && !review) {
			await page.emulateMedia({ colorScheme: "light" });
			await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
			await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/reverse-search.png`, animations: "disabled" });
		}
		if (review) {
			await firstMatch.focus();
			await firstMatch.press("Enter");
		} else {
			await firstMatch.click();
		}
		assert.equal(await page.inputValue(".panel-free-surface"), "ソラ");
		assert.equal(await page.inputValue(".panel-free-reading"), "ソラ");
		assert.equal(await page.locator('.review-unit[aria-pressed="true"]').count(), 2);
		await page.click(".panel-free-apply");
		assert((await state()).results[0].some((item) => item.surface === "ソラ" && item.locked));
		await page.click("#btn-undo");
		assert.deepEqual((await state()).results, initial.results);
		await page.click("#btn-redo");
		assert((await state()).results[0].some((item) => item.surface === "ソラ" && item.locked));
		await page.click("#btn-undo");
		await page.click("#reverse-search > summary");
		assert.equal(await page.locator(".reverse-highlight").count(), 0, "closing search clears highlights");
		await page.click("#reverse-search > summary");
		await searchDone();
		await page.fill("#reverse-word", "かぜ");
		await searchDone();
		const windMatch = page.locator('[data-line="3"]').getByRole("button", { name: "「風」を編集（読み：カゼ）", exact: true });
		assert(await windMatch.isVisible());
		await page.fill("#reverse-word", "ｶｾﾞ");
		await searchDone();
		await windMatch.click();
		assert.equal(await page.inputValue(".panel-free-reading"), "カゼ", "half-width kana is normalized");
		await page.click(".panel-close");
		await page.fill("#reverse-word", "空");
		await page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("ひらがな・カタカナで入力"));
		assert.equal(await page.locator(".reverse-highlight").count(), 0, "non-kana input clears stale matches");
		await page.fill("#reverse-word", "ン".repeat(30));
		await page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("複雑"));
		assert.equal(await page.locator(".reverse-highlight").count(), 0, "invalid reading clears stale matches");
		await page.click("#reverse-clear");
		assert.equal(await page.inputValue("#reverse-word"), "");
		assert.equal(await page.locator("#reverse-clear").isVisible(), false);
		assert.equal(await page.locator("#reverse-word").evaluate((node) => node === document.activeElement), true);
		assert.equal(await page.locator(".reverse-highlight").count(), 0);
		await page.fill("#reverse-word", "ソラ");
		await page.locator("#reverse-word").evaluate((node) => {
			node.value = "かぜ";
			node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
		});
		await page.waitForTimeout(350);
		assert.equal(await page.textContent("#reverse-status"), "", "IME composition cancels the pending search");
		assert.equal(await page.locator(".reverse-highlight").count(), 0);
		await page.locator("#reverse-word").dispatchEvent("compositionend");
		await searchDone();
		assert(await windMatch.isVisible());
		await page.fill("#reverse-word", "ソラ");
		await page.fill("#reverse-word", "カゼ");
		await searchDone();
		assert(await windMatch.isVisible());
		await page.locator("#reverse-word").press("Tab");
		assert.equal(await page.locator("#reverse-clear").evaluate((node) => node === document.activeElement), true);
		await page.keyboard.press("Enter");
		assert.equal(await page.inputValue("#reverse-word"), "", "clear works with the keyboard");
		const beforeRegen = await state();
		await page.locator('[data-line="0"] .line-regenerate').click();
		await ready();
		const afterRegen = await state();
		assert.deepEqual(afterRegen.results.slice(1), beforeRegen.results.slice(1), "other lines, empty rows and gaps must be untouched");
		assert.deepEqual(afterRegen.results[0][0], beforeRegen.results[0][0], "locked word must survive");
		assert(afterRegen.results[0].some((item) => !item.filler && item.id !== "custom-fixed"));
		assert(afterRegen.results[0].every((item) => item.id !== word.id), "reserve words used by later lines");
		assert.deepEqual(afterRegen.dirtyLines, beforeRegen.dirtyLines.filter((line) => line !== 0));
		assert.deepEqual(afterRegen.tokensList, beforeRegen.tokensList);
		assert.deepEqual(afterRegen.unitsList, beforeRegen.unitsList);
		assert.deepEqual(afterRegen.originalLines, beforeRegen.originalLines);
		assert.deepEqual(afterRegen.weightsList, beforeRegen.weightsList);
		await page.click("#btn-undo");
		assert.deepEqual((await state()).results, beforeRegen.results, "one undo restores the whole regeneration");
		await page.click("#btn-redo");
		assert.deepEqual((await state()).results, afterRegen.results);
		await page.reload();
		await ready();
		assert.deepEqual((await state()).results, afterRegen.results, "regeneration persists across reload");
	}
	assert.deepEqual(errors, []);
	print("[ok] standalone/review kana search, highlights, replacement, IME, inline clear, responsive layout, isolated regeneration, locks, duplicate avoidance, history and persistence");
} finally {
	await browser?.close();
	try { process.kill(-server.pid, "SIGTERM"); } catch {}
}
