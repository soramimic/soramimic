import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { menuAction } from "./editor-ui.mjs";

const port = 4617;
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
	assert(await page.locator("#btn-import-empty").isVisible(), "empty sessions can still import lyrics");
	await page.evaluate(() => sessionStorage.setItem("soramimic-editor", JSON.stringify({
		phrases: ["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"],
		wordlist: { value: "ORIGINAL", text: "食べもの", csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ\n3,白玉,白玉,シラタマ\n4,雲丹,雲丹,ウニ\n5,小松菜,小松菜,コマツナ\n6,風車,風車,カザグルマ\n7,神田,神田,カンダ\n8,京都,京都,キョート" },
	})));
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-setup-convert").disabled, undefined, { timeout: 60000 });
	assert(await page.locator("#editor-wordlist").isVisible());
	await page.click("#btn-original-edit");
	await page.fill("#editor-original-text", "青森,アオモリ\n空豆,ソラマメ\n白玉,シラタマ\n雲丹,ウニ\n小松菜,コマツナ\n風車,カザグルマ\n神田,カンダ\n京都,キョート\n酢,ス");
	await page.click("#btn-original-register");
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".review-word", { timeout: 60000 });
	assert.deepEqual(await page.locator(".review-line .review-original").allTextContents(),
		["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"]);
	const screenshot = async (name) => {
		if (!process.env.EDITOR_SCREENSHOTS) return;
		await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
		await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/${name}.png`, animations: "disabled" });
	};
	const first = page.locator(".review-word:not(.filler)").first();
	for (const colorScheme of ["dark", "light"]) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 390, 1200]) {
			await page.setViewportSize({ width, height: 740 });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "lyrics overflow");
			assert(await page.locator("#btn-settings").isVisible(), "settings must stay directly accessible");
			if (width === 390 && colorScheme === "dark") await screenshot("overview");
			await first.click();
			await page.locator(".review-unit").first().scrollIntoViewIfNeeded();
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.getBoundingClientRect().height >= 700), "editing should use the viewport");
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "selection overflows");
			assert(await page.locator(".panel-yomi-toggle").isVisible(), "source reading repair remains available");
			if (width === 390 && colorScheme === "dark") await screenshot("selection");
			await page.click(".panel-yomi-toggle");
			await page.keyboard.press("Escape");
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.classList.contains("open")), "Escape in reading dialog must preserve selection");
			await page.click(".panel-close");
			assert(await first.evaluate((word) => word === document.activeElement), "return focus to the selected word");
			await page.locator(".review-menu-toggle").click();
			assert(await page.locator("#copy-format").isVisible());
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "menu overflows");
			await page.keyboard.press("Escape");
			assert.equal(await page.locator(".review-menu").evaluate((menu) => !menu.querySelector(".review-menu-body").hidden), false);
		}
	}
	await page.setViewportSize({ width: 390, height: 740 });
	await page.emulateMedia({ colorScheme: "dark" });
	await page.click("#btn-settings");
	for (const selector of ["#editor-wordlist", "#editor-preset-buttons"]) {
		assert(await page.locator(selector).isVisible(), `${selector} settings retained`);
	}
	for (const selector of ["#editor-param-area", "#editor-duplicate-buttons"]) {
		assert(await page.locator(selector).isHidden(), `${selector} starts collapsed`);
	}
	await screenshot("settings");
	await page.locator("#editor-advanced-settings > summary").focus();
	await page.keyboard.press("Enter");
	for (const selector of ["#editor-param-area", "#editor-duplicate-buttons"]) {
		assert(await page.locator(selector).isVisible(), `${selector} expands with the keyboard`);
	}
	await screenshot("settings-expanded");
	await page.click("#btn-settings-close");
	await first.click();
	await page.locator(".panel-close").focus();
	await page.keyboard.press("Shift+Tab");
	assert(await page.locator("#editor-panel").evaluate((panel) => panel.contains(document.activeElement)), "focus stays inside selection");
	await page.click(".panel-free-toggle");
	assert(await page.locator(".panel-free-reading").isHidden());
	await page.click(".review-reading-input summary");
	assert(await page.locator(".panel-free-reading").isVisible());
	await page.keyboard.press("Escape");
	await page.evaluate(() => { navigator.clipboard.writeText = async (value) => { window.copied = value; }; });
	await menuAction(page, "#btn-copy");
	await page.waitForFunction(() => window.copied?.length > 0);
	assert.equal(await page.locator(".review-menu").evaluate((menu) => !menu.querySelector(".review-menu-body").hidden), false);
	assert.deepEqual(errors, []);
	console.log("[ok] editor layout: settings retained, responsive lyrics and selection, menus, keyboard, source reading, custom input");
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
