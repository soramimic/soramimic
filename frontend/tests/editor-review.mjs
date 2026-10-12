import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { selectRange } from "./editor-ui.mjs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = Number(process.env.EDITOR_REVIEW_PORT || 4612);
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
	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 740 }, colorScheme: "dark" });
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${base}/editor.html`);
	await page.evaluate(() => sessionStorage.setItem("soramimic-editor", JSON.stringify({
		phrases: ["アオイソラヲミアゲテ", "シロイクモヲオイカケル", "チイサナカゼヲカンジテ"],
		wordlist: { value: "ORIGINAL", text: "テスト", csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ\n3,白玉,白玉,シラタマ\n4,雲丹,雲丹,ウニ\n5,小松菜,小松菜,コマツナ\n6,風車,風車,カザグルマ\n7,神田,神田,カンダ\n8,京都,京都,キョート" },
	})));
	await page.evaluate(() => localStorage.setItem("originalWordlist",
		JSON.parse(sessionStorage.getItem("soramimic-editor")).wordlist.csvText));
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-setup-convert").disabled, undefined, { timeout: 60000 });
	await page.click("#btn-original-edit");
	await page.fill("#editor-original-text", "青森,アオモリ\n空豆,ソラマメ\n白玉,シラタマ\n雲丹,ウニ\n小松菜,コマツナ\n風車,カザグルマ\n神田,カンダ\n京都,キョート\n酢,ス");
	await page.click("#btn-original-register");
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".review-word", { timeout: 60000 });
	const seed = await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		data.host = { review: true, songs: [], canUploadSong: false };
		data.lyrics = "青い空を見上げて\n白い雲を追いかける\n小さな風を感じて";
		data.originalLines = ["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"];
		sessionStorage.setItem("soramimic-editor", JSON.stringify(data));
		return data;
	});
	if (!seed.results[0].some((word) => !word.filler)) {
		console.error({ wordlist: seed.wordlist, param: seed.param, result: seed.results[0] });
		throw new Error("test seed must include candidate words");
	}
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled, undefined, { timeout: 60000 });
	assert.deepEqual(await page.locator(".review-original").allTextContents(), seed.originalLines);
	for (const selector of ["#btn-settings", "#btn-import", "#btn-export", "#btn-copy", ".chip-unit", "#btn-regenerate"]) {
		assert.equal(await page.locator(selector).isVisible(), false, `${selector} should be concealed`);
	}
	const source = await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return [data.unitsList, data.tokensList, data.originalLines];
	});
	const firstWord = page.locator('.review-line[data-line="0"] .review-word:not(.filler)').first();
	const before = await firstWord.textContent();
	await firstWord.click();
	await page.waitForSelector("#editor-panel.open .candidate").catch(async (error) => {
		console.error({ errors, before, panel: await page.locator("#editor-panel").textContent() });
		throw error;
	});
	assert(await page.locator(".review-unit").first().isVisible(), "reading and range remain visible");
	assert.equal(await page.locator(".panel-yomi-toggle").count(), 0);
	const panelBox = await page.locator("#editor-panel").boundingBox();
	assert(panelBox.height >= 700, "candidate editor should use the mobile viewport");
	await firstWord.focus();
	assert(await page.locator("#editor-panel").evaluate((node) => node.open && node.contains(document.activeElement)), "background cannot receive focus during selection");
	const candidate = page.locator(".candidate").filter({ hasNotText: before }).first();
	const chosen = await candidate.locator(".candidate-surface").textContent();
	await candidate.click();
	await page.waitForFunction(() => !document.getElementById("editor-panel").classList.contains("open"));
	assert.equal(await firstWord.textContent(), chosen);
	assert(await firstWord.evaluate((node) => node.classList.contains("locked")));
	assert.equal(await firstWord.locator(".chip-lock-icon").count(), 1);
	assert.match(await firstWord.getAttribute("aria-label"), /固定中/);
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), before);
	await page.click("#btn-redo");
	assert.equal(await firstWord.textContent(), chosen);
	await firstWord.click();
	const start = Number(await firstWord.getAttribute("data-start"));
	const end = Number(await firstWord.getAttribute("data-end"));
	if (end < seed.unitsList[0].length) {
		await page.click(`.review-unit[data-index="${end}"]`);
		assert.equal(await page.locator('.review-unit[aria-pressed="true"]').count(), end - start + 1);
		assert(await page.locator(".review-unit").first().isVisible());
	}
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#editor-panel").evaluate((node) => node.classList.contains("open")), false);
	assert.deepEqual(await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return [data.unitsList, data.tokensList, data.originalLines];
	}), source, "review must keep the host's analyzed source and alignment");
	for (const colorScheme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 320, height: 640 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "overview overflows");
		await firstWord.click();
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "candidates overflow");
		await page.click(".panel-close");
	}
	await page.reload();
	await page.waitForSelector(".review-word");
	assert.equal(await firstWord.textContent(), chosen, "edits should survive reopening");
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	await firstWord.click();
	await page.click(".panel-free-toggle");
	assert(await page.locator(".panel-free-reading").isHidden());
	await page.fill(".panel-free-surface", "手入力の語");
	await page.click(".review-reading-input summary");
	await page.fill(".panel-free-reading", await page.evaluate(() => {
		const data = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return data.results[0].find((word) => !word.filler).kana;
	}));
	await page.click(".panel-free-apply");
	assert.equal(await firstWord.textContent(), "手入力の語");
	assert(await page.locator("#editor-panel").evaluate((panel) => panel.open));
	const selectedCandidate = page.locator('.candidate[aria-pressed="true"]');
	const assertUnassignedSelection = async (indices) => {
		assert(await page.locator("#editor-panel").evaluate((node) => node.open),
			"clearing an assignment keeps the candidate dialog open");
		assert.deepEqual(await page.locator('.review-unit[aria-pressed="true"]').evaluateAll(
			(nodes) => nodes.map((node) => Number(node.dataset.index))), indices,
			"clearing preserves the selected source range");
		assert.equal(await page.locator('.candidate[aria-pressed="true"], .group-entry[aria-pressed="true"]').count(), 0,
			"clearing removes the selected candidate state");
	};
	assert.equal(await selectedCandidate.count(), 1, "custom input appears as the only selected candidate");
	assert.equal(await selectedCandidate.locator(".candidate-surface").textContent(), "手入力の語");
	assert(await selectedCandidate.locator(".candidate-source").isVisible(), "custom input is identified in candidates");
	assert(await page.locator(".panel-candidates > .panel-free-toggle").isVisible(), "custom input belongs to the candidate grid");
	const customBeforeEdit = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	await page.click(".panel-free-toggle");
	assert.equal(await page.inputValue(".panel-free-surface"), "手入力の語", "editing starts with the custom word");
	assert.equal(await page.inputValue(".panel-free-reading"), customBeforeEdit.results[0].find((word) => word.surface === "手入力の語").kana,
		"editing retains the custom reading");
	await page.fill(".panel-free-surface", "入力途中");
	await page.click(".panel-free-back");
	assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor"))), customBeforeEdit,
		"closing custom input discards the draft without changing the assignment or history");
	await page.click(".panel-free-toggle");
	assert.equal(await page.inputValue(".panel-free-surface"), "手入力の語");
	await page.fill(".panel-free-surface", "編集した語");
	await page.click(".panel-free-apply");
	assert(await page.locator("#editor-panel").evaluate((panel) => panel.open));
	assert.equal(await selectedCandidate.locator(".candidate-surface").textContent(), "編集した語");
	assert(await selectedCandidate.locator(".candidate-source").isVisible());
	await page.click(".panel-close");
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), "手入力の語", "undo restores the previous custom word");
	await firstWord.click();
	assert.equal(await page.locator(".panel-clear").count(), 0, "the eraser action is removed");
	const unselected = page.locator('.candidate[aria-pressed="false"]').first();
	await unselected.hover();
	assert.notEqual(await unselected.evaluate((node) => getComputedStyle(node).borderColor),
		await selectedCandidate.evaluate((node) => getComputedStyle(node).borderColor),
		"hovered and selected candidates must have different borders");
	await page.keyboard.press("Tab");
	await unselected.focus();
	assert(await unselected.evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle !== "none"),
		"keyboard focus remains visible");
	await selectedCandidate.click();
	assert.equal(await page.locator(".review-word-surface").filter({ hasText: "手入力の語" }).count(), 0);
	await assertUnassignedSelection(Array.from({ length: end - start }, (_, index) => start + index));
	await page.click(".panel-close");
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), "手入力の語", "undo restores custom input after deselection");
	await page.click("#btn-undo");
	assert.equal(await firstWord.textContent(), chosen);

	// Cover leading/middle/trailing gaps, explicit fillers, and a fully empty line.
	const gapSeed = structuredClone(seed);
	gapSeed.param.DUPLICATE = true; // Gap rendering also covers repeated fixed words.
	const one = (start) => ({
		id: "9", surface: "酢", kana: "ス", pronunciation: ["ス"],
		period: [start, start + 1], locked: true,
	});
	const filler = (line, start, end) => ({
		filler: true, period: [start, end],
		surface: gapSeed.unitsList[line].slice(start, end).map((u) => u.pronunciation).join(""),
	});
	gapSeed.results = [
		[one(1), filler(0, 2, 3), filler(0, 3, 4), one(4)],
		[],
		[filler(2, 0, gapSeed.unitsList[2].length)],
	];
	await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), gapSeed);
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	const line = (index) => page.locator(`.review-line[data-line="${index}"]`);
	const gaps = (index) => line(index).locator(".review-word.filler");
	const periods = (chips) => chips.evaluateAll((nodes) => nodes.map((node) =>
		[Number(node.dataset.start), Number(node.dataset.end)]));
	assert.deepEqual(await periods(gaps(0)), [[0, 1], [2, 4], [5, gapSeed.unitsList[0].length]]);
	for (const index of [1, 2]) {
		assert.deepEqual(await periods(gaps(index)), [[0, gapSeed.unitsList[index].length]]);
	}
	assert(await page.locator(".review-word.filler").evaluateAll((nodes) =>
		nodes.every((node) => node.getAttribute("aria-label").startsWith("未対応、"))));
	assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).results),
		gapSeed.results, "displaying uncovered ranges must not rewrite saved conversion results");
	for (const colorScheme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "gaps overflow");
	}
	await gaps(0).first().click();
	assert(await page.locator(".review-unit").first().isVisible());
	assert.equal(await page.locator(".review-panel-header .panel-lock").count(), 0);
	await page.locator(".candidate").first().click();
	assert.deepEqual(await periods(gaps(0)), [[2, 4], [5, gapSeed.unitsList[0].length]]);
	await page.click("#btn-undo");
	assert.deepEqual(await periods(gaps(0)), [[0, 1], [2, 4], [5, gapSeed.unitsList[0].length]]);
	await page.click("#btn-redo");
	assert.equal(await gaps(0).count(), 2);
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	assert.equal(await gaps(0).count(), 2, "assigned gaps remain filled after reopening");
	await gaps(1).click();
	assert.equal(await page.locator('.review-unit[aria-pressed="true"]').count(), gapSeed.unitsList[1].length);
	await page.click('.review-unit[data-index="2"]');
	await page.locator(".candidate").first().click();
	assert.deepEqual(await periods(gaps(1)), [[0, 2], [3, gapSeed.unitsList[1].length]]);
	await gaps(2).click();
	await page.click('.review-unit[data-index="2"]');
	await page.locator(".candidate").first().click();
	assert.deepEqual(await periods(gaps(2)), [[0, 2], [3, gapSeed.unitsList[2].length]],
		"replacing part of a filler must keep the remaining source visible");
	assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).unitsList),
		gapSeed.unitsList, "filling gaps preserves source units");

	// The host must regenerate every unlocked word, including untouched lines.
	const regenSeed = structuredClone(gapSeed);
	regenSeed.results = [[one(1)], [{
		id: "custom-old", surface: "再生成対象", kana: "シロイクモヲオイカケル",
		pronunciation: regenSeed.unitsList[1].map((unit) => unit.pronunciation),
		period: [0, regenSeed.unitsList[1].length],
	}], []];
	regenSeed.dirtyLines = [];
	await page.evaluate((value) => sessionStorage.setItem("soramimic-editor", JSON.stringify(value)), regenSeed);
	await page.reload();
	await page.waitForFunction(() => window.soramimicVideoReview);
	await page.evaluate(() => window.soramimicVideoReview.regenerateUnlocked());
	const regenerated = await page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const fixed = regenerated.results[0].find((word) => word.locked);
	assert.equal(fixed.surface, "酢");
	assert.deepEqual(fixed.period, [1, 2]);
	assert(!regenerated.results.flat().some((word) => word.surface === "再生成対象"));
	for (const [index, words] of regenerated.results.entries()) {
		let cursor = 0;
		for (const word of words) {
			assert.equal(word.period[0], cursor);
			cursor = word.period[1];
		}
		assert.equal(cursor, regenSeed.unitsList[index].length);
	}
	assert.deepEqual(regenerated.unitsList, regenSeed.unitsList);
	const fixedChip = line(0).locator('.review-word[data-start="1"]');
	assert(await fixedChip.evaluate((node) => node.classList.contains("locked")));
	await fixedChip.click();
	await page.click(".panel-lock");
	await page.click(".panel-close");
	assert.equal(await fixedChip.locator(".chip-lock-icon").count(), 0);
	assert.equal(await fixedChip.evaluate((node) => node.classList.contains("locked")), false);
	await page.click("#btn-undo");
	assert(await fixedChip.evaluate((node) => node.classList.contains("locked")));
	// Clearing and moving a fixed assignment preserve the source and undo atomically.
	const readData = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")));
	const loadSeed = async (value) => {
		await page.evaluate((data) => sessionStorage.setItem("soramimic-editor", JSON.stringify(data)), value);
		await page.reload();
		await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	};
	const emptySeed = structuredClone(seed);
	emptySeed.results = [[], [], []];
	emptySeed.history = [];
	emptySeed.future = [];
	emptySeed.dirtyLines = [];
	emptySeed.param.DUPLICATE = false;
	await loadSeed(emptySeed);
	await selectRange(page, 2, 2);
	assert.equal(await page.locator('.candidate[aria-pressed="true"], .panel-clear-range').count(), 0, "unassigned source has nothing to clear");
	const vinegar = page.locator(".candidate").filter({ has: page.locator(".candidate-surface", { hasText: /^酢$/ }) });
	await vinegar.click();
	const placed = (await readData()).results[2][0];
	const fixedAssignment = (start, end = start + 1) => ({ ...structuredClone(placed), period: [start, end] });
	const assignmentSeed = structuredClone(emptySeed);
	assignmentSeed.results = [[fixedAssignment(1)], [fixedAssignment(2)], []];
	await loadSeed(assignmentSeed);
	await line(0).locator('.review-word[data-start="1"]').click();
	assert.equal(await selectedCandidate.count(), 1);

	await selectedCandidate.click();
	assert.deepEqual((await readData()).results[0], []);
	assert.equal(await gaps(0).count(), 1, "cleared word is shown as unassigned source");
	await assertUnassignedSelection([1]);
	if (process.env.EDITOR_SCREENSHOTS) {
		await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
		await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/clear-assignment.png` });
	}
	await page.click(".panel-close");
	await page.click("#btn-undo");
	assert.deepEqual((await readData()).results, assignmentSeed.results);
	await page.click("#btn-redo");
	assert.deepEqual((await readData()).results[0], []);
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	assert.deepEqual((await readData()).results[0], [], "clearing survives reopening");

	await loadSeed(assignmentSeed);
	await selectRange(page, 2, 2);
	await vinegar.click();
	const conflict = page.locator("#editor-assignment-dialog");
	assert(await conflict.isVisible());
	assert.equal(await page.locator("#assignment-conflict-locations li").count(), 2);
	assert.deepEqual((await readData()).results, assignmentSeed.results);
	assert.equal((await readData()).history.length, 0);
	assert(await page.locator("#btn-assignment-keep").evaluate((node) => node === document.activeElement));
	if (process.env.EDITOR_SCREENSHOTS) await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/assignment-conflict.png` });
	await page.keyboard.press("Escape");
	assert(await conflict.isHidden());
	assert(await page.locator("#editor-panel").evaluate((node) => node.open));
	assert(await vinegar.evaluate((node) => node === document.activeElement));
	await vinegar.click();
	await page.click("#btn-assignment-keep");
	assert.deepEqual((await readData()).results, assignmentSeed.results);
	assert.equal((await readData()).history.length, 0, "keeping the original is not an edit");
	await vinegar.click();
	await page.click("#btn-assignment-move");
	const moved = await readData();
	assert.deepEqual(moved.results.slice(0, 2), [[], []]);
	assert.equal(moved.results[2][0].id, placed.id);
	assert.equal(moved.results[2][0].locked, true);
	assert.deepEqual(moved.dirtyLines.sort(), [0, 1, 2]);
	assert.equal(moved.history.length, 1);
	assert.deepEqual([moved.unitsList, moved.tokensList, moved.originalLines],
		[assignmentSeed.unitsList, assignmentSeed.tokensList, assignmentSeed.originalLines]);
	await page.click("#btn-undo");
	assert.deepEqual((await readData()).results, assignmentSeed.results, "one undo restores all affected lines");
	await page.click("#btn-redo");
	assert.deepEqual((await readData()).results, moved.results);
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	assert.deepEqual((await readData()).results, moved.results);

	const sameLine = structuredClone(emptySeed);
	sameLine.results[2] = [fixedAssignment(0), fixedAssignment(2)];
	await loadSeed(sameLine);
	await selectRange(page, 2, 2);
	await vinegar.click();
	assert(await conflict.isHidden(), "deselecting the current word needs no duplicate warning");
	assert.deepEqual((await readData()).results[2].map((word) => word.period), [[0, 1]],
		"deselecting affects only the current assignment");
	await assertUnassignedSelection([2]);
	await vinegar.click();
	assert.equal(await page.locator("#assignment-conflict-locations li").count(), 1);
	await page.click("#btn-assignment-move");
	assert.deepEqual((await readData()).results[2].map((word) => word.period), [[2, 3]]);

	const partial = structuredClone(emptySeed);
	partial.results[0] = [fixedAssignment(1, 3), { ...fixedAssignment(3), id: "another" }, { ...fixedAssignment(6), id: "unrelated" }];
	await loadSeed(partial);
	await selectRange(page, 0, 2, 3);
	await page.click(".panel-clear-range");
	assert.deepEqual((await readData()).results[0], [partial.results[0][2]], "clear overlapping assignments and preserve unrelated ones");
	await assertUnassignedSelection([2, 3]);
	await page.click(".panel-close");
	await page.click("#btn-undo");
	assert.deepEqual((await readData()).results, partial.results);

	for (const duplicate of [false, true]) {
		const allowed = structuredClone(assignmentSeed);
		allowed.param.DUPLICATE = duplicate;
		if (!duplicate) allowed.results.flat().forEach((word) => { word.locked = false; });
		await loadSeed(allowed);
		await selectRange(page, 2, 2);
		await vinegar.click();
		assert(await conflict.isHidden(), "unlocked uses or explicitly allowed duplicates need no priority choice");
		assert.deepEqual((await readData()).results.slice(0, 2), allowed.results.slice(0, 2));
	}
	const retained = structuredClone(assignmentSeed);
	retained.results[0][0] = { ...fixedAssignment(1), surface: "別リストの語", wordlistSource: "previous-list" };
	await loadSeed(retained);
	await line(0).locator('.review-word[data-start="1"]').click();
	assert.equal(await selectedCandidate.count(), 1, "a retained word is available even when absent from fetched candidates");
	assert.equal(await selectedCandidate.locator(".candidate-surface").textContent(), "別リストの語");
	assert.equal(await vinegar.getAttribute("aria-pressed"), "false", "a reused ID in the new list is not selected");
	await selectedCandidate.click();
	assert.deepEqual((await readData()).results[0], []);
	await assertUnassignedSelection([1]);

	const grouped = structuredClone(emptySeed);
	grouped.wordlist = { value: "ORIGINAL", text: "同名", csvText: "id,original,surface,pronunciation\n1,酢A,酢,ス\n2,酢B,酢,ス" };
	await loadSeed(grouped);
	await selectRange(page, 0, 1);
	await page.locator('.candidate:has(.candidate-count)').click();
	assert.equal(await page.locator(".group-entry").count(), 2);
	await page.locator(".group-entry").last().click();
	const groupChosen = (await readData()).results[0][0];
	assert.equal(groupChosen.id, "2");
	await line(0).locator('.review-word[data-start="1"]').click();
	assert.equal(await selectedCandidate.count(), 1);
	await selectedCandidate.click();
	assert.deepEqual((await readData()).results[0], [], "the selected group can be deselected with one tap");
	await assertUnassignedSelection([1]);
	await page.click(".panel-close");
	await page.click("#btn-undo");
	assert.deepEqual((await readData()).results[0], [groupChosen]);
	assert.deepEqual(errors, []);
	console.log("[ok] compact review: source spelling, mobile layout, candidates, visible range, unmatched gaps, assignment clearing, fixed-word priority, undo/redo, recovery");
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
