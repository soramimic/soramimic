import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { menuAction, regenerateAll } from "./editor-ui.mjs";

const base = "http://localhost:4796";
const server = spawn("npx", ["vite", "preview", "--port", "4796", "--strictPort"], { stdio: "ignore", detached: true });
const csv = "id,original,surface,pronunciation,type\n0,通常語,通常語,カカカカ,family\n1,前半,前半,カカ,family\n2,後半,後半,カカ,family\n3,優先語,優先語,ササ,family\n";
let browser;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (i > 100) throw new Error("preview server did not start");
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch();
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await context.route(url => url.hostname !== "localhost", route => route.abort());
		await context.route("**/wordlists/*.csv", route => route.fulfill({ body: csv }));
		const page = await context.newPage();
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.click("#generation-advanced > summary");
		await page.fill("#priority-words-search", "ささ");
		await page.locator("#priority-words-results [role=option]").first().click();
		assert.equal(await page.getByLabel("優先単語の使い方", { exact: true }).count(), 0);
		assert.equal(await page.getByRole("button", { name: "両方式で比較" }).count(), 0);
		assert(await page.locator("#priority-words-hint").isHidden());
		for (const width of [320, 390, 1200]) {
			await page.setViewportSize({ width, height: 844 });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		}
		await page.setViewportSize({ width: 390, height: 844 });
		if (process.env.PRIORITY_SCREENSHOTS && engine === chromium) {
			await mkdir(process.env.PRIORITY_SCREENSHOTS, { recursive: true });
			await page.locator("#priority-words").scrollIntoViewIfNeeded();
			await page.screenshot({ path: `${process.env.PRIORITY_SCREENSHOTS}/placement-only-mobile.png`, animations: "disabled" });
		}
		await page.evaluate(() => {
			const saved = JSON.parse(sessionStorage.getItem("soramimic-main"));
			saved.priorityStrategy = "score";
			sessionStorage.setItem("soramimic-main", JSON.stringify(saved));
		});
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await page.locator(".priority-tag").count(), 1, "legacy preferences survive reload");
		await page.evaluate(() => {
			const original = window.setTimeout.bind(window);
			window.setTimeout = (callback, delay = 0, ...args) => original(callback, delay === 50 ? 500 : delay, ...args);
		});
		await page.fill("#input-text", "カカカカ");
		await page.click("#btn-convert");
		await page.waitForFunction(() => {
			const status = document.getElementById("progress-text")?.textContent || "";
			return status.includes("配置候補") || status.includes("配置案");
		});
		assert.notEqual(await page.textContent("#progress-text"), "単語リストを準備中...");
		await page.waitForURL("**/editor.html");
		await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
		let data = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert(data.results.flat().some(word => word.surface === "優先語" && word.priorityPlaced));
		assert(!data.results.flat().some(word => word.locked));
		await menuAction(page, "#btn-settings");
		assert.equal(await page.getByLabel("優先単語の使い方", { exact: true }).count(), 0);
		assert.equal(await page.getByRole("button", { name: "両方式で比較" }).count(), 0);
		await page.click("#btn-settings-close");
		await page.evaluate(() => {
			const saved = JSON.parse(sessionStorage.getItem("soramimic-editor"));
			saved.param.PRIORITY_STRATEGY = "score";
			saved.results = [[{ id: "0", original: "通常語", surface: "通常語", kana: "カカカカ",
				period: [0, 4], original_surface: "カカカカ", originalkana: "カカカカ", sim: 0, score: 0 }]];
			saved.history = []; saved.future = [];
			sessionStorage.setItem("soramimic-editor", JSON.stringify(saved));
		});
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
		assert.equal(await page.locator(".review-word").first().textContent(), "通常語", "loading a legacy result preserves the lyrics");
		await regenerateAll(page);
		await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled
			&& document.getElementById("regen-progress").hidden);
		data = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert(data.results.flat().some(word => word.surface === "優先語" && word.priorityPlaced), "legacy editor parameters cannot restore the retired strategy");
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: automatic priority placement, simple controls, legacy main/editor settings, regeneration and responsive layout`);
		await browser.close(); browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
