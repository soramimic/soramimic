// Exercise the real editor and popup handshake on distinct origins.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const local = "http://127.0.0.1:4624";
const editor = "https://dev.soramimic.pages.dev";
const video = "https://dev-video.soramimic.com";
const bridge = await readFile(new URL("../src/appBridge.js", import.meta.url), "utf8");
const historySource = await readFile(new URL("../src/generationHistory.js", import.meta.url), "utf8");
const preview = spawn(process.execPath, [
	fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
	"preview", "--host", "127.0.0.1", "--port", "4624", "--strictPort",
], { cwd: new URL("..", import.meta.url), stdio: "ignore", detached: true });
let browser;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(local)).ok) break; } catch {}
		if (i > 120) throw new Error("preview did not start");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	browser = await (process.env.BRIDGE_BROWSER === "webkit" ? webkit : chromium).launch();
	const context = await browser.newContext();
	const errors = [];
	context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === editor) {
			if (url.pathname === "/__history-test.js") return route.fulfill({ contentType: "application/javascript", body: historySource });
			return route.fulfill({ response: await route.fetch({ url: local + url.pathname + url.search }) });
		}
		if (url.origin === video) {
			return route.fulfill({ contentType: "text/html", body: `<!doctype html><body>
			<button id="send">歌詞を編集</button><p id="status"></p><script>${bridge}</script><script>
			SoramimicBridge.receive(SoramimicBridge.peer("editor"), data => {window.received = data;});
			document.getElementById("send").onclick = async () => {
				await SoramimicBridge.send(SoramimicBridge.peer("editor"), () => window.payload);
				document.getElementById("status").textContent = "accepted";
			};</script>` });
		}
		return route.abort();
	});
	const source = await context.newPage();
	await source.goto(video);
	const payload = {
		format: "soramimic-editor/1", phrases: ["シズム"],
		tokensList: [[{ surface_form: "沈む", pronunciation: "シズム", reading: "シズム", basic_form: "沈む", pos: "動詞", token_index: 0 }]],
		unitsList: [[{ pronunciation: "シ", surface_form: "し" }, { pronunciation: "ズ", surface_form: "ず" }, { pronunciation: "ム", surface_form: "む" }]],
		results: [[{ id: "0", surface: "清水", kana: "シミズ", pronunciation: "シミズ", originalkana: "シミズ", period: [0, 3], locked: true }]],
		param: {}, wordlist: { value: "ORIGINAL", text: "テスト", textOnly: true,
			csvText: "id,original,surface,pronunciation\n0,清水,清水,シミズ\n" },
		lyrics: "沈む", originalLines: ["沈む"], song: { title: "テスト曲" },
		videoMetadata: {songTitle: "手入力の曲名", songCredit: "作詞・作曲: テスト\n許諾表記", thumbnailWordlistLabel: "表示用の名前", secret: "not portable"},
		host: { review: true }, hostRequest: { secret: true }, history: ["old"],
	};
	await source.evaluate(data => { window.payload = data; }, payload);
	const opened = context.waitForEvent("page");
	await source.click("#send");
	const target = await opened;
	await target.waitForFunction(() => document.getElementById("bridge-status")?.textContent === "ビデオの歌詞を読み込みました。");
	await target.locator("#btn-video").waitFor({ state: "visible" });
	async function waitForReceivedEditor(page) {
		await page.waitForFunction(() => {
			const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
			const persisted = data?.generationHistoryId || document.getElementById("bridge-status")?.textContent.includes("過去の結果に保存できませんでした");
			return persisted && document.getElementById("editor-status").hidden && !document.getElementById("btn-regenerate").disabled;
		});
	}
	await waitForReceivedEditor(target);
	const received = await target.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	assert.deepEqual(received.results, payload.results);
	assert.deepEqual(received.unitsList, payload.unitsList);
	assert.deepEqual(received.videoMetadata, {
		songTitle: payload.videoMetadata.songTitle, songCredit: payload.videoMetadata.songCredit,
		thumbnailWordlistLabel: payload.videoMetadata.thumbnailWordlistLabel,
	});
	assert.equal(received.host, undefined);
	assert.equal(received.hostRequest, undefined);
	assert.notDeepEqual(received.history, ["old"]);
	assert(!target.url().includes("lyrics-transfer"));
	assert.equal(await target.evaluate(() => window.opener), null);
	async function historyEntries(page) {
		return page.evaluate(async () => {
			const repo = (await import("/__history-test.js")).createGenerationHistoryRepository();
			try { return await repo.list(); } finally { await repo.close(); }
		});
	}
	const receivedId = received.generationHistoryId;
	assert(receivedId, "received lyrics must be attached to persistent history");
	assert.equal((await historyEntries(target)).length, 1);
	async function sendAgain(data) {
		await source.evaluate(data => { window.payload = data; }, data);
		const opened = context.waitForEvent("page");
		await source.click("#send");
		const page = await opened;
		await waitForReceivedEditor(page);
		return page;
	}
	const duplicate = await sendAgain(payload);
	assert.equal(await duplicate.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId), receivedId);
	assert.equal((await historyEntries(duplicate)).length, 1, "repeat receipt must not add an item after editor initialization");
	await duplicate.close();
	await target.locator(".review-word").first().click();
	await target.locator(".panel-lock").click();
	await target.locator(".panel-close").click();
	await target.waitForFunction(async id => {
		const repo = (await import("/__history-test.js")).createGenerationHistoryRepository();
		try { return (await repo.list()).find(entry => entry.id === id)?.payload.results[0][0].locked === false; }
		finally { await repo.close(); }
	}, receivedId);
	const oldReceipt = await sendAgain(payload);
	const oldId = await oldReceipt.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId);
	assert.notEqual(oldId, receivedId);
	assert.equal((await historyEntries(oldReceipt)).length, 2);
	assert.equal((await historyEntries(oldReceipt)).find(entry => entry.id === receivedId).payload.results[0][0].locked, false,
		"receiving old lyrics must preserve the edited result");
	await oldReceipt.close();

	const backPromise = context.waitForEvent("page");
	await target.click("#btn-video");
	const back = await backPromise;
	await back.waitForFunction(() => window.received);
	const returned = await back.evaluate(() => window.received);
	assert.deepEqual(returned.results, [[{ ...payload.results[0][0], locked: false }]]);
	assert.deepEqual(returned.unitsList, payload.unitsList);
	assert.equal(returned.lyrics, payload.lyrics);
	assert.equal(returned.song.title, payload.song.title);
	assert.deepEqual(returned.videoMetadata, received.videoMetadata);
	assert.equal(returned.wordlist.csvText, payload.wordlist.csvText);
	assert.equal(returned.wordlist.textOnly, true);
	assert.equal(returned.generationHistoryId, undefined, "local history identity must stay on its own site");
	const roundtrip = await sendAgain(returned);
	assert.equal(await roundtrip.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId), receivedId);
	assert.equal((await historyEntries(roundtrip)).length, 2, "a return trip with unchanged lyrics must reuse the edited item");
	await roundtrip.locator("#editor-brand").click();
	await roundtrip.waitForURL(editor + "/");
	await roundtrip.waitForFunction(() => !document.getElementById("btn-convert").disabled);
	assert.equal(await roundtrip.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-main")).historyId), receivedId,
		"returning home must remember the received item even when it is older");
	await roundtrip.close();
	const reopened = await context.newPage();
	await reopened.goto(editor + "/");
	await reopened.waitForFunction(() => !document.getElementById("btn-convert").disabled);
	assert.equal(await reopened.locator(".history-item").count(), 2, "received results must persist in a new tab");
	await reopened.locator("#output-field > summary").click();
	await reopened.locator(`.history-item[data-history-id="${receivedId}"] .history-edit`).click();
	await reopened.waitForURL(editor + "/editor.html");
	assert.equal(await reopened.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId), receivedId);
	assert.equal(await reopened.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results[0][0].locked), false);
	await reopened.close();
	assert.equal(await target.evaluate(() => SoramimicBridge.peer("video").href), video + "/");
	assert.equal(await target.evaluate(() => SoramimicBridge.peer("video", "javascript:alert(1)")), null);
	assert.equal(await target.evaluate(() => {
		try { SoramimicBridge.portable({ results: [[]], unitsList: [[]], lyrics: "x".repeat(4 * 1024 * 1024) }); }
		catch { return true; }
		return false;
	}), true);

	// Invalid origin, nonce and WindowProxy must never replace the editor's data.
	const nonce = "11111111-2222-4333-8444-555555555555";
	const pendingPopup = context.waitForEvent("page");
	await source.evaluate(url => { window.pending = window.open(url); }, `${editor}/editor.html?lyrics-transfer=${nonce}`);
	const pending = await pendingPopup;
	await pending.waitForFunction(() => document.getElementById("bridge-status")?.textContent.includes("受け取っています"));
	await pending.evaluate(({ video, nonce, payload }) => {
		const data = {type:"soramimic:lyrics-transfer/1", action:"data", nonce, payload};
		window.dispatchEvent(new MessageEvent("message", {origin:"https://preview-video.soramimic.com", source:opener, data}));
		window.dispatchEvent(new MessageEvent("message", {origin:video, source:window, data}));
		window.dispatchEvent(new MessageEvent("message", {origin:video, source:opener, data:{...data, nonce:"wrong"}}));
	}, { video, nonce, payload });
	assert.equal(await pending.evaluate(() => sessionStorage.getItem("soramimic-editor")), null);
	assert.equal((await historyEntries(target)).length, 2, "invalid senders must not create history items");
	await source.evaluate(({nonce,payload,editor}) => window.pending.postMessage({type:"soramimic:lyrics-transfer/1", action:"data", nonce, payload},editor), {nonce,payload,editor});
	await pending.waitForFunction(() => JSON.parse(sessionStorage.getItem("soramimic-editor"))?.lyrics === "沈む");
	assert.equal(await pending.evaluate(() => window.opener), null);

	// Start at the real conversion screen. Long annotations and separators in
	// their surface must preserve the supplied reading all the way to Video.
	const input = await context.newPage();
	await input.goto(editor + "/");
	await input.waitForFunction(() => !document.getElementById("btn-convert").disabled);
	await input.locator("#wordlist-trigger").click();
	await input.locator('#wordlist-buttons button[data-value="POKEMON"]').click();
	const annotated = `｜${"未来".repeat(10)}《${"ミライ".repeat(10)}》\n｜雲/空《クモソラ》\n｜キ空《キョラ》`;
	await input.locator("#input-text").fill(annotated);
	await input.locator("#btn-convert").click();
	await input.waitForURL(editor + "/editor.html", { timeout: 180000 });
	const annotatedEditor = input;
	await annotatedEditor.locator("#btn-video").waitFor({ state: "visible" });
	await annotatedEditor.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	const annotatedVideoPromise = context.waitForEvent("page");
	await annotatedEditor.locator("#btn-video").click();
	const annotatedVideo = await annotatedVideoPromise;
	await annotatedVideo.waitForFunction(() => window.received);
	const annotatedResult = await annotatedVideo.evaluate(() => window.received);
	assert.equal(annotatedResult.phrases.length, 3);
	assert.equal(annotatedResult.unitsList.flat().map((u) => u.pronunciation).join(""),
		"ミライ".repeat(10) + "クモソラキョラ");
	assert.deepEqual(annotatedResult.unitsList[2].map((u) => u.pronunciation), ["キョ", "ラ"]);
	assert.deepEqual(annotatedResult.tokensList.map((row) => row.map((t) => t.surface_form).join("")),
		["未来".repeat(10), "雲/空", "キ空"]);
	console.log("[ok] annotated lyrics keep reading and spelling from conversion to Video");

	await target.evaluate(() => { window.open = () => null; });
	await target.click("#btn-video");
	await target.waitForFunction(() => document.getElementById("bridge-status").textContent.includes("ポップアップを許可"));

	const beforeFailure = (await historyEntries(target)).map(entry => entry.id);
	await context.addInitScript(() => {
		if (location.hostname === "dev.soramimic.pages.dev") {
			Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("blocked", "SecurityError"); } });
		}
	});
	const unsaved = await sendAgain(payload);
	assert((await unsaved.textContent("#bridge-status")).includes("過去の結果に保存できませんでした"));
	assert.equal(await unsaved.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).generationHistoryId), undefined);
	assert.deepEqual(await unsaved.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results), payload.results,
		"history failure must not discard the received lyrics");
	const downloadPromise = unsaved.waitForEvent("download");
	await unsaved.locator(".review-menu-toggle").click();
	await unsaved.click("#btn-export");
	const download = await downloadPromise;
	const exported = JSON.parse(await readFile(await download.path(), "utf8"));
	assert.deepEqual(exported.results, payload.results, "unsaved received lyrics must remain exportable");
	assert.deepEqual((await historyEntries(target)).map(entry => entry.id), beforeFailure);
	assert.deepEqual(errors, []);
	console.log("[ok] received lyrics persist, edits update one item, duplicate/return trips reuse it, old receipts and storage failure preserve edits");
	console.log("[ok] cross-origin editor roundtrip, portable custom list, size and sender validation");
} finally {
	await browser?.close();
	try { process.kill(-preview.pid); } catch {}
}
