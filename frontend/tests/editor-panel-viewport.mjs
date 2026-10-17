import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const port = 4663;
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
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch();
		const context = await browser.newContext({
			viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true,
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
		});
		await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${base}/editor.html`);
		await page.evaluate(() => sessionStorage.setItem("soramimic-editor", JSON.stringify({
			phrases: Array(20).fill("青い空を見上げて"), param: { DUPLICATE: true },
			wordlist: { value: "ORIGINAL", text: "テスト", csvText:
				"id,original,surface,pronunciation\n" + Array.from({ length: 45 }, (_, i) =>
					`${i},候補${i},候補${i},アオイ`).join("\n") },
		})));
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-setup-convert").disabled, undefined, { timeout: 60000 });
		await page.click("#btn-setup-convert");
		await page.waitForSelector(".review-word", { timeout: 60000 });
		const word = page.locator('.review-line[data-line="12"] .review-word:not(.filler)').first();
		await word.scrollIntoViewIfNeeded();
		const originalScroll = await page.evaluate(() => scrollY);
		assert(originalScroll > 500, "open the editor from a scrolled lyrics list");
		await word.tap();
		const panel = page.locator("#editor-panel");
		await panel.waitFor({ state: "visible" });

		// Desktop automation has no iOS browser chrome or keyboard. Reproduce their
		// visual viewport offsets, while using each browser's real layout and scroll.
		await page.evaluate(() => {
			window.testViewport = { offsetTop: 0, offsetLeft: 0, height: innerHeight, width: innerWidth };
			for (const property of Object.keys(window.testViewport)) {
				Object.defineProperty(visualViewport, property, {
					configurable: true, get: () => window.testViewport[property],
				});
			}
		});
		const setViewport = async (geometry) => {
			await page.evaluate((next) => {
				Object.assign(window.testViewport, next);
				visualViewport.dispatchEvent(new Event("resize"));
				visualViewport.dispatchEvent(new Event("scroll"));
			}, geometry);
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		};
		const assertVisiblePanel = async () => {
			const bounds = await page.evaluate(() => {
				const panel = document.getElementById("editor-panel").getBoundingClientRect();
				const close = document.querySelector(".panel-free-back, .panel-close").getBoundingClientRect();
				return { panel: panel.toJSON(), close: close.toJSON(), viewport: window.testViewport };
			});
			const { panel: box, close, viewport } = bounds;
			assert(Math.abs(box.top - viewport.offsetTop) < 2, `${engine.name()}: panel top outside visible viewport: ${JSON.stringify(bounds)}`);
			assert(Math.abs(box.height - viewport.height) < 2, `${engine.name()}: panel height must fit the visible viewport`);
			assert(close.top >= viewport.offsetTop && close.bottom <= viewport.offsetTop + viewport.height,
				`${engine.name()}: return button must remain reachable`);
		};

		await setViewport({ offsetTop: 65, height: 610 });
		await assertVisiblePanel();
		await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
		assert(await panel.evaluate((node) => node.scrollTop > 0), "candidates should scroll inside the panel");
		await assertVisiblePanel();
		await panel.evaluate((node) => { node.scrollTop = 0; });
		await assertVisiblePanel();

		const selectedReading = () => page.locator('.review-unit[aria-pressed="true"]').allTextContents();
		const selectionBefore = await selectedReading();
		const savedBefore = await page.evaluate(() => sessionStorage.getItem("soramimic-editor"));
		await page.locator(".panel-free-toggle").tap();
		assert.equal(await page.locator(".review-range, .review-panel-header").count(), 0,
			"input should have its own area without range controls or an unrelated close button");
		await page.fill(".panel-free-surface", "入力途中");
		await setViewport({ offsetTop: 100, height: 320 });
		await assertVisiblePanel();
		const cancel = await page.locator(".panel-free-back").boundingBox();
		const apply = await page.locator(".panel-free-apply").boundingBox();
		assert(Math.abs(cancel.y - apply.y) < 1 && cancel.x + cancel.width <= apply.x,
			"cancel and confirm must share one row");
		assert(cancel.height >= 44 && apply.height >= 44 && apply.y + apply.height <= 420,
			"both actions must fit above the keyboard");
		if (process.env.EDITOR_SCREENSHOTS && engine === webkit) {
			await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
			await page.emulateMedia({ colorScheme: "dark" });
			await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/lyrics-input-mobile.png`,
				clip: { x: 0, y: 100, width: 390, height: 320 } });
		}
		await page.locator(".panel-free-back").tap();
		await setViewport({ offsetTop: 45, height: 650 });
		await assertVisiblePanel();
		assert.deepEqual(await selectedReading(), selectionBefore, "cancel must preserve the selected range");
		assert.equal(await page.evaluate(() => sessionStorage.getItem("soramimic-editor")), savedBefore,
			"cancel must discard the draft without changing saved lyrics or undo history");
		await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
		await assertVisiblePanel();

		await page.locator(".panel-close").tap();
		assert.equal(await panel.evaluate((node) => node.open), false);
		assert(Math.abs((await page.evaluate(() => scrollY)) - originalScroll) < 2,
			`${engine.name()}: closing should restore the lyrics scroll position`);
		await setViewport({ offsetTop: 0, height: 740 });
		await word.tap();
		await assertVisiblePanel();
		assert.equal(await panel.evaluate((node) => node.scrollTop), 0, "reopening starts at the header");
		await page.locator(".panel-close").tap();
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: scrolled page, viewport offsets, keyboard return, panel scrolling and position restoration`);
		await browser.close();
		browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
