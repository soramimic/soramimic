import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";
import { menuAction, regenerateAll } from "./editor-ui.mjs";

const base = "http://localhost:4797";
const server = spawn("npx", ["vite", "preview", "--port", "4797", "--strictPort"], { stdio: "ignore", detached: true });
const csv = "id,original,surface,pronunciation,type,category,scope\n0,通常,通常,カ,family,player,jleague\n1,指定語,近い表記,サ,family,player,jleague\n1,指定語,別表記,カ,full,player,jleague\n1,指定語,近い表記,サー,family,player,jleague\n2,非対象,名前だけ,ナマエ,given,player,jleague\n"
	+ ["キ", "ク", "ケ", "コ", "ヌ", "ム"].map((kana, i) => `${i + 3},追加語${i + 1},追加語${i + 1},${kana},family,player,jleague\n`).join("");
const readData = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
const idle = page => page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled
	&& document.getElementById("settings-progress").hidden && document.getElementById("regen-progress").hidden);
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
		const errors = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert(await page.locator("#priority-words-search").isHidden());
		await page.click("#generation-advanced > summary");
		const input = page.locator("#priority-words-search");
		const options = page.locator("#priority-words-results [role=option]");
		await input.fill("さ");
		await options.first().waitFor();
		assert.equal(await options.count(), 1, "word scope deduplicates readings and surfaces");
		assert((await options.first().textContent()).startsWith("指定語"));
		await input.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
		await input.press("Enter");
		assert.equal(await page.locator(".priority-tag").count(), 0, "IME confirmation does not add a tag");
		await input.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
		await options.first().waitFor();
		await input.press("ArrowDown");
		assert.equal(await options.first().getAttribute("aria-selected"), "true");
		await input.press("Enter");
		assert.equal(await page.locator(".priority-tag").count(), 1);
		assert((await page.locator(".priority-tag").textContent()).startsWith("指定語"));
		await input.fill("サ");
		await page.getByText("候補がありません", { exact: true }).waitFor();
		await page.getByRole("button", { name: "指定語の優先指定を解除" }).click();
		await page.getByLabel("使う表記").selectOption("surface");
		await input.fill("ｻ");
		await options.first().waitFor();
		assert.equal(await options.count(), 1, "surface scope deduplicates multiple readings");
		assert((await options.first().textContent()).startsWith("近い表記"));
		await options.first().click();
		await input.fill("なまえ");
		await page.getByText("候補がありません", { exact: true }).waitFor();
		await input.fill("");
		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme });
			for (const width of [320, 390, 1200]) {
				await page.setViewportSize({ width, height: 844 });
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
				for (const selector of ["#priority-words-search", ".priority-scope", ".priority-tag button"]) {
					const bounds = await page.locator(selector).boundingBox();
					assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, selector);
				}
			}
		}
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.click("#generation-advanced > summary");
		assert.equal(await page.locator(".priority-tag").count(), 1, "selection survives reload");
		assert((await page.locator(".priority-tag").textContent()).includes("この表記だけ"));
		await page.fill("#input-text", "カ");
		await page.click("#btn-convert");
		await page.waitForURL("**/editor.html");
		await page.waitForSelector(".review-word");
		await idle(page);
		let data = await readData(page);
		assert.equal(data.param.PRIORITY_WORDS[0].scope, "surface");
		assert.equal(data.results[0][0].surface, "近い表記", "tag affects actual generation");
		await menuAction(page, "#btn-settings");
		assert.equal(await page.locator(".priority-tag").count(), 1, "editor retains tag");
		await page.getByRole("button", { name: "近い表記の優先指定を解除" }).click();
		await idle(page);
		data = await readData(page);
		assert.deepEqual(data.param.PRIORITY_WORDS, []);
		assert.equal(data.results[0][0].surface, "近い表記", "settings preserve current lyrics");
		await page.click("#btn-settings-close");
		await regenerateAll(page);
		await idle(page);
		assert.equal((await readData(page)).results[0][0].surface, "通常", "regeneration uses changed preferences");
		await page.click("#btn-undo");
		await idle(page);
		await page.click("#btn-undo");
		await idle(page);
		assert.equal((await readData(page)).param.PRIORITY_WORDS.length, 1, "undo restores preference setting");
		await menuAction(page, "#btn-settings");
		assert.equal(await page.locator(".priority-tag").count(), 1);
		await page.selectOption("#editor-wordlist", "FOOTBALL");
		await idle(page);
		assert.equal(await page.locator(".priority-tag").count(), 0, "changing list clears preferences despite overlapping IDs");
		assert.deepEqual((await readData(page)).param.PRIORITY_WORDS, []);
		await page.click("#btn-settings-close");
		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.click("#generation-advanced > summary");
		await input.fill("さ");
		await options.first().waitFor();
		await input.press("Escape");
		assert(await page.locator("#priority-words-results").isHidden());
		await page.click("#wordlist-trigger");
		await page.locator('#custom-wordlist-menu [data-value="FOOTBALL"]').click();
		assert.equal(await page.locator(".priority-tag").count(), 0);
		const capPage = await context.newPage();
		capPage.on("pageerror", error => errors.push(error.message));
		await capPage.goto(base);
		await capPage.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await capPage.click("#generation-advanced > summary");
		const capInput = capPage.locator("#priority-words-search");
		for (const reading of ["き", "く", "け", "こ", "ぬ"]) {
			await capInput.fill(reading);
			await capPage.locator("#priority-words-results [role=option]").first().click();
		}
		assert.equal(await capPage.locator(".priority-tag").count(), 5);
		assert(await capInput.isDisabled(), "a sixth word cannot be added");
		assert((await capPage.locator(".priority-count").textContent()).includes("5 / 5"));
		await capPage.evaluate(() => {
			const saved = JSON.parse(sessionStorage.getItem("soramimic-main"));
			saved.priorityWords.push({ id: "8", original: "追加語6", surface: "追加語6", kana: "ム", scope: "word" });
			sessionStorage.setItem("soramimic-main", JSON.stringify(saved));
		});
		await capPage.reload();
		await capPage.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await capPage.click("#generation-advanced > summary");
		assert.equal(await capPage.locator(".priority-tag").count(), 6, "keep every previously saved word visible");
		assert(await capInput.isDisabled());
		assert((await capPage.locator(".priority-status").textContent()).includes("あと1個解除"));
		await capPage.fill("#input-text", "カカカカカカ");
		await capPage.click("#btn-convert");
		await capPage.locator("#generation-error").waitFor({ state: "visible" });
		assert((await capPage.locator("#generation-error").textContent()).includes("5個まで"));
		assert(await capPage.locator("#btn-convert").isEnabled(), "an over-limit error leaves the form usable");
		assert.equal(await capPage.locator(".priority-tag").count(), 6, "a failed conversion preserves every saved preference");
		await capPage.getByRole("button", { name: "追加語6の優先指定を解除" }).click();
		await capPage.getByRole("button", { name: "追加語5の優先指定を解除" }).click();
		assert(await capInput.isEnabled(), "removing a word frees a slot");
		await capInput.fill("む");
		await capPage.locator("#priority-words-results [role=option]").first().click();
		assert.equal(await capPage.locator(".priority-tag").count(), 5);
		await capPage.close();
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: priority search, IME, keyboard, scope, tags, filters, layout, persistence, generation, editor undo and list changes`);
		await browser.close(); browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
