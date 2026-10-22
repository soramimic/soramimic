import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";
import { menuAction } from "./editor-ui.mjs";

const port = Number(process.env.EDITOR_FILES_PORT || 4667);
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
	browser = await (process.env.EDITOR_FILES_BROWSER === "webkit" ? webkit : chromium).launch();
	const context = await browser.newContext();
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	await context.addInitScript(() => {
		if (!sessionStorage.getItem("soramimic-editor")) {
			const wordlist = { value: "ORIGINAL", text: "テスト",
				csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ" };
			sessionStorage.setItem("soramimic-editor", JSON.stringify({
				phrases: ["アオイソラ"], wordlist, param: { DUPLICATE: true, VOWEL_RATIO: 0.8 },
				unitsList: [["ア", "オ", "イ", "ソ", "ラ"].map((pronunciation) => ({ pronunciation }))],
				results: [[{ id: "1", surface: "青森", kana: "アオモリ", period: [0, 5] }]],
			}));
			localStorage.setItem("originalWordlist", wordlist.csvText);
		}
		const text = File.prototype.text;
		window.reads = [];
		File.prototype.text = function () {
			if (!this.name.startsWith("delayed-")) return text.call(this);
			return new Promise((resolve, reject) => window.reads.push({ resolve, reject }));
		};
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
			readText: () => new Promise((resolve) => { window.clipboardResult = resolve; }),
		} });
	});
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	await menuAction(page, "#btn-settings");
	const openOriginal = () => page.locator("#btn-original-edit").click();
	const choose = async (name = "delayed-list.txt") => {
		await page.locator("#original-file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("酢,ス") });
	};
	const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await openOriginal();
	await choose();
	assert(await page.locator("#editor-original-text").isDisabled());
	assert(await page.locator("#btn-original-register").isDisabled());
	assert(await page.locator("#btn-original-file").isDisabled());
	assert(await page.locator("#btn-original-cancel").isEnabled());
	await page.locator("#btn-original-cancel").click();
	await openOriginal();
	await page.locator("#editor-original-text").fill("新しい下書き,アタラシイ");
	await page.evaluate(() => reads[0].resolve("古いファイル,フルイ"));
	await settle();
	assert.equal(await page.locator("#editor-original-text").inputValue(), "新しい下書き,アタラシイ");
	assert(await page.locator("#editor-original-text").isEnabled());
	await choose();
	await page.evaluate(() => reads[1].resolve("酢,ス"));
	await page.waitForFunction(() => !document.getElementById("editor-original-text").disabled);
	assert.equal(await page.locator("#editor-original-text").inputValue(), "酢,ス");
	await choose();
	await page.evaluate(() => reads[2].reject(new Error("read failed")));
	await page.waitForFunction(() => !document.getElementById("editor-original-text").disabled);
	assert.match(await page.locator("#original-file-status").textContent(), /読み込めません/);
	assert.equal(await page.locator("#editor-original-text").inputValue(), "酢,ス");
	await page.locator("#btn-original-paste").click();
	assert(await page.locator("#btn-original-register").isDisabled());
	await page.keyboard.press("Escape");
	await openOriginal();
	await page.locator("#editor-original-text").fill("クリップボード待ちを取り消した下書き");
	await page.evaluate(() => clipboardResult("古い貼り付け"));
	await settle();
	assert.equal(await page.locator("#editor-original-text").inputValue(), "クリップボード待ちを取り消した下書き");
	await page.locator("#btn-original-cancel").click();
	await page.locator("#btn-settings-close").click();

	// Importing a JSON replaces the session. Do not accept edits while it is read.
	const before = await page.evaluate(() => sessionStorage.getItem("soramimic-editor"));
	await page.locator("#import-file").setInputFiles({ name: "delayed-import.json", mimeType: "application/json", buffer: Buffer.from("{}") });
	assert(await page.locator("#app").evaluate((node) => node.inert));
	await page.keyboard.press("Tab");
	assert(await page.evaluate(() => !document.getElementById("app").contains(document.activeElement)));
	const alert = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
	await page.evaluate(() => reads[3].resolve("invalid json"));
	await alert;
	await page.waitForFunction(() => !document.getElementById("app").inert);
	assert.equal(await page.evaluate(() => sessionStorage.getItem("soramimic-editor")), before);
	await page.locator("#import-file").setInputFiles({ name: "delayed-import.json", mimeType: "application/json", buffer: Buffer.from("{}") });
	const imported = JSON.parse(before);
	imported.results[0][0].surface = "取り込んだ歌詞";
	const navigation = page.waitForEvent("domcontentloaded");
	await page.evaluate((text) => reads[4].resolve(text), JSON.stringify(imported));
	await navigation;
	await page.waitForFunction(() => document.querySelector(".review-word-surface")?.textContent === "取り込んだ歌詞");
	assert.equal(await page.locator("#app").evaluate((node) => node.inert), false);
	assert.deepEqual(errors, []);
	console.log("[ok] editor file operations: pending reads lock conflicting controls, cancel safely, and recover after failures");
} finally {
	await browser?.close();
	try { process.kill(-server.pid, "SIGTERM"); } catch {}
}
