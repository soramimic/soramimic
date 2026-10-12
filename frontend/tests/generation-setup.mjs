import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = "http://localhost:4795";
const server = spawn("npx", ["vite", "preview", "--port", "4795", "--strictPort"], {
	stdio: "ignore", detached: true,
});
let browser;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (i > 100) throw new Error("preview server did not start");
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch();
		const context = await browser.newContext();
		await context.route(url => url.hostname !== "localhost", route => route.abort());
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await page.inputValue("#input-text"), "");
		assert(await page.locator("#output-field").isHidden());
		assert(await page.locator("#wordlist-select").isVisible());
		assert(await page.locator("#wordlist-facets").isHidden());
		assert(await page.locator("#preset-buttons").isHidden());
		await page.locator("#generation-advanced > summary").focus();
		await page.keyboard.press("Enter");
		assert(await page.locator("#wordlist-facets").isVisible());
		assert(await page.locator("#param-area").isVisible());
		await page.keyboard.press("Enter");
		await page.locator("#generation-advanced > summary").blur();

		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme });
			for (const width of [320, 390, 1200]) {
				await page.setViewportSize({ width, height: 844 });
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
				for (const id of ["#input-text", "#wordlist-select", "#btn-lyrics-file", "#btn-convert"]) {
					const bounds = await page.locator(id).boundingBox();
					assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, id);
				}
				if (engine === chromium && width === 390 && process.env.GENERATION_SCREENSHOTS) {
					await mkdir(process.env.GENERATION_SCREENSHOTS, { recursive: true });
					await page.screenshot({ path: `${process.env.GENERATION_SCREENSHOTS}/generation-${colorScheme}.png` });
				}
			}
		}
		const load = async (name, text) => {
			await page.setInputFiles("#lyrics-file", { name, mimeType: name.endsWith("json") ? "application/json" : "text/plain", buffer: Buffer.from(text) });
		};
		for (const name of ["歌詞.txt", "歌詞.md", "歌詞.md"]) {
			await load(name, "\uFEFF青い空\n白い雲");
			await page.waitForFunction(() => document.getElementById("lyrics-file-status").textContent.includes("を読み込みました"));
			assert.equal(await page.inputValue("#input-text"), "青い空\n白い雲");
			assert(!page.url().endsWith("editor.html"));
		}
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await page.inputValue("#input-text"), "青い空\n白い雲", "file lyrics survive reload");
		for (const [name, contents] of [["長い歌詞.txt", "あ".repeat(10001)], ["invalid.json", "{"], ["invalid.json", "{}"], ["invalid.json", '{"results":[null],"unitsList":[[]]}']]) {
			await load(name, contents);
			await page.waitForFunction(() => document.getElementById("lyrics-file-status").textContent.startsWith("読み込めませんでした"));
			assert.equal(await page.inputValue("#input-text"), "青い空\n白い雲");
			assert(!page.url().endsWith("editor.html"));
		}
		const payload = {
			format: "soramimic-editor/1", phrases: ["シズム"],
			unitsList: [[{ pronunciation: "シ", surface_form: "し" }, { pronunciation: "ズ", surface_form: "ず" }, { pronunciation: "ム", surface_form: "む" }]],
			results: [[{ surface: "清水", kana: "シミズ", pronunciation: "シミズ", originalkana: "シミズ", period: [0, 3], locked: true }]],
			param: {}, wordlist: { value: "ORIGINAL", text: "テスト", csvText: "id,original,surface,pronunciation\n0,清水,清水,シミズ\n" },
			lyrics: "沈む", originalLines: ["沈む"], setupFirst: true,
		};
		await load("編集データ.json", JSON.stringify(payload));
		await page.waitForURL("**/editor.html");
		await page.waitForSelector(".review-word");
		await page.waitForFunction(() => document.getElementById("editor-status").hidden && !document.getElementById("btn-regenerate").disabled);
		const imported = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert.deepEqual(imported.results, payload.results, "JSON results and locks must be preserved without generation");
		assert.deepEqual(imported.unitsList, payload.unitsList);
		assert.deepEqual(imported.originalLines, payload.originalLines);
		assert.equal(imported.wordlist.csvText, payload.wordlist.csvText);
		assert(await page.locator("#editor-setup").isHidden(), "JSON must skip setup even with setupFirst");
		await page.reload();
		await page.waitForSelector(".review-word");
		assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).originalLines), payload.originalLines);

		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.route("**/wordlists/*.csv", route => route.fulfill({ status: 503, body: "unavailable" }));
		await page.fill("#input-text", "青い空");
		await page.click("#btn-convert");
		await page.locator("#generation-error").waitFor({ state: "visible" });
		assert.equal(await page.inputValue("#input-text"), "青い空");
		assert(await page.locator("#btn-convert").isEnabled());
		assert(await page.locator("#btn-lyrics-file").isEnabled());
		assert(!page.url().endsWith("editor.html"), "generation errors must stay in the form");
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: generation form, responsive layout, lyrics files, JSON direct editing`);
		await browser.close();
		browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
