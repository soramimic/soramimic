import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium, webkit } from "playwright";
import { importTransferredLists, LEGACY_ORIGIN, TRANSFER_CHANNEL } from "../src/legacyTransfer.js";

const currentDist = resolve("dist");
const legacyDist = process.env.LEGACY_DIST ? resolve(process.env.LEGACY_DIST) : currentDist;
const key = "soramimic-custom-wordlists";
const sourceOrigin = "https://soramimic.com";
const makeList = (id, name, text) => ({ id, name, text, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
const incoming = [makeList("shared", "新しい自作リスト", "東京,トーキョー"), makeList("second", "もうひとつ", "大阪,オーサカ")];
const existing = [makeList("shared", "旧版で編集中", "京都,キョート")];
const state = lists => JSON.stringify({ version: 1, lists });
const original = new Map([["originalWordlist", "以前,イゼン"]]);
const storage = { getItem: key => original.get(key) ?? null, setItem: () => { throw new Error("quota"); } };
assert.throws(() => importTransferredLists(storage, incoming), /quota/);
assert.deepEqual([...original], [["originalWordlist", "以前,イゼン"]]);
assert.throws(() => importTransferredLists(storage, [{ ...incoming[0], text: 123 }]));

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".csv": "text/csv" };
for (const engine of [chromium, webkit]) {
	const browser = await engine.launch();
	try {
		const open = async ({ source = incoming, target = existing, quota = false, single = null } = {}) => {
			const context = await browser.newContext();
			const requests = [];
			await context.route("**/*", async route => {
				const url = new URL(route.request().url());
				requests.push(url.href);
				if (![sourceOrigin, LEGACY_ORIGIN].includes(url.origin)) return route.abort();
				const root = url.origin === LEGACY_ORIGIN ? legacyDist : currentDist;
				const file = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
				if (!file.startsWith(root + "/")) return route.abort();
				try { await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] || "application/octet-stream" }); }
				catch { await route.fulfill({ status: 404, body: "not found" }); }
			});
			await context.addInitScript(({ sourceOrigin, legacyOrigin, source, target, key, quota, single }) => {
				if (!sessionStorage.getItem("seeded")) {
					if (location.origin === sourceOrigin) {
						if (single !== null) localStorage.setItem("originalWordlist", single);
						else localStorage.setItem(key, JSON.stringify({ version: 1, lists: source }));
					} else if (location.origin === legacyOrigin && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ version: 1, lists: target }));
					sessionStorage.setItem("seeded", "1");
				}
				if (quota && location.origin === legacyOrigin) {
					const set = Storage.prototype.setItem;
					Storage.prototype.setItem = function (name, value) {
						if (name === key) throw new DOMException("full", "QuotaExceededError");
						return set.call(this, name, value);
					};
				}
			}, { sourceOrigin, legacyOrigin: LEGACY_ORIGIN, source, target, key, quota, single });
			const page = await context.newPage();
			await page.goto(sourceOrigin);
			await page.locator("#btn-legacy").waitFor();
			const transfer = async () => {
				const opened = context.waitForEvent("page");
				await page.click("#btn-legacy");
				return await opened;
			};
			return { context, page, transfer, requests };
		};
		let run = await open();
		let target = await run.transfer();
		await target.waitForURL(LEGACY_ORIGIN + "/");
		await run.page.waitForFunction(() => document.getElementById("legacy-status").textContent.includes("コピーしました"));
		let saved = await target.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key);
		assert.equal(saved.length, 3);
		assert.deepEqual(saved[0], existing[0]);
		assert.equal(saved[1].text, incoming[0].text);
		assert.notEqual(saved[1].id, existing[0].id);
		assert.deepEqual(saved[2], incoming[1]);
		assert.deepEqual(await run.page.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key), incoming);
		assert.equal(await target.evaluate(() => window.opener), null);
		assert(!run.requests.some(url => url.includes(encodeURIComponent("東京")) || url.includes("新しい自作リスト")));
		for (const width of [320, 390, 1200]) {
			await run.page.setViewportSize({ width, height: 844 });
			assert(await run.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
			const bounds = await run.page.locator("#btn-legacy").boundingBox();
			assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
		}
		if (process.env.LEGACY_DIST) {
			assert(await target.getByRole("complementary", { name: "旧版のご案内" }).isVisible());
			await target.waitForFunction(() => !document.getElementById("btn-convert").disabled);
			await target.click(".custom-wordlist-trigger");
			assert(await target.getByText("新しい自作リスト", { exact: true }).isVisible());
			await target.keyboard.press("Escape");
		}
		const repeated = await run.transfer();
		await repeated.waitForURL(LEGACY_ORIGIN + "/");
		assert.deepEqual(await repeated.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key), saved, "repeat transfer must not duplicate lists");
		await run.context.close();

		run = await open({ source: [], target: [], single: "以前の単語,イゼンノタンゴ" });
		target = await run.transfer();
		await target.waitForURL(LEGACY_ORIGIN + "/");
		saved = await target.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key);
		assert.equal(saved[0].text, "以前の単語,イゼンノタンゴ");
		assert.equal(saved[0].name, "自作リスト");
		await run.context.close();

		run = await open({ quota: true });
		target = await run.transfer();
		await target.waitForFunction(() => document.getElementById("transfer-status").textContent.includes("保存できません"));
		assert.equal(await target.evaluate(key => localStorage.getItem(key), key), state(existing));
		assert(!target.url().includes("#"));
		await run.page.waitForFunction(() => document.getElementById("legacy-status").textContent.includes("保存できません"));
		assert.deepEqual(await run.page.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key), incoming);
		await run.context.close();

		run = await open({ source: [] });
		target = await run.transfer();
		await target.waitForURL(LEGACY_ORIGIN + "/");
		assert.deepEqual(await target.evaluate(key => JSON.parse(localStorage.getItem(key)).lists, key), existing);
		await run.context.close();

		run = await open();
		await run.page.evaluate(() => { window.open = () => null; });
		await run.page.click("#btn-legacy");
		assert((await run.page.locator("#legacy-status").textContent()).includes("ポップアップを許可"));
		assert(await run.page.locator("#btn-legacy").isEnabled());
		await run.context.close();

		// Keep a receiver waiting and verify nonce, sender origin and sender window.
		run = await open({ target: [] });
		await run.context.addInitScript(() => { const original = window.setTimeout; window.setTimeout = (fn, ms, ...args) => original(fn, ms === 30000 ? 1000 : ms, ...args); });
		const opened = run.context.waitForEvent("page");
		await run.page.evaluate(({ LEGACY_ORIGIN, TRANSFER_CHANNEL, incoming }) => {
			window.pending = window.open(LEGACY_ORIGIN + "/legacy-transfer.html#nonce=11111111-1111-1111-1111-111111111111&from=" + encodeURIComponent(location.origin));
			window.addEventListener("message", event => {
				if (event.data?.type === "ready") pending.postMessage({ channel: TRANSFER_CHANNEL, nonce: "wrong", type: "lists", lists: incoming }, LEGACY_ORIGIN);
			});
		}, { LEGACY_ORIGIN, TRANSFER_CHANNEL, incoming });
		target = await opened;
		await target.waitForURL(LEGACY_ORIGIN + "/legacy-transfer.html");
		await target.locator("#transfer-status").waitFor();
		await target.evaluate(({ TRANSFER_CHANNEL, incoming }) => {
			const data = { channel: TRANSFER_CHANNEL, nonce: "11111111-1111-1111-1111-111111111111", type: "lists", lists: incoming };
			window.dispatchEvent(new MessageEvent("message", { source: window.opener, origin: "https://attacker.example", data }));
			window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://soramimic.com", data }));
		}, { TRANSFER_CHANNEL, incoming });
		await target.waitForFunction(() => document.getElementById("transfer-status").textContent.includes("確認できません"));
		assert.equal(await target.evaluate(key => localStorage.getItem(key), key), state([]));
		await run.context.close();
		console.log(`${engine.name()}: legacy transfer, conflict preservation, repeat copies, errors and sender validation passed`);
	} finally { await browser.close(); }
}
