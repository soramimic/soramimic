import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 4612;
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
	const context = await browser.newContext({ viewport: { width: 390, height: 740 }, colorScheme: "dark" });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	await page.evaluate(() => sessionStorage.setItem("soramimic-editor", JSON.stringify({
		phrases: ["アオイソラヲミアゲテ", "シロイクモヲオイカケル", "チイサナカゼヲカンジテ"],
		wordlist: { value: "ORIGINAL", text: "テスト", csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ\n3,白玉,白玉,シラタマ\n4,雲丹,雲丹,ウニ\n5,小松菜,小松菜,コマツナ\n6,風車,風車,カザグルマ\n7,神田,神田,カンダ\n8,京都,京都,キョート" },
	})));
	await page.evaluate(() => localStorage.setItem("originalWordlist",
		JSON.parse(sessionStorage.getItem("soramimic-editor")).wordlist.csvText));
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-setup-convert").disabled, undefined, { timeout: 60000 });
	await page.click("#btn-original-edit");
	await page.fill("#editor-original-text", "青森,アオモリ\n空豆,ソラマメ\n白玉,シラタマ\n雲丹,ウニ\n小松菜,コマツナ\n風車,カザグルマ\n神田,カンダ\n京都,キョート");
	await page.click("#btn-original-register");
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".chip-word", { timeout: 60000 });
	const seed = await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		data.host = { review: true, songs: [], canUploadSong: false };
		data.lyrics = "青い空を見上げて\n白い雲を追いかける\n小さな風を感じて";
		data.originalLines = ["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"];
		sessionStorage.setItem("soramimic-editor", JSON.stringify(data));
		return data;
	});
	if (!seed.results[0].some((word) => !word.filler)) {
		console.error({ wordlist: seed.wordlist, param: seed.param, result: seed.results[0] });
		throw new Error("test seed must include candidate words");
	}
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled, undefined, { timeout: 60000 });
	assert.deepEqual(await page.locator(".review-original").allTextContents(), seed.originalLines);
	for (const selector of ["#btn-settings", "#btn-import", "#btn-export", "#btn-copy", ".chip-unit", "#btn-regenerate"]) {
		assert.equal(await page.locator(selector).isVisible(), false, `${selector} should be concealed`);
	}
	const source = await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return [data.unitsList, data.tokensList, data.originalLines];
	});
	const firstWord = page.locator('.review-line[data-line="0"] .review-word:not(.filler)').first();
	const before = await firstWord.textContent();
	await firstWord.click();
	await page.waitForSelector("#editor-panel.open .candidate").catch(async (error) => {
		console.error({ errors, before, panel: await page.locator("#editor-panel").textContent() });
		throw error;
	});
	assert.equal(await page.locator(".review-range").getAttribute("open"), null);
	assert.equal(await page.locator(".panel-yomi-toggle").count(), 0);
	const panelBox = await page.locator("#editor-panel").boundingBox();
	assert(panelBox.height >= 700, "candidate editor should use the mobile viewport");
	assert(await page.locator("#editor-lines").evaluate((node) => node.inert));
	const candidate = page.locator(".candidate").filter({ hasNotText: before }).first();
	const chosen = await candidate.locator(".candidate-surface").textContent();
	await candidate.click();
	await page.waitForFunction(() => !document.getElementById("editor-panel").classList.contains("open"));
	assert.equal(await firstWord.textContent(), chosen);
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), before);
	await page.click("#btn-redo");
	assert.equal(await firstWord.textContent(), chosen);
	await firstWord.click();
	await page.click(".review-range summary");
	const start = Number(await firstWord.getAttribute("data-start"));
	const end = Number(await firstWord.getAttribute("data-end"));
	if (end < seed.unitsList[0].length) {
		await page.click(`.review-unit[data-index="${end}"]`);
		assert.equal(await page.locator('.review-unit[aria-pressed="true"]').count(), end - start + 1);
		assert(await page.locator(".review-range").evaluate((node) => node.open));
	}
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#editor-panel").evaluate((node) => node.classList.contains("open")), false);
	assert.deepEqual(await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return [data.unitsList, data.tokensList, data.originalLines];
	}), source, "review must keep the host's analyzed source and alignment");
	for (const colorScheme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 320, height: 640 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "overview overflows");
		await firstWord.click();
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "candidates overflow");
		await page.click(".panel-close");
	}
	await page.reload();
	await page.waitForSelector(".review-word");
	assert.equal(await firstWord.textContent(), chosen, "edits should survive reopening");
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	await firstWord.click();
	await page.click(".panel-free-toggle");
	assert(await page.locator(".panel-free-reading").isHidden());
	await page.fill(".panel-free-surface", "手入力の語");
	await page.click(".review-reading-input summary");
	await page.fill(".panel-free-reading", await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return data.results[0].find((word) => !word.filler).kana;
	}));
	await page.click(".panel-free-apply");
	assert.equal(await firstWord.textContent(), "手入力の語");
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), chosen);
	assert.deepEqual(errors, []);
	console.log("[ok] compact review: source spelling, mobile layout, candidates, range, undo/redo, recovery");
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
