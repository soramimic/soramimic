import assert from "node:assert/strict";
import { startPreview } from "./preview.mjs";
import { chromium, webkit } from "playwright";
const { url: base, close: closePreview } = await startPreview({ port: Number(process.env.EDITOR_RECOVERY_PORT || 0) });
const key = "soramimic-editor-recovery";
const fixture = {
	phrases: ["アオイソラ"], lyrics: "青い空", originalLines: ["青い空"],
	tokensList: [[{ surface_form: "青い空", pronunciation: "アオイソラ", phrase: 0, token_index: 0 }]],
	wordlist: { value: "ORIGINAL", text: "保存テスト", csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ" },
	param: { DUPLICATE: true, VOWEL_RATIO: 0.8 },
	unitsList: [["ア", "オ", "イ", "ソ", "ラ"].map(pronunciation => ({ pronunciation, phrase: 0 }))],
	results: [[{ id: "1", surface: "青森", kana: "アオモリ", pronunciation: ["ア", "オ", "モ", "リ"], period: [0, 5], locked: false }]],
	videoMetadata: { title: "保存した動画設定" },
};
let browser;
async function ready(page, surface = "青森") {
	await page.waitForFunction(surface => document.querySelector(".review-word-surface")?.textContent === surface
		&& !document.getElementById("btn-regenerate").disabled, surface, { timeout: 60000 });
}
async function seed(page, payload = fixture) {
	await page.goto(`${base}/about.html`);
	await page.evaluate(payload => sessionStorage.setItem("soramimic-editor", JSON.stringify(payload)), payload);
	await page.goto(`${base}/editor.html`); await ready(page, payload.results[0][0].surface);
}
async function editLock(page) {
	await page.locator(".review-word").first().click();
	await page.locator(".panel-lock").click(); await page.locator(".panel-close").click();
}
const checkpoint = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
async function history(page) {
	return page.evaluate(() => new Promise((resolve, reject) => {
		const request = indexedDB.open("soramimic-generation-history");
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const db = request.result, read = db.transaction("results").objectStore("results").getAll();
			read.onsuccess = () => { resolve(read.result); db.close(); };
			read.onerror = () => { reject(read.error); db.close(); };
		};
	}));
}
async function denyWrites(page, destination) {
	await page.evaluate(destination => {
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if ((destination === "session" && this === sessionStorage && key === "soramimic-editor")
				|| (destination === "recovery" && this === localStorage && key === "soramimic-editor-recovery")) {
				throw new DOMException("full", "QuotaExceededError");
			}
			return set.call(this, key, value);
		};
	}, destination);
}
try {
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch();
		const context = await browser.newContext();
		// HTTP origins may expose getRandomValues without randomUUID.
		await context.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true }));
		await context.route(url => url.hostname !== "localhost", route => route.abort());
		const errors = [];
		context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
		let page = await context.newPage();
		await page.goto(`${base}/editor.html`);
		await page.locator("#editor-empty").waitFor({ state: "visible" });
		await page.setInputFiles("#import-file", { name: "edit.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
		await ready(page);
		assert((await checkpoint(page)).payload.generationHistoryId, "imports also receive a history identity");
		assert.equal((await history(page)).length, 1);
		await editLock(page);
		const saved = (await checkpoint(page)).payload;
		assert.equal(saved.results[0][0].locked, true, "edits are checkpointed synchronously");
		assert.equal(saved.history, undefined, "undo snapshots must not fill the checkpoint");
		assert.deepEqual(saved.videoMetadata, fixture.videoMetadata);
		await page.close(); page = await context.newPage();
		await page.goto(`${base}/editor.html`); await ready(page);
		assert(await page.locator("#editor-recovery-status").isVisible());
		const restored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		for (const field of ["results", "unitsList", "originalReadingAlignments", "videoMetadata", "wordlist", "generationHistoryId"]) assert.deepEqual(restored[field], saved[field]);
		assert.equal((await history(page)).length, 1, "recovery must not duplicate history");

		const other = structuredClone(fixture); other.results[0][0].surface = "別の編集";
		const second = await context.newPage(); await seed(second, other);
		assert(await second.locator("#editor-recovery-status").isHidden());
		assert.equal((await checkpoint(second)).payload.results[0][0].surface, "別の編集");
		assert.equal((await history(second)).length, 2, "new work retains earlier history");
		await page.reload(); await ready(page); // An intact session wins over another tab's checkpoint.

		await denyWrites(page, "session"); await editLock(page);
		assert.equal((await checkpoint(page)).payload.results[0][0].locked, false);
		assert.match(await page.locator("#editor-save-status").textContent(), /自動保存しました/);
		await page.reload(); await ready(page);
		assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), false,
			"a stale session must not overwrite its newer checkpoint on reload");
		await page.close(); page = await context.newPage();
		await page.goto(`${base}/editor.html`); await ready(page);
		assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), false);

		// Quota failure must still save to IndexedDB and recover ahead of an older checkpoint.
		await denyWrites(page, "recovery"); await editLock(page);
		await page.waitForFunction(() => document.getElementById("editor-save-status").textContent.includes("自動保存しました"));
		assert.equal((await checkpoint(page)).payload.results[0][0].locked, false);
		assert.equal((await history(page)).find(item => item.id === saved.generationHistoryId).payload.results[0][0].locked, true);
		await page.close(); page = await context.newPage();
		await page.goto(`${base}/editor.html`); await ready(page);
		assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), true);
		await denyWrites(page, "session"); await denyWrites(page, "recovery");
		await editLock(page);
		await page.waitForFunction(() => document.getElementById("editor-save-status").textContent.includes("自動保存しました"));
		await page.reload(); await ready(page);
		assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), false,
			"history must recover the newer edit when both synchronous writes failed");
		await page.evaluate(() => { sessionStorage.setItem("soramimic-editor", "{broken"); localStorage.setItem("soramimic-editor-recovery", "{broken"); });
		await page.reload(); await ready(page);
		assert(await page.locator("#editor-recovery-status").isVisible());

		await second.goto(`${base}/about.html`);
		await second.evaluate(() => {
			sessionStorage.clear(); const frame = document.createElement("iframe");
			frame.src = "/editor.html?embed=video"; document.body.append(frame);
		});
		await second.frameLocator("iframe").locator("#editor-empty").waitFor({ state: "visible" });
		assert(await second.frameLocator("iframe").locator("#editor-recovery-status").isHidden());
		assert.deepEqual(errors, []); await context.close();

		const denied = await browser.newContext();
		await denied.route(url => url.hostname !== "localhost", route => route.abort());
		await denied.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("blocked", "SecurityError"); } }));
		const blocked = await denied.newPage(); await seed(blocked); await editLock(blocked); await blocked.close();
		const resumed = await denied.newPage(); await resumed.goto(`${base}/editor.html`); await ready(resumed);
		assert.equal(await resumed.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), true);
		await denyWrites(resumed, "recovery"); await editLock(resumed);
		assert.match(await resumed.locator("#editor-save-status").textContent(), /自動保存ができません/);
		assert.equal(await resumed.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), false);
		assert.equal((await checkpoint(resumed)).payload.results[0][0].locked, true, "failed writes retain the last good checkpoint");
		await denied.close();
		console.log(`[ok] ${engine.name()}: JSON autosave, closed-tab recovery, independent tabs, corruption, storage failures and embedded isolation`);
		await browser.close(); browser = null;
	}
} finally {
	await Promise.all([browser?.close(), closePreview()]);
}
