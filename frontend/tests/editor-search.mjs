import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { buildApp } from "../../tests/golden/harness-lib.mjs";
import { selectRange } from "./editor-ui.mjs";

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
	browser = await (process.env.EDITOR_SEARCH_BROWSER === "webkit" ? webkit : chromium).launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const ready = () => page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled, undefined, { timeout: 60000 });
	const searchDone = () => page.waitForFunction(() => document.querySelector(".reverse-word-match") && !document.getElementById("reverse-status").textContent);
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
		const firstMatch = page.locator('[data-line="0"] .reverse-word-match[data-start="1"][data-end="3"]');
		assert(await firstMatch.isVisible(), "the matching parody word is highlighted");
		assert.equal(await firstMatch.getAttribute("aria-current"), "true");
		await page.click("#reverse-next");
		await page.click("#reverse-previous");
		assert.equal(await firstMatch.getAttribute("aria-current"), "true", "navigation also works without mapped source spelling");
		if (review) {
			assert.equal(await page.locator('[data-line="0"] .reverse-highlight').count(), 0,
				"different host spelling must not highlight the entire line");
		} else {
			assert.equal(await page.locator('[data-line="0"] mark.reverse-highlight').textContent(), "空");
		}
		assert.equal(await page.locator("button.reverse-highlight").count(), 0, "source highlights are not edit buttons");
		assert.equal(await page.locator('[data-line="0"] .review-original').textContent(), review ? "あ、空" : "あ空");
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
		assert.equal(await page.locator('.review-unit[aria-pressed="true"]').count(), 2);
		await page.click(".panel-free-toggle");
		await page.fill(".panel-free-surface", "ソラ");
		await page.click(".panel-free-apply");
		assert((await state()).results[0].some((item) => item.surface === "ソラ" && item.locked));
		await page.click(".panel-close");
		await page.click("#btn-undo");
		assert.deepEqual((await state()).results, initial.results);
		await page.click("#btn-redo");
		assert((await state()).results[0].some((item) => item.surface === "ソラ" && item.locked));
		await page.click("#btn-undo");
		await page.click("#reverse-search > summary");
		assert.equal(await page.locator(".reverse-highlight, .reverse-word-match").count(), 0, "closing search clears highlights");
		assert.equal(await page.locator("#reverse-next").isEnabled(), false, "closing search disables navigation");
		await page.click("#reverse-search > summary");
		await searchDone();
		await page.fill("#reverse-word", "かぜ");
		await searchDone();
		const windMatch = page.locator('[data-line="3"] .reverse-word-match');
		assert(await windMatch.isVisible());
		await page.fill("#reverse-word", "ｶｾﾞ");
		await searchDone();
		await windMatch.click();
		assert.equal((await page.locator('.review-unit[aria-pressed="true"]').allTextContents()).join(""), "カゼ", "half-width kana matches the right range");
		await page.click(".panel-close");
		await page.fill("#reverse-word", "空");
		await page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("ひらがな・カタカナで入力"));
		assert.equal(await page.locator(".reverse-highlight, .reverse-word-match").count(), 0, "non-kana input clears stale matches");
		assert.equal(await page.textContent("#reverse-count"), "0 / 0");
		assert.equal(await page.locator("#reverse-previous").isEnabled(), false);
		await page.fill("#reverse-word", "ン".repeat(30));
		await page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("複雑"));
		assert.equal(await page.locator(".reverse-highlight, .reverse-word-match").count(), 0, "invalid reading clears stale matches");
		await page.click("#reverse-clear");
		assert.equal(await page.inputValue("#reverse-word"), "");
		assert.equal(await page.locator("#reverse-clear").isVisible(), false);
		assert.equal(await page.locator("#reverse-word").evaluate((node) => node === document.activeElement), true);
		assert.equal(await page.locator(".reverse-highlight, .reverse-word-match").count(), 0);
		assert.equal(await page.textContent("#reverse-count"), "0 / 0");
		assert.equal(await page.locator("#reverse-next").isEnabled(), false);
		await page.fill("#reverse-word", "ソラ");
		await page.locator("#reverse-word").evaluate((node) => {
			node.value = "かぜ";
			node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
		});
		await page.waitForTimeout(350);
		assert.equal(await page.textContent("#reverse-status"), "", "IME composition cancels the pending search");
		assert.equal(await page.locator(".reverse-highlight, .reverse-word-match").count(), 0);
		assert.equal(await page.locator("#reverse-next").isEnabled(), false, "IME composition cannot visit stale hits");
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
	// Visit adjacent hits independently, then cross a long gap without losing the controls.
	const navigationPhrases = ["空空", ...Array(24).fill(""), "空"];
	const navigationTokens = app.textAnalyzer.tokenizeTogether(navigationPhrases);
	navigationTokens[0] = [...structuredClone(tokensList[1]), ...structuredClone(tokensList[1])];
	for (const review of [false, true]) {
		const session = { ...structuredClone(seed), phrases: navigationPhrases, tokensList: navigationTokens,
			unitsList: navigationTokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row)),
			results: navigationPhrases.map(() => []), history: [], future: [], dirtyLines: [], weightsList: null };
		if (review) {
			session.host = { review: true };
			session.originalLines = navigationPhrases;
		}
		await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), session);
		await page.reload();
		await ready();
		await page.setViewportSize({ width: 320, height: 640 });
		await page.click("#reverse-search > summary");
		const beforeNavigation = await state();
		await page.fill("#reverse-word", "ソラ");
		await searchDone();
		const upperPositions = () => page.locator(".site-header, #editor-toolbar, #reverse-next").evaluateAll(
			(nodes) => nodes.map((node) => {
				const { x, y, width, height } = node.getBoundingClientRect();
				return { x, y, width, height };
			}));
		let initialUpperPositions = await upperPositions();
		await page.evaluate(() => {
			window.navigationScrolls = [];
			window.addEventListener("scroll", () => window.navigationScrolls.push(scrollY));
		});
		const assertCurrent = async (index, line, character) => {
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			assert.equal(await page.evaluate(() => scrollY), 0, "hit navigation must not scroll the page behind the header");
			assert.deepEqual(await page.evaluate(() => window.navigationScrolls), [], "navigation must not move the page even temporarily");
			assert.equal(await page.textContent("#reverse-count"), `${index} / 3`);
			const current = page.locator("mark.reverse-current");
			assert.equal(await current.count(), 1, "only the active source hit is emphasized");
			assert.equal(await current.textContent(), "空");
			assert.equal(await current.evaluate((node) => Number(node.closest(".editor-line").dataset.line)), line);
			assert.equal(await current.evaluate((node) => {
				let length = 0;
				for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) length += sibling.textContent.length;
				return length;
			}), character, "adjacent hits have separate current highlights");
			assert.equal(await page.locator("#editor-panel").evaluate((node) => node.open), false, "navigation does not open the editor");
			const hitBox = await current.boundingBox();
			const toolbarBox = await page.locator("#editor-toolbar").boundingBox();
			assert(hitBox.y >= toolbarBox.y + toolbarBox.height && hitBox.y + hitBox.height <= page.viewportSize().height,
				"the active hit is visible below the search controls");
			const nextBox = await page.locator("#reverse-next").boundingBox();
			assert(nextBox.y >= 0 && nextBox.y + nextBox.height <= page.viewportSize().height, "controls stay on screen after moving");
			assert.deepEqual(await upperPositions(), initialUpperPositions,
				"the header, search toolbar and arrows stay in the same positions when visiting hits");
		};
		await assertCurrent(1, 0, 0);
		await page.locator("#reverse-next").tap();
		await assertCurrent(2, 0, 1);
		await page.locator("#reverse-next").tap();
		await assertCurrent(3, 25, 0);
		await page.locator("#reverse-next").tap();
		await assertCurrent(1, 0, 0);
		await page.locator("#reverse-previous").tap();
		await assertCurrent(3, 25, 0);
		await page.locator("#reverse-word").press("Shift+Enter");
		await assertCurrent(2, 0, 1);
		await page.locator("#reverse-word").press("Enter");
		await assertCurrent(3, 25, 0);
		assert(await page.locator("#reverse-word").evaluate((node) => node === document.activeElement), "keyboard navigation preserves input focus");
		await page.locator("#reverse-word").dispatchEvent("keydown", { key: "Enter", isComposing: true });
		await assertCurrent(3, 25, 0);
		for (const width of [390, 1200]) {
			await page.setViewportSize({ width, height: 640 });
			await page.locator("#reverse-next").tap();
			initialUpperPositions = await upperPositions();
			await assertCurrent(1, 0, 0);
			await page.locator("#reverse-previous").tap();
			await assertCurrent(3, 25, 0);
		}
		await page.setViewportSize({ width: 390, height: 420 });
		await page.locator("#reverse-next").tap();
		initialUpperPositions = await upperPositions();
		await assertCurrent(1, 0, 0);
		await page.locator("#reverse-previous").tap();
		await assertCurrent(3, 25, 0);
		assert(await page.locator("main").evaluate((node) => node.scrollTop > 500), "distant hits scroll inside the lyrics");
		assert.deepEqual(await state(), beforeNavigation, "navigation changes no lyrics, locks, selection history or saved state");
		await page.fill("#reverse-word", "カ".repeat(40));
		await page.waitForFunction(() => document.getElementById("reverse-status").textContent.includes("範囲がありません"));
		assert.equal(await page.textContent("#reverse-count"), "0 / 0");
		assert.equal(await page.locator("#reverse-next").isEnabled(), false);
		assert.equal(await page.locator(".reverse-current").count(), 0);
		await page.fill("#reverse-word", "ソラソラ");
		await searchDone();
		assert.equal(await page.textContent("#reverse-count"), "1 / 1");
		await page.locator("#reverse-next").tap();
		await page.locator("#reverse-previous").tap();
		assert.equal(await page.textContent("#reverse-count"), "1 / 1", "a single hit wraps to itself");
		await page.click("#reverse-clear");
		assert.equal(await page.textContent("#reverse-count"), "0 / 0");
		assert.equal(await page.locator(".reverse-current").count(), 0);
		await page.click("#reverse-search > summary");
		await page.locator('.review-line[data-line="25"]').scrollIntoViewIfNeeded();
		assert(await page.locator("#editor-toolbar").evaluate((node) => node.getBoundingClientRect().bottom < 0),
			"closing search restores the normal scrolling header");
	}
	// A query may end or start inside a kanji's reading; its surface still highlights.
	const partialPhrases = ["夕焼小焼の、赤とんぼ", "畑"];
	const partialTokens = app.textAnalyzer.tokenizeTogether(partialPhrases);
	const partialSeed = { ...structuredClone(seed), phrases: partialPhrases, tokensList: partialTokens,
		unitsList: partialTokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row)),
		results: [[], []], history: [], future: [], dirtyLines: [], weightsList: null };
	for (const review of [false, true]) {
		const session = structuredClone(partialSeed);
		if (review) {
			session.host = { review: true };
			session.originalLines = partialPhrases;
		}
		await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), session);
		await page.reload();
		await ready();
		await page.click("#reverse-search > summary");
		const beforeSearch = await state();
		await page.fill("#reverse-word", "ゆうや");
		await searchDone();
		assert((await page.locator('[data-line="0"] mark.reverse-highlight').allTextContents())
			.some((text) => text.startsWith("夕焼")), "ゆうや highlights 夕焼 despite ending inside 焼");
		await page.fill("#reverse-word", "たけ");
		await searchDone();
		assert.equal(await page.locator('[data-line="1"] mark.reverse-highlight').textContent(), "畑",
			"たけ highlights 畑 despite starting inside its reading");
		assert.deepEqual(await state(), beforeSearch, "partial reading search changes no saved editor state");
	}
	// Longer, worse matches must not crowd a closer short range out of the top ten.
	const rankingPhrases = [...Array(10).fill("キンンンン"), "キ"];
	const rankingTokens = app.textAnalyzer.tokenizeTogether(rankingPhrases);
	const rankingSeed = { ...structuredClone(seed), phrases: rankingPhrases, tokensList: rankingTokens,
		unitsList: rankingTokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row)),
		results: rankingPhrases.map(() => []), history: [], future: [], dirtyLines: [], weightsList: null };
	await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), rankingSeed);
	await page.reload();
	await ready();
	await page.click("#reverse-search > summary");
	await page.fill("#reverse-word", "か");
	await searchDone();
	assert.equal(await page.locator('[data-line="10"] mark.reverse-highlight').textContent(), "キ",
		"longer ranges with more deletion penalties must not displace the closer short match");
	assert.equal(await page.locator("mark.reverse-current").evaluate((node) => node.closest(".editor-line").dataset.line), "10",
		"navigation starts with the best-scoring hit even when it appears last in the lyrics");
	await page.click("#reverse-next");
	assert.equal(await page.locator("mark.reverse-current").evaluate((node) => node.closest(".editor-line").dataset.line), "0",
		"next visits the next-best score, with tied scores in lyric order");
	await page.click("#reverse-previous");
	assert.equal(await page.locator("mark.reverse-current").evaluate((node) => node.closest(".editor-line").dataset.line), "10");
	await page.click("#reverse-previous");
	assert.equal(await page.textContent("#reverse-count"), "10 / 10",
		"previous wraps from the best score to the last hit in the ranked shortlist");
	// Edit a source reading while reverse highlights are visible. The automatic
	// character allocation loses part of this token's spelling, but not the line.
	const source = "負われて見たのは、いつの日か";
	const correctedTokens = app.textAnalyzer.tokenizeTogether([source]);
	const correctionSeed = { ...structuredClone(seed), phrases: [source], tokensList: correctedTokens,
		unitsList: correctedTokens.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row)),
		results: [[]], history: [], future: [], dirtyLines: [0], weightsList: null };
	await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), correctionSeed);
	await page.reload();
	await ready();
	await page.click("#reverse-search > summary");
	await page.fill("#reverse-word", "コトーゲ");
	await searchDone();
	await selectRange(page, 0, 0);
	await page.click(".panel-yomi-toggle");
	await page.fill("#reading-fix-input", "コトーゲ");
	await page.click("#btn-reading-fix-apply");
	await searchDone();
	const afterCorrection = await state();
	assert.equal(afterCorrection.tokensList[0][0].pronunciation, "コトーゲ");
	assert.equal(await page.locator('[data-line="0"] .review-original').textContent(), source);
	const correctedHighlights = await page.locator('[data-line="0"] mark.reverse-highlight').allTextContents();
	assert(correctedHighlights.some((text) => text.startsWith("負わ")));
	assert(correctedHighlights.every((text) => text.length < source.length), "reading edit must not highlight the whole line");
	assert(await page.locator('.reverse-word-match').count() > 0, "parody highlights are recomputed after reading edits");
	await page.click("#btn-undo");
	await ready();
	await searchDone();
	assert.equal((await state()).tokensList[0][0].pronunciation, "オワ");
	await page.click("#btn-redo");
	await ready();
	await searchDone();
	assert((await page.locator('[data-line="0"] mark.reverse-highlight').allTextContents()).every((text) => text.length < source.length));
	assert.deepEqual(errors, []);
	print("[ok] standalone/review kana search, touch navigation and wrapping, keyboard/IME, stationary header, short viewport, adjacent highlights, replacement, inline clear, responsive layout, isolated regeneration, locks, duplicate avoidance, history and persistence");
} finally {
	await browser?.close();
	try { process.kill(-server.pid, "SIGTERM"); } catch {}
}
