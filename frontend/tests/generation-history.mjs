import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = "http://localhost:4803";
const source = await readFile(new URL("../src/generationHistory.js", import.meta.url), "utf8");
const server = spawn("npx", ["vite", "preview", "--port", "4803", "--strictPort"], { stdio: "ignore", detached: true });
const fixture = {
	phrases: ["沈む"],
	tokensList: [[{ surface_form: "沈む", pronunciation: "シズム", reading: "シズム", basic_form: "沈む", pos: "動詞", token_index: 0 }]],
	unitsList: [[{ pronunciation: "シ", surface_form: "し" }, { pronunciation: "ズ", surface_form: "ず" }, { pronunciation: "ム", surface_form: "む" }]],
	results: [[{ id: "0", surface: "清水", kana: "シミズ", pronunciation: "シミズ", originalkana: "シミズ", period: [0, 3], locked: true }]],
	param: {}, wordlist: { value: "ORIGINAL", text: "保存した自作リスト", csvText: "id,original,surface,pronunciation\n0,清水,清水,シミズ\n" },
	lyrics: "沈む", originalLines: ["沈む"],
};
let browser;
async function contextFor(engine) {
	const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
	await context.route(url => url.hostname !== "localhost", route => route.abort());
	await context.route("**/__history-test.js", route => route.fulfill({ contentType: "application/javascript", body: source }));
	return context;
}
async function home(page) {
	await page.goto(base);
	await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
}
async function outputBounds(card) {
	return card.evaluate(block => ({
		block: block.getBoundingClientRect().toJSON(),
		heading: block.querySelector("h3").getBoundingClientRect().toJSON(),
		copy: block.querySelector(".output-copy").getBoundingClientRect().toJSON(),
	}));
}
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(base)).ok) break; } catch {}
		if (i > 100) throw new Error("preview did not start");
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch();
		const context = await contextFor(engine);
		let page = await context.newPage();
		const errors = [];
		context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
		page.on("pageerror", error => errors.push(error.message));
		await home(page);
		const storage = await page.evaluate(async fixture => {
			const { createGenerationHistoryRepository } = await import("/__history-test.js");
			const repo = createGenerationHistoryRepository({ databaseName: "history-capacity-test", now: () => 1000 });
			await Promise.all(Array.from({ length: 55 }, (_, i) => repo.add({ ...fixture, lyrics: "あ".repeat(350000) }, `歌詞${i}`, { id: `capacity-${i}` })));
			const entries = await repo.list();
			const before = entries.map(entry => entry.id);
			const duplicate = await repo.add(fixture, "重複", { id: before[0] });
			const edited = structuredClone(fixture);
			edited.results[0][0].locked = false;
			await repo.update(before[0], edited);
			const updated = (await repo.list())[0];
			const originalAdd = IDBObjectStore.prototype.add;
			let rejected = false;
			IDBObjectStore.prototype.add = function (...args) {
				const request = originalAdd.apply(this, args);
				const tx = this.transaction;
				queueMicrotask(() => { try { tx.abort(); } catch {} });
				return request;
			};
			try { await repo.add(fixture, "保存失敗", { id: "aborted" }); }
			catch { rejected = true; }
			finally { IDBObjectStore.prototype.add = originalAdd; }
			const afterFailure = (await repo.list()).map(entry => entry.id);
			await repo.remove(before.at(-1));
			const resurrected = await repo.update(before.at(-1), fixture);
			await repo.close();
			return { before, size: JSON.stringify(entries).length, duplicateTime: duplicate.createdAt,
				updated, rejected, afterFailure, resurrected };
		}, fixture);
		assert.deepEqual(storage.before, Array.from({ length: 50 }, (_, i) => `capacity-${54 - i}`));
		assert(storage.size > 5 * 1024 * 1024, "fifty full snapshots must fit beyond small Web Storage capacity");
		assert.equal(storage.updated.createdAt, storage.duplicateTime);
		assert.equal(storage.updated.payload.results[0][0].locked, false);
		assert.deepEqual(storage.updated.payload.unitsList, fixture.unitsList);
		assert(storage.rejected);
		assert.deepEqual(storage.afterFailure, storage.before, "failed addition must retain every existing result");
		assert.equal(storage.resurrected, false, "editing an evicted/deleted item must not recreate it");

		const receipts = await page.evaluate(async fixture => {
			const { createGenerationHistoryRepository } = await import("/__history-test.js");
			const repo = createGenerationHistoryRepository({ databaseName: "history-receipts-test" });
			const pair = await Promise.all([repo.add(fixture, "受信", { deduplicate: true }),
				repo.add({ ...fixture, host: { review: true }, history: ["old"] }, "再受信", { deduplicate: true })]);
			const reverseKeys = value => {
				if (Array.isArray(value)) return value.map(reverseKeys);
				if (!value || typeof value !== "object") return value;
				return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])]));
			};
			const reordered = await repo.add(reverseKeys(fixture), "同じ内容", { deduplicate: true });
			await repo.update(pair[0].id, { ...fixture, wordlistSource: { kind: "local" } });
			const withDiagnostics = await repo.add(fixture, "同じ歌詞", { deduplicate: true });
			const edited = structuredClone(fixture);
			edited.results[0][0].locked = false;
			await repo.update(pair[0].id, edited);
			const original = await repo.add(fixture, "古い内容", { deduplicate: true });
			const changedLyrics = await repo.add({ ...fixture, lyrics: "違う歌詞" }, "歌詞変更", { deduplicate: true });
			const changedCsv = await repo.add({ ...fixture, wordlist: { ...fixture.wordlist, csvText: "different" } }, "リスト変更", { deduplicate: true });
			const ordinary = await repo.add(fixture, "通常生成");
			const entries = await repo.list();
			await repo.close();
			return { pair, reordered, withDiagnostics, original, changedLyrics, changedCsv, ordinary, entries };
		}, fixture);
		assert.equal(receipts.pair[0].id, receipts.pair[1].id, "concurrent identical receipts must share one item");
		assert.equal(receipts.reordered.id, receipts.pair[0].id, "object key order must not create duplicates");
		assert.equal(receipts.withDiagnostics.id, receipts.pair[0].id, "local diagnostics must not affect identity");
		assert.equal(receipts.entries.length, 5);
		assert.notEqual(receipts.original.id, receipts.pair[0].id, "old content must not overwrite an edited item");
		assert.equal(receipts.entries.find(entry => entry.id === receipts.pair[0].id).payload.results[0][0].locked, false);
		assert.notEqual(receipts.changedLyrics.id, receipts.original.id);
		assert.notEqual(receipts.changedCsv.id, receipts.original.id);
		assert.notEqual(receipts.ordinary.id, receipts.original.id, "ordinary generation still creates a new item");

		await page.evaluate(async fixture => {
			const { createGenerationHistoryRepository } = await import("/__history-test.js");
			const repo = createGenerationHistoryRepository();
			for (let i = 0; i < 52; i++) {
				const payload = structuredClone(fixture);
				payload.wordlist.text = `単語リスト${i}`;
				if (i >= 50) {
					for (const key of ["phrases", "tokensList", "unitsList", "results", "originalLines"]) {
						payload[key] = Array.from({ length: 16 }, () => structuredClone(payload[key][0]));
					}
					payload.lyrics = payload.originalLines.join("\n");
					payload.results[0][0].surface = "長い単語".repeat(30);
				}
				await repo.add(payload, `元歌詞${i}`, { id: `saved-${i}` });
			}
			await repo.close();
		}, fixture);
		await page.close();
		page = await context.newPage();
		await page.goto(`${base}/about.html`);
		assert.equal(await page.evaluate(() => sessionStorage.getItem("soramimic-main")), null);
		await home(page);
		const cardFor = id => page.locator(`.history-item[data-history-id="${id}"]`);
		assert.equal(await page.locator(".history-item").count(), 50);
		assert.equal(await page.locator(".history-item").first().getAttribute("data-history-id"), "saved-51");
		assert.equal(await page.locator(".history-item").last().getAttribute("data-history-id"), "saved-2");
		assert(await page.locator(".history-item .output-text").evaluateAll(nodes => nodes.every(node => !node.textContent)),
			"full results must not be rendered before expansion");
		assert.equal(await page.locator("#history-select, #history-delete").count(), 0);
		await page.locator("#output-field > summary").click();
		const newest = cardFor("saved-51");
		for (const scheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme: scheme });
			for (const width of [320, 390, 1200]) {
				await page.setViewportSize({ width, height: 844 });
				await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
					`${engine.name()} ${scheme} at ${width}px must not overflow horizontally`);
				for (const selector of [".history-edit", ".output-copy", ".history-full > summary"]) {
					const bounds = await newest.locator(selector).boundingBox();
					assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, selector);
				}
				const { heading, copy } = await outputBounds(newest);
				assert(copy.x > heading.x + heading.width && copy.y <= heading.y,
					"copy must stay beside the card heading");
				assert(await newest.locator(".history-preview").evaluate(el => el.clientHeight <= 90),
					"long results must have a compact preview");
				await newest.locator("details").evaluate(el => { el.open = true; });
				await newest.locator(".output-text").filter({ hasText: "長い単語" }).waitFor();
				assert(await newest.locator(".output-text").evaluate(el =>
					el.scrollHeight > el.clientHeight && el.clientHeight <= 384 && el.scrollWidth <= el.clientWidth),
					"expanded results must wrap inside a bounded scrollable block");
				await newest.locator(".output-text").focus();
				await newest.locator(".output-text").evaluate(el => { el.scrollTop = 0; });
				await page.keyboard.press("End");
				await page.waitForFunction(() => {
					const el = document.querySelector('.history-item[data-history-id="saved-51"] .output-text');
					return el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
				});
				await newest.locator("details").evaluate(el => { el.open = false; });
				if (engine === chromium && width === 390 && process.env.GENERATION_HISTORY_SCREENSHOTS) {
					await mkdir(process.env.GENERATION_HISTORY_SCREENSHOTS, { recursive: true });
					await page.locator("#output-field").evaluate(el => el.scrollIntoView({ block: "start" }));
					await page.screenshot({ path: `${process.env.GENERATION_HISTORY_SCREENSHOTS}/history-${scheme}.png` });
				}
			}
		}
		await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(text) { window.historyCopied = text; } } }));
		await newest.locator(".output-copy").click();
		await page.waitForFunction(() => window.historyCopied);
		assert.equal(await page.evaluate(() => window.historyCopied), await newest.locator(".output-text").textContent(),
			"copy must include the entire result even when collapsed");
		await cardFor("saved-50").locator("summary").click();
		await cardFor("saved-50").locator(".output-text").filter({ hasText: "長い単語" }).waitFor();
		assert.equal(await cardFor("saved-50").locator(".output-text").evaluate(el => el.scrollTop), 0,
			"each result must start at the top when first expanded");
		const seventh = cardFor("saved-7");
		await seventh.locator("summary").click();
		await seventh.locator(".output-text").filter({ hasText: "清水" }).waitFor();
		assert.equal(await seventh.locator(".output-text").textContent(), "清水\nしみず\n");
		await page.evaluate(() => { window.historyCopied = null; });
		await seventh.locator(".output-copy").focus();
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => window.historyCopied);
		assert.equal(await page.evaluate(() => window.historyCopied), await seventh.locator(".output-text").textContent());
		await seventh.locator(".history-edit").click();
		await page.waitForURL("**/editor.html");
		await page.waitForFunction(() => document.getElementById("editor-status").hidden && !document.getElementById("btn-regenerate").disabled);
		assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId), "saved-7");
		await page.locator(".review-word").first().click();
		await page.locator(".panel-lock").click();
		await page.locator(".panel-close").click();
		await page.locator("#editor-brand").click();
		await page.waitForURL(`${base}/`);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		const edited = await page.evaluate(async () => (await (await import("/__history-test.js")).createGenerationHistoryRepository().list()).find(entry => entry.id === "saved-7"));
		assert.equal(edited.payload.results[0][0].locked, false, "editor changes must update the same persistent result");
		assert.deepEqual(edited.payload.unitsList, fixture.unitsList);
		assert.equal(edited.payload.wordlist.csvText, fixture.wordlist.csvText);
		assert.equal(await page.locator(".history-item").count(), 50);
		assert.equal(await cardFor("saved-7").count(), 1, "editing must preserve the same card");

		await page.click("#wordlist-trigger");
		await page.getByRole("menuitem", { name: "＋ 新しいリスト" }).click();
		await page.fill("#original-name", "履歴テスト");
		await page.fill("#original-text", "青空,アオゾラ\n清水,シミズ");
		await page.click("#original-register");
		await page.fill("#input-text", "青い空");
		await page.click("#btn-convert");
		await page.waitForURL("**/editor.html");
		await page.waitForSelector(".review-word");
		const generated = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
		assert(generated.generationHistoryId);
		await page.locator("#editor-brand").click();
		await page.waitForURL(`${base}/`);
		await page.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await page.locator(".history-item").count(), 50);
		assert.equal(await page.locator(".history-item").first().getAttribute("data-history-id"), generated.generationHistoryId);
		await context.close();

		const legacyContext = await contextFor(engine);
		const legacy = await legacyContext.newPage();
		legacy.on("pageerror", error => errors.push(error.message));
		await legacy.goto(`${base}/about.html`);
		await legacy.evaluate(data => sessionStorage.setItem("soramimic-main", JSON.stringify({
			text: "青い空", pastResult: data.results,
			lastConversion: { phrases: data.phrases, tokensList: data.tokensList, param: data.param, wordlist: data.wordlist, where: data.where },
		})), generated);
		await home(legacy);
		assert.equal(await legacy.locator(".history-item").count(), 1);
		const migratedId = await legacy.locator(".history-item").first().getAttribute("data-history-id");
		await legacy.reload();
		await legacy.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await legacy.locator(".history-item").first().getAttribute("data-history-id"), migratedId);
		assert.equal(await legacy.locator(".history-item").count(), 1, "legacy result migrates only once");
		await legacyContext.close();

		const blockedContext = await contextFor(engine);
		await blockedContext.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("blocked", "SecurityError"); } }));
		const blocked = await blockedContext.newPage();
		blocked.on("pageerror", error => errors.push(error.message));
		await home(blocked);
		await blocked.fill("#input-text", "青い空");
		await blocked.click("#btn-convert");
		await blocked.waitForFunction(() => document.getElementById("history-status").textContent.startsWith("この結果を履歴に保存できませんでした"));
		const unsaved = await blocked.textContent("#output-text");
		assert(unsaved && !blocked.url().endsWith("editor.html"));
		await blocked.reload();
		await blocked.waitForFunction(() => !document.getElementById("btn-convert").disabled);
		assert.equal(await blocked.textContent("#output-text"), unsaved, "storage failure must not discard the current result");
		assert(await blocked.locator("#btn-open-editor").isVisible());
		await blockedContext.close();
		assert.deepEqual(errors, []);
		console.log(`[ok] ${engine.name()}: 50 persistent result cards with lazy full text, full snapshots, copy/edit, eviction, migration and storage failure recovery`);
		await browser.close();
		browser = null;
	}
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
