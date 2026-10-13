import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";
import { menuAction } from "./editor-ui.mjs";

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
		assert(await page.getByLabel("優先単語の使い方", { exact: true }).isHidden());
		await page.fill("#priority-words-search", "ささ");
		await page.locator("#priority-words-results [role=option]").first().click();
		await page.fill("#input-text", "カカカカ");
		assert.equal(await page.getByLabel("優先単語の使い方", { exact: true }).inputValue(), "score");
		await page.getByRole("button", { name: "両方式で比較" }).click();
		const dialog = page.getByRole("dialog", { name: "優先単語の使い方を比較" });
		await dialog.getByText("両方式の生成が完了しました。", { exact: true }).waitFor();
		const soft = dialog.locator('[data-strategy="score"]');
		const placed = dialog.locator('[data-strategy="placement"]');
		assert((await soft.locator(".priority-comparison-stat").textContent()).includes("優先語 0/1語"));
		assert((await placed.locator(".priority-comparison-stat").textContent()).includes("優先語 1/1語"));
		assert.equal(await soft.locator(".priority-comparison-word").first().textContent(), "通常語");
		assert.equal(await placed.locator(".priority-comparison-word.preferred").textContent(), "優先語");
		for (const width of [320, 390, 1200]) {
			await page.setViewportSize({ width, height: 844 });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
			const bounds = await dialog.boundingBox();
			assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
		}
		await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
		assert(await page.locator("#output-field").isHidden(), "comparison must not change the current result/history");
		await page.getByRole("button", { name: "両方式で比較" }).click();
		await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
		await page.getByLabel("優先単語の使い方", { exact: true }).selectOption("placement");
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.click("#generation-advanced > summary");
		assert.equal(await page.getByLabel("優先単語の使い方", { exact: true }).inputValue(), "placement", "strategy survives reload");
		await page.getByRole("button", { name: "両方式で比較" }).click();
		await dialog.getByText("両方式の生成が完了しました。", { exact: true }).waitFor();
		await placed.getByRole("button", { name: "この結果を編集する" }).click();
		await page.waitForURL("**/editor.html");
		await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
		const data = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert.equal(data.param.PRIORITY_STRATEGY, "placement");
		assert(data.results.flat().some(word => word.surface === "優先語"));
		assert(!data.results.flat().some(word => word.locked));
		await menuAction(page, "#btn-settings");
		await page.click("#editor-advanced-settings > summary");
		assert.equal(await page.getByLabel("優先単語の使い方", { exact: true }).inputValue(), "placement");
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: same-input comparison, metrics, cancellation, responsive dialog, persistent strategy and selected result editing`);
		await browser.close(); browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
