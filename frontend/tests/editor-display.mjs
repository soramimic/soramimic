import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { menuAction } from "./editor-ui.mjs";

const browserType = process.env.DISPLAY_BROWSER === "webkit" ? webkit : chromium;
const port = browserType === webkit ? 4772 : 4771;
const base = `http://localhost:${port}`;
const phrases = ["カタヒカリ", "ソラ", "カゼ", ""];
const word = (id, surface, kana, start, end, locked = false) => ({
	id, surface, kana, pronunciation: [...kana], period: [start, end], locked,
	original_surface: phrases[0].slice(start, end), originalkana: phrases[0].slice(start, end),
});
const seed = {
	phrases,
	tokensList: phrases.map((text) => text ? [{ surface_form: text, pronunciation: text, reading: text, pos: "名詞" }] : []),
	unitsList: phrases.map((text) => [...text].map((pronunciation) => ({ pronunciation, surface_form: pronunciation, phrase: 0 }))),
	results: [[word("1", "型", "カタ", 0, 2, true), word("2", "光", "ヒカリ", 2, 5)],
		[{ ...word("3", "空", "ソラ", 0, 2, true), original_surface: "ソラ", originalkana: "ソラ" }],
		[{ filler: true, surface: "カゼ", period: [0, 2] }], []],
	wordlist: { value: "ORIGINAL", csvText: "id,original,surface,pronunciation\n1,型,型,カタ\n2,光,光,ヒカリ\n3,空,空,ソラ\n" },
	param: { VOWEL_RATIO: .8, DUPLICATE: true }, history: [], future: [], dirtyLines: [],
};
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore", detached: true });
let browser;
try {
	for (let attempt = 0; ; attempt++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (attempt > 100) throw new Error("preview did not start");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	browser = await browserType.launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 812 }, hasTouch: true });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	// Existing display choices predate the reading switches.
	await page.evaluate(() => localStorage.setItem("soramimic-editor-display", JSON.stringify({
		wordClear: false, wordLock: false, lineLock: false,
	})));
	const ready = () => page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled, undefined, { timeout: 60000 });
	const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const row = (line = 0) => page.locator(`.review-line[data-line="${line}"]`);
	const openDisplay = () => menuAction(page, "#btn-display-settings");
	const closeDisplay = () => page.click("#btn-display-settings-close");
	for (const review of [false, true]) {
		const data = structuredClone(seed);
		if (review) { data.host = { review: true }; data.originalLines = [...phrases]; }
		await page.evaluate((data) => sessionStorage.setItem("soramimic-editor", JSON.stringify(data)), data);
		await page.reload();
		await ready();
		if (review) {
			await openDisplay();
			await page.click('[data-display-preset="default"]');
			await closeDisplay();
		}
		assert.equal(await page.locator(".inline-edit-action").count(), 0, "default keeps the existing compact overview");
		assert.equal(await page.locator(".review-reading").count(), 3, "source readings default to visible, including legacy preferences");
		assert.equal(await page.locator(".review-word-reading").count(), 0, "parody readings default to hidden");
		const initial = await state();
		await openDisplay();
		assert.equal(await page.locator('[data-display-preset="default"]').getAttribute("aria-pressed"), "true");
		assert(await page.isChecked("#display-originalReading"));
		assert(!(await page.isChecked("#display-parodyReading")));
		await page.uncheck("#display-originalReading");
		assert.equal(await page.locator(".review-reading").count(), 0);
		assert.equal(await row().locator(".review-original").textContent(), phrases[0], "hiding the reading preserves the source lyrics");
		await page.check("#display-parodyReading");
		assert.equal(await page.locator(".review-word-reading").count(), 3);
		assert.deepEqual(await row().locator(".review-word-reading").allTextContents(), ["かた", "ひかり"]);
		assert.equal(await row(2).locator(".review-word-reading").count(), 0, "unassigned text gets no duplicate reading");
		assert.equal(await page.locator(".review-reading").count(), 0, "the reading switches are independent");
		await page.click('[data-display-preset="default"]');
		assert.equal(await page.locator(".review-reading").count(), 3);
		assert.equal(await page.locator(".review-word-reading").count(), 0);
		await page.click('[data-display-preset="expert"]');
		assert.equal(await page.locator(".editor-display-options input:checked").count(), 5);
		assert.equal(await page.locator(".review-reading").count(), 3);
		assert.equal(await page.locator(".review-word-reading").count(), 3);
		assert.equal(await page.locator(".word-quick-clear").count(), 3);
		assert.equal(await page.locator(".word-quick-lock").count(), 3);
		assert.equal(await page.locator(".line-quick-lock").count(), 3, "blank rows have no actions");
		assert(await row(2).locator(".line-quick-lock").isDisabled(), "unassigned text cannot be locked");
		assert.deepEqual(await state(), initial, "display choices do not edit lyrics or history");
		await page.uncheck("#display-wordClear");
		assert.equal(await page.locator(".word-quick-clear").count(), 0);
		assert.equal(await page.locator(".word-quick-lock").count(), 3);
		assert.equal(await page.locator('[data-display-preset][aria-pressed="true"]').count(), 0, "individual choices can be custom");
		await page.uncheck("#display-wordLock");
		assert.equal(await page.locator(".word-quick-lock").count(), 0);
		assert.equal(await page.locator(".line-quick-lock").count(), 3);
		await page.uncheck("#display-lineLock");
		assert.equal(await page.locator(".inline-edit-action").count(), 0);
		await page.uncheck("#display-parodyReading");
		assert.equal(await page.locator('[data-display-preset="default"]').getAttribute("aria-pressed"), "true");
		await page.click('[data-display-preset="expert"]');
		await closeDisplay();
		const firstLock = row().locator('.word-quick-lock[data-start="0"]');
		await firstLock.click();
		assert.equal((await state()).results[0][0].locked, false);
		assert.equal(await firstLock.getAttribute("aria-pressed"), "false");
		assert(await firstLock.evaluate((button) => button === document.activeElement), "word action retains keyboard focus");
		assert.equal(await page.locator("#editor-panel").evaluate((dialog) => dialog.open), false, "direct actions do not open candidate selection");
		await firstLock.click();
		assert.equal((await state()).results[0][0].locked, true);
		const beforeLine = await state();
		await row().locator(".line-quick-lock").click();
		const fixed = await state();
		assert(fixed.results[0].every((word) => word.locked), "mixed rows become fully locked");
		assert.deepEqual(fixed.results.slice(1), beforeLine.results.slice(1), "row actions leave other rows alone");
		assert.equal(fixed.history.length, beforeLine.history.length + 1, "one row action is one undo step");
		await row().locator(".line-quick-lock").click();
		assert((await state()).results[0].every((word) => !word.locked));
		await page.click("#btn-undo");
		await ready();
		assert((await state()).results[0].every((word) => word.locked));
		await page.click("#btn-redo");
		await ready();
		assert((await state()).results[0].every((word) => !word.locked));
		await row().locator(".line-quick-lock").click();
		const beforeGeneration = await state();
		await row().locator(".line-regenerate").click();
		await page.waitForFunction((n) => JSON.parse(sessionStorage.getItem("soramimic-editor")).history.length > n
			&& !document.getElementById("btn-regenerate").disabled, beforeGeneration.history.length);
		assert.deepEqual((await state()).results[0].map(({ surface, period, locked }) => ({ surface, period, locked })),
			beforeGeneration.results[0].map(({ surface, period, locked }) => ({ surface, period, locked })), "row locks survive regeneration");
		const beforeClear = await state();
		await row().locator('.word-quick-clear[data-start="0"]').click();
		const cleared = await state();
		assert.equal(cleared.results[0].length, 1);
		assert.equal(cleared.results[0][0].surface, "光");
		assert.equal(cleared.history.length, beforeClear.history.length + 1);
		assert.deepEqual(cleared.results.slice(1), beforeClear.results.slice(1));
		assert.deepEqual(cleared.tokensList, beforeClear.tokensList);
		assert.deepEqual(cleared.unitsList, beforeClear.unitsList);
		assert(await row().locator('.review-word.filler[data-start="0"]').evaluate((word) => word === document.activeElement));
		await page.click("#btn-undo");
		await ready();
		assert.deepEqual((await state()).results, beforeClear.results, "clear can restore the word and its lock in one undo");
		for (const width of [320, 390, 1024]) {
			await page.setViewportSize({ width, height: 812 });
			for (const colorScheme of ["light", "dark"]) {
				await page.emulateMedia({ colorScheme });
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "expert overview must fit");
				for (const button of await page.locator(".inline-edit-action").all()) {
					const box = await button.boundingBox();
					assert(box.width >= 44 && box.height >= 44, "direct actions must be touch accessible");
				}
				await openDisplay();
				assert(await page.locator("#editor-display-settings").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth));
				await closeDisplay();
			}
		}
		await page.setViewportSize({ width: 390, height: 812 });
		await page.emulateMedia({ colorScheme: "light" });
		if (!review && process.env.DISPLAY_SCREENSHOT_DIR) {
			const dir = process.env.DISPLAY_SCREENSHOT_DIR;
			await mkdir(dir, { recursive: true });
			await page.screenshot({ path: `${dir}/expert-overview.png` });
			await openDisplay();
			await page.screenshot({ path: `${dir}/display-controls.png` });
			await closeDisplay();
		}
		const beforePreferences = await state();
		await openDisplay();
		await page.uncheck("#display-wordLock");
		await page.uncheck("#display-originalReading");
		await page.check("#display-parodyReading");
		await closeDisplay();
		await page.reload();
		await ready();
		assert.equal(await page.locator(".word-quick-lock").count(), 0);
		assert.equal(await page.locator(".word-quick-clear").count(), 3);
		assert.equal(await page.locator(".line-quick-lock").count(), 3);
		assert.equal(await page.locator(".review-reading").count(), 0, "hidden source readings stay hidden after reload");
		assert.equal(await page.locator(".review-word-reading").count(), 3, "parody readings stay visible after reload");
		assert.deepEqual((await state()).results, beforePreferences.results);
		assert.deepEqual((await state()).history, beforePreferences.history);
	}
	// New sessions reuse the display choices without exporting them with lyrics.
	const next = await context.newPage();
	await next.goto(`${base}/editor.html`);
	await next.evaluate((data) => sessionStorage.setItem("soramimic-editor", JSON.stringify(data)), seed);
	await next.reload();
	await next.waitForSelector(".word-quick-clear");
	assert.equal(await next.locator(".word-quick-lock").count(), 0);
	assert.equal(await next.locator(".line-quick-lock").count(), 3);
	assert.equal(await next.locator(".review-reading").count(), 0);
	assert.equal(await next.locator(".review-word-reading").count(), 3);
	assert.deepEqual(errors, []);
	console.log(`[ok] editor display (${browserType.name()}): presets, independent source/parody readings, legacy preferences, persistent overview actions, per-word clear/lock, row lock/unlock, regeneration, undo/redo, review and responsive layout`);
} finally {
	await browser?.close();
	try { process.kill(-server.pid, "SIGTERM"); } catch {}
}
