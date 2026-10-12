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
		assert(await page.locator("#wordlist-trigger").isVisible());
		assert(await page.locator("#wordlist-facets").isHidden());
		assert(await page.locator("#preset-buttons").isHidden());
		await page.locator("#generation-advanced > summary").focus();
		await page.keyboard.press("Enter");
		assert(await page.locator("#wordlist-facets").isVisible());
		assert(await page.locator("#param-area").isHidden());
		const sound = page.getByRole("slider", { name: "音の合わせ方(子音重視〜母音重視)", includeHidden: true });
		const phrase = page.getByRole("slider", { name: "文節の区切り(無視〜がっちり守る)", includeHidden: true });
		const word = page.getByRole("slider", { name: "単語の長さ(細かめ〜長め)", includeHidden: true });
		for (const slider of [sound, phrase, word]) assert(await slider.isHidden());
		await page.locator(".param-disclosure > summary").focus();
		await page.keyboard.press("Enter");
		for (const slider of [sound, phrase, word]) assert(await slider.isVisible());
		await sound.focus();
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowLeft");
		await phrase.focus();
		await page.keyboard.press("ArrowRight");
		await word.focus();
		await page.keyboard.press("ArrowRight");
		await page.locator(".param-disclosure > summary").click();
		for (const slider of [sound, phrase, word]) assert(await slider.isHidden());
		assert.equal(await sound.inputValue(), "0.6");
		assert.equal(await phrase.inputValue(), "2");
		assert.equal(await word.inputValue(), "3");
		await page.locator("#generation-advanced > summary").focus();
		await page.keyboard.press("Enter");
		await page.locator("#generation-advanced > summary").blur();

		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme });
			for (const width of [320, 390, 1200]) {
				await page.setViewportSize({ width, height: 844 });
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
				const label = await page.locator('label[for="wordlist-trigger"]').boundingBox();
				const picker = await page.locator("#wordlist-trigger").boundingBox();
				assert(label.x + label.width <= picker.x && Math.abs(label.y + label.height / 2 - picker.y - picker.height / 2) < 2, "wordlist label and dropdown must share a row");
				for (const id of ["#input-text", "#wordlist-trigger", "#lyrics-file", "#btn-convert"]) {
					const bounds = await page.locator(id).boundingBox();
					assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, id);
				}
				await page.click("#wordlist-trigger");
				const menu = page.locator("#custom-wordlist-menu");
				assert.deepEqual(await menu.locator(".custom-wordlist-menu-heading").allTextContents(), ["生物", "架空", "自作リスト"]);
				const geometry = await menu.evaluate(el => {
					const rect = el.getBoundingClientRect();
					const top = el.querySelector('[data-value="BASEBALL"]').getBoundingClientRect();
					const child = el.querySelector('[data-value="SEKITSUI"]');
					const heading = el.querySelector(".custom-wordlist-menu-heading");
					return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
						indent: child.getBoundingClientRect().left - top.left,
						border: parseFloat(getComputedStyle(child).borderLeftWidth),
						headingBackground: getComputedStyle(heading).backgroundColor,
						menuBackground: getComputedStyle(el).backgroundColor };
				});
				assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 844);
				assert(geometry.indent > 0 && geometry.border >= 2 && geometry.headingBackground !== geometry.menuBackground, "category headers and indented children must have distinct visual levels");
				assert.equal(await menu.locator(".custom-wordlist-menu-heading").last().evaluate(el => el.nextElementSibling.textContent), "＋ 新しいリスト");
				if (engine === chromium && width === 390 && process.env.GENERATION_SCREENSHOTS) {
					await menu.evaluate(el => { const heading = el.querySelector(".custom-wordlist-menu-heading"); el.scrollTop = heading.offsetTop - 6; });
					await page.mouse.move(0, 0);
					await menu.screenshot({ path: `${process.env.GENERATION_SCREENSHOTS}/wordlist-${colorScheme}.png` });
				}
				await page.keyboard.press("Escape");
				await page.click("#btn-sample-lyrics");
				const dialog = page.getByRole("dialog", { name: "サンプル歌詞を選ぶ" });
				assert(await dialog.isVisible());
				assert(await dialog.evaluate(el => el.matches(":modal")));
				const dialogBounds = await dialog.boundingBox();
				assert(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= width);
				for (const button of await dialog.getByRole("button").all()) assert((await button.boundingBox()).height >= 44);
				if (engine === chromium && width === 390 && process.env.GENERATION_SCREENSHOTS) {
					await page.screenshot({ path: `${process.env.GENERATION_SCREENSHOTS}/sample-dialog-${colorScheme}.png`, animations: "disabled" });
				}
				await page.keyboard.press("Escape");
				assert(await dialog.isHidden());
				assert.equal(await page.locator(":focus").getAttribute("id"), "btn-sample-lyrics");
				if (engine === chromium && width === 390 && process.env.GENERATION_SCREENSHOTS) {
					await mkdir(process.env.GENERATION_SCREENSHOTS, { recursive: true });
					await page.locator("#wordlist-trigger").blur();
					await page.screenshot({ path: `${process.env.GENERATION_SCREENSHOTS}/generation-${colorScheme}.png`, animations: "disabled" });
				}
			}
		}
		for (const [value, name] of [["SEKITSUI", "脊椎動物"], ["FICTIONAL_SCIENTIST", "科学者"], ["BASEBALL", "野球選手"]]) {
			await page.click("#wordlist-trigger");
			await page.locator(`#custom-wordlist-menu [data-value="${value}"]`).click();
			assert.equal(await page.locator("#wordlist-trigger").getAttribute("data-value"), value);
			assert.equal(await page.locator("#wordlist-trigger > span").textContent(), name);
			await page.reload();
			await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
			assert.equal(await page.locator("#wordlist-trigger").getAttribute("data-value"), value, "grouped selection survives reload");
		}
		assert.equal(await page.locator(".site-header nav").count(), 0);
		assert.equal(await page.locator('label[for="input-text"]').count(), 0);
		await page.fill("#input-text", "入力中の歌詞");
		await page.getByRole("link", { name: "サイトについて", exact: true }).click();
		await page.waitForURL("**/about.html");
		assert(await page.getByRole("heading", { name: "謝辞", exact: true }).isVisible());
		await page.getByRole("link", { name: "歌詞を生成する", exact: true }).click();
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await page.inputValue("#input-text"), "入力中の歌詞");
		assert.equal(await sound.inputValue(), "0.6");
		assert.equal(await phrase.inputValue(), "2");
		assert.equal(await word.inputValue(), "3");
		for (const slider of [sound, phrase, word]) assert(await slider.isHidden());

		await page.route("**/sample_lyric/furusato.txt", route => route.fulfill({ status: 503, body: "unavailable" }));
		await page.click("#btn-sample-lyrics");
		const sampleDialog = page.getByRole("dialog", { name: "サンプル歌詞を選ぶ" });
		await sampleDialog.getByRole("button", { name: "ふるさと", exact: true }).click();
		await page.waitForFunction(() => document.getElementById("sample-status").textContent.startsWith("歌詞を読み込めませんでした"));
		assert.equal(await page.inputValue("#input-text"), "入力中の歌詞");
		assert(await sampleDialog.isVisible());
		await sampleDialog.getByRole("button", { name: "閉じる", exact: true }).click();
		assert.equal(await page.locator(":focus").getAttribute("id"), "btn-sample-lyrics");
		await page.unroute("**/sample_lyric/furusato.txt");
		const selectedBeforeSample = await page.locator("#wordlist-trigger").getAttribute("data-value");
		await page.click("#btn-sample-lyrics");
		await sampleDialog.getByRole("button", { name: "ももたろう", exact: true }).click();
		await sampleDialog.waitFor({ state: "hidden" });
		assert((await page.inputValue("#input-text")).includes("桃太郎さん"));
		assert.equal(await page.locator("#wordlist-trigger").getAttribute("data-value"), selectedBeforeSample);
		assert(!page.url().endsWith("editor.html"));

		let delayedSample;
		const sampleRequested = new Promise(resolve => { delayedSample = resolve; });
		await page.route("**/sample_lyric/akatombo.txt", async route => {
			delayedSample();
			await new Promise(resolve => setTimeout(resolve, 1000));
			await route.fulfill({ status: 200, body: "遅れて届いた歌詞" }).catch(() => {});
		});
		const beforeCancel = await page.inputValue("#input-text");
		await page.click("#btn-sample-lyrics");
		await sampleDialog.getByRole("button", { name: "赤とんぼ", exact: true }).click();
		await sampleRequested;
		await sampleDialog.getByRole("button", { name: "閉じる", exact: true }).click();
		await page.waitForFunction(() => !document.getElementById("btn-sample-lyrics").disabled);
		await page.unrouteAll({ behavior: "wait" });
		assert.equal(await page.inputValue("#input-text"), beforeCancel, "closing a loading sample must preserve the current lyrics");

		const load = async (name, text) => {
			await page.setInputFiles("#lyrics-file", { name, mimeType: name.endsWith("json") ? "application/json" : "text/plain", buffer: Buffer.from(text) });
		};
		const inputBounds = await page.locator("#input-text").boundingBox();
		const fileBounds = await page.locator("#lyrics-file").boundingBox();
		assert(fileBounds.y >= inputBounds.y + inputBounds.height, "visible file picker follows the textarea");
		for (const name of ["歌詞.txt", "歌詞.md", "歌詞.md"]) {
			await load(name, "\uFEFF青い空\n白い雲");
			await page.waitForFunction(() => document.getElementById("lyrics-file-status").textContent.includes("を読み込みました"));
			assert.equal(await page.inputValue("#input-text"), "青い空\n白い雲");
			assert.equal(await page.locator("#lyrics-file").evaluate(input => input.files[0].name), name);
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
		for (const text of ["{", "{}", '{"results":[],"unitsList":[]}', "あ".repeat(10001)]) {
			await page.fill("#input-text", text);
			await page.click("#btn-convert");
			await page.locator("#generation-error").waitFor({ state: "visible" });
			assert.equal(await page.inputValue("#input-text"), text);
			assert(!page.url().endsWith("editor.html"), "invalid pasted input must stay editable");
		}
		const pasted = { ...payload, lyrics: "あ".repeat(10001), host: { origin: "https://example.com" }, history: [payload.results], future: [payload.results] };
		const pastedText = "\uFEFF" + JSON.stringify(pasted);
		await page.fill("#input-text", "");
		await page.locator("#input-text").focus();
		await page.keyboard.insertText(pastedText);
		assert.equal(await page.inputValue("#input-text"), pastedText, "JSON longer than the lyric limit must not be truncated");
		assert.equal(await page.locator("#btn-convert").textContent(), "編集画面へ");
		await page.click("#btn-convert");
		await page.waitForURL("**/editor.html");
		await page.waitForSelector(".review-word");
		const pastedImport = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert.deepEqual(pastedImport.results, payload.results, "pasted JSON preserves results and locks without generation");
		assert.deepEqual(pastedImport.unitsList, payload.unitsList);
		assert.equal(pastedImport.lyrics, pasted.lyrics);
		assert.equal(pastedImport.host, undefined);
		assert.deepEqual(pastedImport.history, []);
		assert.deepEqual(pastedImport.future, []);
		assert(await page.locator("#editor-setup").isHidden());

		await page.goto(base);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		await page.route("**/wordlists/*.csv", route => route.fulfill({ status: 503, body: "unavailable" }));
		await page.fill("#input-text", "[サビ]\n青い空");
		assert.equal(await page.locator("#btn-convert").textContent(), "生成", "lyric section markers are not JSON");
		await page.click("#btn-convert");
		await page.locator("#generation-error").waitFor({ state: "visible" });
		assert.equal(await page.inputValue("#input-text"), "[サビ]\n青い空");
		assert(await page.locator("#btn-convert").isEnabled());
		assert(await page.locator("#lyrics-file").isEnabled());
		assert(!page.url().endsWith("editor.html"), "generation errors must stay in the form");
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: sample dialog, grouped slider disclosure, responsive form, lyrics files and JSON direct editing`);
		await browser.close();
		browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
