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
		for (const order of ["before-blur", "after-blur", "no-compositionend", "input-commit"]) {
			await input.focus();
			await input.evaluate((el, order) => {
				el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
				el.value = "さ";
				el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
				if (order === "before-blur") el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
				if (order === "input-commit") el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));
				else el.blur();
				if (order === "after-blur") el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
			}, order);
			await options.first().waitFor();
			assert.equal(await input.inputValue(), "さ", "keyboard dismissal preserves the query");
			assert.equal(await page.locator(".priority-tag").count(), 0, "keyboard dismissal never selects a word");
			await options.first().click();
			assert.equal(await page.locator(".priority-tag").count(), 1, `candidate remains selectable: ${order}`);
			await page.getByRole("button", { name: "近い表記の優先指定を解除" }).click();
		}
		await input.fill("さ");
		await options.first().waitFor();
		await page.locator("#input-text").click();
		await input.dispatchEvent("compositionend");
		await page.waitForTimeout(300);
		assert(await page.locator("#priority-words-results").isHidden(), "outside interaction dismisses results despite a late IME event");
		await input.fill("さ");
		await options.first().waitFor();
		await page.locator("#input-text").focus();
		assert(await page.locator("#priority-words-results").isHidden(), "moving focus to another field dismisses results");
		await input.fill("さ");
		await options.first().waitFor();
		await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		assert(await page.locator("#priority-words-results").isHidden());
		await input.click();
		await options.first().waitFor();
		assert(await options.first().isVisible(), "tapping the field reopens results even when focus did not move");
		await input.fill("さ");
		await input.press("Escape");
		await input.dispatchEvent("compositionend");
		await input.evaluate(el => el.blur());
		await page.waitForTimeout(300);
		assert(await page.locator("#priority-words-results").isHidden(), "keyboard dismissal does not reopen explicitly closed results");
		await input.fill("さ");
		await options.first().waitFor();
		await input.press("Escape");
		await input.fill("き");
		await options.first().waitFor();
		assert((await options.first().textContent()).startsWith("追加語1"), "typing after Escape reopens results without refocusing");
		await input.fill("さ");
		await options.first().waitFor();
		assert.equal(await options.count(), 1, "search deduplicates readings of the same surface");
		assert((await options.first().textContent()).startsWith("近い表記"));
		await input.fill("指定語");
		await page.waitForFunction(() => document.querySelectorAll("#priority-words-results [role=option]").length === 2);
		assert.equal(await options.count(), 2, "different spellings of the same word remain distinct search results");
		await input.fill("さ");
		await page.waitForFunction(() => document.querySelectorAll("#priority-words-results [role=option]").length === 1);
		await input.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
		await input.press("Enter");
		assert.equal(await page.locator(".priority-tag").count(), 0, "IME confirmation does not add a tag");
		await input.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
		await options.first().waitFor();
		await input.press("ArrowDown");
		assert.equal(await options.first().getAttribute("aria-selected"), "true");
		await input.press("Enter");
		assert.equal(await page.locator(".priority-tag").count(), 1);
		assert((await page.locator(".priority-tag").textContent()).startsWith("近い表記"));
		assert.equal(await page.locator(".priority-scope").count(), 0, "no upfront scope selector");
		const near = page.getByRole("checkbox", { name: "近い表記", exact: true });
		const alternate = page.getByRole("checkbox", { name: "別表記", exact: true });
		await near.waitFor();
		assert(await near.isChecked());
		assert(await near.isDisabled(), "at least one spelling remains selected");
		assert(!await alternate.isChecked(), "only the chosen surface is initially selected");
		await alternate.check();
		assert(await near.isEnabled());
		assert((await page.locator(".priority-count").textContent()).includes("1 / 5"), "aliases share one slot");
		await near.uncheck();
		assert(await alternate.isDisabled());
		await near.check();
		await alternate.uncheck();
		await input.fill("サ");
		await page.getByText("候補がありません", { exact: true }).waitFor();
		await page.getByRole("button", { name: "近い表記の優先指定を解除" }).click();
		await input.fill("ｻ");
		await options.first().waitFor();
		assert.equal(await options.count(), 1, "surface search deduplicates multiple readings");
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
				for (const selector of ["#priority-words-search", ".priority-tag-toggle", ".priority-tag-remove", ".priority-surfaces label:first-of-type"]) {
					const bounds = await page.locator(selector).boundingBox();
					assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, selector);
				}
			}
		}
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.click("#generation-advanced > summary");
		assert.equal(await page.locator(".priority-tag").count(), 1, "selection survives reload");
		await page.getByRole("button", { name: "近い表記の候補にする表記" }).click();
		assert(await near.isChecked(), "checked spelling survives reload");
		assert(!await alternate.isChecked());
		await page.fill("#input-text", "カ");
		await page.click("#btn-convert");
		await page.waitForURL("**/editor.html");
		await page.waitForSelector(".review-word");
		await idle(page);
		let data = await readData(page);
		assert.deepEqual(data.param.PRIORITY_WORDS[0].surfaces, ["近い表記"]);
		assert.equal(data.results[0][0].surface, "近い表記", "tag affects actual generation");
		await menuAction(page, "#btn-settings");
		assert.equal(await page.locator(".priority-tag").count(), 1, "editor retains tag");
		await page.getByRole("button", { name: "近い表記の候補にする表記" }).click();
		const editorAlternate = page.getByRole("checkbox", { name: "別表記", exact: true });
		await editorAlternate.check();
		await idle(page);
		assert.deepEqual((await readData(page)).param.PRIORITY_WORDS[0].surfaces, ["近い表記", "別表記"]);
		assert(await editorAlternate.evaluate(el => el === document.activeElement), "saving a checkbox change preserves focus");
		await editorAlternate.uncheck();
		await idle(page);
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
		await input.fill("き");
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
		await capPage.evaluate(() => {
			const saved = JSON.parse(sessionStorage.getItem("soramimic-main"));
			const word = { id: "1", original: "指定語", surface: "近い表記", kana: "サ" };
			saved.priorityWords = [{ ...word, scope: "surface" }, { ...word, surface: "別表記", scope: "surface" }];
			sessionStorage.setItem("soramimic-main", JSON.stringify(saved));
		});
		await capPage.reload();
		await capPage.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await capPage.click("#generation-advanced > summary");
		assert.equal(await capPage.locator(".priority-tag").count(), 1, "legacy exact spellings of one word share a tag");
		await capPage.locator(".priority-tag-toggle").click();
		assert(await capPage.getByRole("checkbox", { name: "近い表記", exact: true }).isChecked());
		assert(await capPage.getByRole("checkbox", { name: "別表記", exact: true }).isChecked());
		await capPage.getByRole("checkbox", { name: "近い表記", exact: true }).uncheck();
		await capPage.reload();
		await capPage.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await capPage.click("#generation-advanced > summary");
		await capPage.locator(".priority-tag-toggle").click();
		assert(!await capPage.getByRole("checkbox", { name: "近い表記", exact: true }).isChecked());
		assert(await capPage.getByRole("checkbox", { name: "別表記", exact: true }).isChecked());
		await capPage.evaluate(() => {
			const saved = JSON.parse(sessionStorage.getItem("soramimic-main"));
			saved.priorityWords = [{ id: "1", original: "指定語", surface: "近い表記", kana: "サ", scope: "word" }];
			sessionStorage.setItem("soramimic-main", JSON.stringify(saved));
		});
		await capPage.reload();
		await capPage.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await capPage.click("#generation-advanced > summary");
		await capPage.locator(".priority-tag-toggle").click();
		assert(await capPage.getByRole("checkbox", { name: "近い表記", exact: true }).isChecked(), "legacy all-spellings setting checks every eligible spelling");
		assert(await capPage.getByRole("checkbox", { name: "別表記", exact: true }).isChecked());
		await capPage.close();
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: priority search, IME, keyboard, spelling checkboxes, tags, filters, layout, persistence, generation, editor undo and list changes`);
		await browser.close(); browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
