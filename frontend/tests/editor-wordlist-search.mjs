import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { buildApp } from "../../tests/golden/harness-lib.mjs";
import { searchWordlist } from "../src/editorWordlistSearch.js";

const print = console.log.bind(console);
const { app } = await buildApp();
const csv = "id,original,surface,pronunciation,enabled\n" + [
	"0,あ,あ,ア,yes", "1,Martha Chase,マーサ・チェイス,マーサチェイス,yes",
	"2,アルファ研究者,チェイス,チェイス,yes", "3,ベータ研究者,チェイス,チェイス,yes",
	"4,生,生,セイ,yes", "4,生,生,ショー,yes", "9,除外する語,対象外,タイショーガイ,no",
].join("\n");
const filtered = await app.wordList.parseTidy(csv, "enabled = yes");
for (const query of ["チェイス", "ちぇいす", "ﾁｪｲｽ"]) {
	const found = await searchWordlist(filtered, query);
	assert.equal(found.total, 3, "pronunciation variations are deduplicated, distinct IDs are retained");
	assert.equal(found.groups.length, 2, "same spelling/reading groups IDs together");
}
assert.equal((await searchWordlist(filtered, "martha chase")).total, 1);
assert.equal((await searchWordlist(filtered, "マーサチェイス")).total, 1);
assert.equal((await searchWordlist(filtered, "生")).groups.length, 2, "alternate readings are retained");
assert.equal((await searchWordlist(filtered, "対象外")).total, 0, "search respects the filtered DB");
const largeDb = { 1: Array.from({ length: 6000 }, (_, id) => ({
	id: String(id), surface: `検索${id}`, original: `正式${id}`, kana: "ア", pronunciation: ["ア"],
})) };
largeDb[1].push({ ...largeDb[1][0], id: "extra" });
const bounded = await searchWordlist(largeDb, "検索");
assert.equal(bounded.groups.length, 100);
assert.equal(bounded.total, 6001);
assert.equal(bounded.groups[0].cands.length, 2, "duplicate IDs remain selectable beyond the display cap");
const controller = new AbortController();
controller.abort();
await assert.rejects(searchWordlist(largeDb, "検索", { signal: controller.signal }), { name: "AbortError" });
const interrupted = new AbortController();
const pending = searchWordlist(largeDb, "検索", { signal: interrupted.signal });
setTimeout(() => interrupted.abort(), 0);
await assert.rejects(pending, { name: "AbortError" });
assert.equal((await searchWordlist(filtered, "正式")).total, 0, "switching DBs clears the index");

const phrases = ["あ", "い"];
const tokensList = app.textAnalyzer.tokenizeTogether(phrases);
const unitsList = tokensList.map((row) => app.textAnalyzer.getYomiAndPhraseBreak(row));
const seed = { phrases, tokensList, unitsList, param: { DUPLICATE: false },
	wordlist: { value: "BASEBALL", text: "テスト", filepath: "wordlists/search-test.csv", dbtype: "tidy" },
	where: "enabled = yes", history: [], future: [], dirtyLines: [],
	results: [[{ filler: true, surface: "ア", period: [0, 1] }], [
		{ id: "2", surface: "チェイス", original: "アルファ研究者", kana: "チェイス",
			pronunciation: app.textAnalyzer.yomiToSyllable("チェイス"), period: [0, 1], locked: true },
	]],
};
const port = 4667, base = `http://localhost:${port}`;
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
	browser = await (process.env.EDITOR_WORDLIST_SEARCH_BROWSER === "webkit" ? webkit : chromium).launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 740 }, hasTouch: true });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	await context.route("**/wordlists/search-test.csv", (route) => route.fulfill({ body: csv, contentType: "text/csv" }));
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const ready = () => page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled,
		undefined, { timeout: 60000 });
	const completed = () => page.waitForFunction(() => {
		const status = document.querySelector(".wordlist-search-status");
		return status && status.textContent && status.textContent !== "検索中…";
	});
	for (const review of [false, true]) {
		await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)),
			{ ...seed, ...(review ? { host: { review: true } } : {}) });
		await page.reload();
		await ready();
		const before = await state();
		await page.locator('.review-line[data-line="0"] .review-word').first().click();
		assert(await page.locator(".panel-free-toggle").isVisible(), "manual input stays separate");
		assert.equal(await page.locator('.panel-suggestions .candidate[data-candidate-id="1"]').count(), 0,
			"the desired long word is outside the similar candidates");
		const input = page.getByLabel("単語リストから検索", { exact: true });
		await input.fill("martha chase");
		await completed();
		assert.equal(await page.locator(".wordlist-search-results .candidate").count(), 1);
		assert(await page.locator(".panel-suggestions").isHidden());
		assert.equal(await input.evaluate((node) => document.activeElement === node), true, "typing preserves focus");
		assert.deepEqual(await state(), before, "search changes neither lyrics nor history");
		await input.fill("対象外");
		await completed();
		assert.equal(await page.textContent(".wordlist-search-status"), "一致する単語がありません");
		await input.fill("ちぇいす");
		await completed();
		assert.equal(await page.locator(".wordlist-search-results .candidate").count(), 2);
		await page.locator(".wordlist-search-results .candidate:has(.candidate-count)").click();
		assert(await page.locator('.group-entry[data-candidate-id="2"]').evaluate((node) => node.classList.contains("used")));
		await page.locator(".panel-back").click();
		assert.equal(await input.inputValue(), "ちぇいす", "return from duplicate selection preserves the query");
		await completed();
		await page.getByRole("button", { name: "検索を消す", exact: true }).click();
		assert.equal(await input.inputValue(), "");
		assert(await page.locator(".panel-suggestions").isVisible());
		await input.fill("生");
		await input.evaluate((node) => {
			node.value = "チェイス";
			node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
		});
		await page.waitForTimeout(200);
		assert.equal(await page.locator(".wordlist-search-results .candidate").count(), 0, "IME cannot select stale hits");
		await input.dispatchEvent("compositionend");
		await completed();
		await input.fill("Martha");
		await input.fill("ﾏｰｻﾁｪｲｽ");
		await completed();
		const hit = page.locator('.wordlist-search-results .candidate[data-candidate-id="1"]');
		assert(await hit.isVisible(), "only the latest query returns results");
		for (const width of [320, 390, 1200]) {
			await page.setViewportSize({ width, height: 740 });
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
				"search fits narrow and wide panels");
			assert((await input.boundingBox()).height >= 44);
		}
		await page.setViewportSize({ width: 390, height: 740 });
		if (process.env.EDITOR_SCREENSHOTS && !review) {
			await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
			await page.emulateMedia({ colorScheme: "light" });
			await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/wordlist-search-mobile.png`, animations: "disabled" });
		}
		await hit.focus();
		await hit.press("Enter");
		const after = await state();
		const placed = after.results[0][0];
		assert.equal(placed.id, "1", "selection preserves the list ID, rather than creating a custom word");
		assert.equal(placed.kana, "マーサチェイス");
		assert.deepEqual(placed.pronunciation, app.textAnalyzer.yomiToSyllable(placed.kana));
		assert.deepEqual(placed.period, [0, 1], "different length does not change the chosen lyric range");
		assert.equal(placed.locked, true);
		assert(placed.wordlistSource);
		assert.equal(placed.sim, undefined, "a search hit has no invented similarity score");
		assert.deepEqual(after.tokensList, before.tokensList);
		assert.deepEqual(after.unitsList, before.unitsList);
		assert.deepEqual(after.results[1], before.results[1]);
		await page.locator(".panel-close").click();
		await page.click("#btn-undo");
		assert.deepEqual((await state()).results, before.results);
		await page.click("#btn-redo");
		assert.deepEqual((await state()).results, after.results);
		await page.reload();
		await ready();
		assert.deepEqual((await state()).results, after.results, "search selection persists across reload");
	}
	assert.deepEqual(errors, []);
	print("[ok] list search: full filtered DB, spelling/name/kana, bounded results, duplicate IDs, IME, keyboard, responsive layout, saved replacement and undo/redo");
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
