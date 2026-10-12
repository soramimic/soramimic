import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 4763;
const base = `http://localhost:${port}`;
const source = "カタコオカンヒカリナ";
const word = (id, surface, kana, pronunciation, start, end) => ({
	id, surface, kana, pronunciation, period: [start, end], sim: -999,
	original_surface: source.slice(start, end), originalkana: source.slice(start, end),
});
const seed = {
	phrases: [source],
	tokensList: [[{ surface_form: source, pronunciation: source, reading: source, pos: "名詞" }]],
	unitsList: [[...source].map((pronunciation) => ({ pronunciation, surface_form: pronunciation, phrase: 0 }))],
	results: [[word("1", "型", "カタ", ["カ", "タ"], 0, 2),
		word("2", "校", "コー", ["コー"], 2, 4), word("3", "缶", "カン", ["カ", "ン"], 4, 6),
		word("4", "色", "ホコル", ["ホ", "コ", "ル"], 6, 9)]],
	wordlist: { value: "ORIGINAL", csvText: "id,original,surface,pronunciation\n1,型,型,カタ\n2,校,校,コー\n3,缶,缶,カン\n4,色,色,ホコル\n5,光,光,ヒカリ\n" },
	param: { VOWEL_RATIO: .8, DUPLICATE: true }, history: [], future: [],
};
const preview = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore", detached: true });
let browser;
try {
	for (let attempt = 0; ; attempt++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (attempt > 200) throw new Error("preview did not start");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(base);
	await page.evaluate((data) => sessionStorage.setItem("soramimic-editor", JSON.stringify(data)), seed);
	await page.goto(`${base}/editor.html`);
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	assert.equal(await page.locator(".visualization-badge").count(), 0);
	const before = await page.evaluate(() => sessionStorage.getItem("soramimic-editor"));
	await page.locator("#editor-visualization summary").click();
	for (const [kind, count] of [["vowel", 1], ["distance", 1], ["single", 2], ["filler", 1]]) {
		assert.equal(await page.locator(`#visualization-count-${kind}`).textContent(), `${count}か所`);
		await page.check(`#visualize-${kind}`);
	}
	assert.equal(await page.locator(".visualization-hit").count(), 4, "overlapping criteria count each word once");
	assert.equal(await page.locator(".visualization-badge").count(), 5);
	assert.equal(await page.locator("#visualization-summary").textContent(), "・4か所を強調");
	assert.match(await page.locator(".review-word").filter({ hasText: "色" }).getAttribute("aria-label"), /母音: イアイ → オオウ/);
	await page.fill("#visualization-threshold", "100");
	assert.equal(await page.locator(".visualization-distance").count(), 0);
	await page.fill("#visualization-threshold", "30");
	assert.equal(await page.locator(".visualization-distance").count(), 1);
	assert.equal(await page.evaluate(() => sessionStorage.getItem("soramimic-editor")), before, "display options must not change edits or history");
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	assert.equal(await page.locator(".visualization-badge").count(), 5, "preferences survive reload without needing to open the options");
	await page.locator("#editor-visualization summary").click();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile controls must fit");
	if (process.env.VISUALIZATION_SCREENSHOT) {
		await page.screenshot({ path: process.env.VISUALIZATION_SCREENSHOT, fullPage: true });
	}
	// Correct the highlighted word and verify the markers/counts follow edits and undo.
	await page.locator(".review-word").filter({ hasText: "色" }).click();
	assert.equal(await page.locator(".review-selected-word").textContent(), "色");
	await page.locator(".panel-free-toggle").click();
	await page.fill(".panel-free-surface", "光");
	await page.locator(".review-reading-input summary").click();
	await page.fill(".panel-free-reading", "ヒカリ");
	await page.locator(".panel-free-apply").click();
	await page.locator(".panel-close").click();
	assert.equal(await page.locator(".visualization-vowel").count(), 0);
	assert.equal(await page.locator(".visualization-distance").count(), 0);
	assert.equal(await page.locator("#visualization-count-vowel").textContent(), "0か所");
	await page.locator("#btn-undo").click();
	assert.equal(await page.locator(".visualization-vowel").count(), 1);
	assert.equal(await page.locator(".visualization-distance").count(), 1);
	for (const kind of ["vowel", "distance", "single", "filler"]) await page.uncheck(`#visualize-${kind}`);
	assert.equal(await page.locator(".visualization-badge").count(), 0);
	assert.equal(await page.locator(".visualization-hit").count(), 0);
	assert.deepEqual(errors, []);
	console.log("[ok] visualization E2E: combined highlights, threshold, persistence, mobile layout, corrections and undo");
} finally {
	await browser?.close();
	try { process.kill(-preview.pid, "SIGTERM"); } catch {}
}
