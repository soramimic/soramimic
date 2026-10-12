import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { menuAction } from "./editor-ui.mjs";

const port = 4617;
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
	assert(await page.locator("#btn-import-empty").isVisible(), "empty sessions can still import lyrics");
	await page.evaluate(() => sessionStorage.setItem("soramimic-editor", JSON.stringify({
		phrases: ["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"],
		wordlist: { value: "ORIGINAL", text: "食べもの", csvText: "id,original,surface,pronunciation\n1,青森,青森,アオモリ\n2,空豆,空豆,ソラマメ\n3,白玉,白玉,シラタマ\n4,雲丹,雲丹,ウニ\n5,小松菜,小松菜,コマツナ\n6,風車,風車,カザグルマ\n7,神田,神田,カンダ\n8,京都,京都,キョート" },
	})));
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-setup-convert").disabled, undefined, { timeout: 60000 });
	assert(await page.locator("#editor-wordlist").isVisible());
	await page.click("#btn-original-edit");
	await page.fill("#editor-original-text", "青森,アオモリ\n空豆,ソラマメ\n白玉,シラタマ\n雲丹,ウニ\n小松菜,コマツナ\n風車,カザグルマ\n神田,カンダ\n京都,キョート\n酢,ス");
	await page.click("#btn-original-register");
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".review-word", { timeout: 60000 });
	assert.deepEqual(await page.locator(".review-line .review-original").allTextContents(),
		["青い空を見上げて", "白い雲を追いかける", "小さな風を感じて"]);
	const screenshot = async (name) => {
		if (!process.env.EDITOR_SCREENSHOTS) return;
		await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
		await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/${name}.png`, animations: "disabled" });
	};
	const first = page.locator(".review-word:not(.filler)").first();
	for (const colorScheme of ["dark", "light"]) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 390, 1200]) {
			await page.setViewportSize({ width, height: 740 });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "lyrics overflow");
			const regenerate = page.getByRole("button", { name: "固定中以外を再生成", exact: true });
			assert(await regenerate.isVisible(), "regeneration must stay directly accessible");
			assert.equal(await regenerate.textContent(), "↻");
			const buttonBounds = await regenerate.boundingBox();
			assert(buttonBounds.width >= 44 && buttonBounds.height >= 44, "regeneration must be touch accessible");
			assert(await page.locator("#btn-settings").isHidden(), "settings must be in the menu");
			if (width === 390 && colorScheme === "dark") await screenshot("overview");
			await first.click();
			await page.locator(".review-unit").first().scrollIntoViewIfNeeded();
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.getBoundingClientRect().height >= 700), "editing should use the viewport");
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "selection overflows");
			const done = page.getByRole("button", { name: "決定して歌詞一覧に戻る", exact: true });
			const doneBox = await done.boundingBox();
			const headerBox = await page.locator(".review-panel-header").boundingBox();
			assert(doneBox.width >= 44 && doneBox.height >= 44, "confirmation must be touch accessible");
			assert(Math.abs(doneBox.x + doneBox.width - headerBox.x - headerBox.width) < 2,
				"confirmation stays at the right edge of the header");
			assert(await page.locator(".panel-yomi-toggle").isVisible(), "source reading repair remains available");
			if (width === 390 && colorScheme === "dark") await screenshot("selection");
			await page.click(".panel-yomi-toggle");
			await page.keyboard.press("Escape");
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.classList.contains("open")), "Escape in reading dialog must preserve selection");
			await page.click(".panel-free-toggle");
			const cancelBounds = await page.locator(".panel-free-back").boundingBox();
			const applyBounds = await page.locator(".panel-free-apply").boundingBox();
			assert(Math.abs(cancelBounds.y - applyBounds.y) < 1 && cancelBounds.x + cancelBounds.width <= applyBounds.x,
				"input actions must stay side by side even at 320px");
			assert(await page.locator("#editor-panel").evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
				"input area must fit the panel width");
			await page.click(".panel-free-back");
			await done.focus();
			await page.keyboard.press("Enter");
			assert(await first.evaluate((word) => word === document.activeElement), "return focus to the selected word");
			await page.locator(".review-menu-toggle").click();
			assert(await page.getByRole("button", { name: "設定", exact: true }).isVisible());
			assert(await page.locator("#copy-format").isVisible());
			const fileButtons = await Promise.all(["#btn-import", "#btn-export"].map((id) => page.locator(id).boundingBox()));
			assert.equal(fileButtons[0].y, fileButtons[1].y, "file actions should share a row");
			for (const id of ["#btn-settings", "#btn-import", "#btn-export", "#btn-copy", "#copy-format"]) {
				assert((await page.locator(id).boundingBox()).height >= 44, `${id} must be touch accessible`);
			}
			assert(await page.locator(".editor-copy-format-label").evaluate((label) => label.scrollWidth <= label.clientWidth),
				"copy format text should wrap without clipping");
			const formatBounds = await page.locator(".editor-copy-format").boundingBox();
			assert((await page.locator("#copy-format").boundingBox()).width >= formatBounds.width - 2,
				"the whole format field must open the native selector");
			await page.selectOption("#copy-format", "3");
			assert.equal(await page.locator(".editor-copy-format-label").textContent(),
				await page.locator("#copy-format option:checked").textContent(), "selected format label must update");
			await page.selectOption("#copy-format", "4");
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "menu overflows");
			if (width === 390 && colorScheme === "dark") await screenshot("menu");
			await page.keyboard.press("Escape");
			assert.equal(await page.locator(".review-menu").evaluate((menu) => !menu.querySelector(".review-menu-body").hidden), false);
		}
	}
	await page.setViewportSize({ width: 390, height: 740 });
	await page.emulateMedia({ colorScheme: "dark" });
	await menuAction(page, "#btn-settings");
	assert(await page.getByRole("heading", { name: "設定", exact: true }).isVisible());
	assert(await page.locator(".review-menu-body").isHidden(), "opening settings must dismiss the menu");
	for (const selector of ["#editor-wordlist", "#editor-preset-buttons"]) {
		assert(await page.locator(selector).isVisible(), `${selector} settings retained`);
	}
	for (const selector of ["#editor-param-area", "#editor-duplicate-buttons"]) {
		assert(await page.locator(selector).isHidden(), `${selector} starts collapsed`);
	}
	await screenshot("settings");
	await page.locator("#editor-advanced-settings > summary").focus();
	await page.keyboard.press("Enter");
	for (const selector of ["#editor-param-area", "#editor-duplicate-buttons"]) {
		assert(await page.locator(selector).isVisible(), `${selector} expands with the keyboard`);
	}
	await screenshot("settings-expanded");
	await page.click("#btn-settings-close");
	assert(await page.locator(".review-menu-toggle").evaluate((button) => button === document.activeElement),
		"closing settings must return focus to the menu toggle");
	await first.click();
	await page.locator(".panel-close").focus();
	await page.keyboard.press("Shift+Tab");
	assert(await page.locator("#editor-panel").evaluate((panel) => panel.contains(document.activeElement)), "focus stays inside selection");
	await page.click(".panel-free-toggle");
	assert.equal(await page.locator(".panel-done").count(), 0, "free input uses its own apply action");
	assert(await page.locator(".panel-free-reading").isHidden());
	await page.click(".review-reading-input summary");
	assert(await page.locator(".panel-free-reading").isVisible());
	await page.keyboard.press("Escape");
	assert(await page.locator("#editor-panel").evaluate((panel) => panel.open) &&
		await page.locator(".panel-candidates").isVisible(), "Escape from custom input returns to candidates");
	assert(await page.locator(".panel-free-toggle").evaluate((button) => document.activeElement === button),
		"keyboard cancellation returns focus to the input launcher");
	await page.evaluate(() => { navigator.clipboard.writeText = async (value) => { window.copied = value; }; });
	await menuAction(page, "#btn-copy");
	await page.waitForFunction(() => window.copied?.length > 0);
	assert.equal(await page.locator("#btn-copy svg").count(), 1, "copy feedback must preserve its icon");
	assert.equal(await page.locator(".review-menu").evaluate((menu) => !menu.querySelector(".review-menu-body").hidden), false);

	// 全体再生成だけ確認し、取り消しでは歌詞・履歴・確認の設定を変えない。
	const readHistory = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("soramimic-editor")).history.length);
	const initialHistory = await readHistory();
	const initialResults = await page.evaluate(() => JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results));
	const confirmation = page.getByRole("dialog", { name: "全体を再生成しますか？" });
	await page.click("#btn-regenerate");
	assert(await confirmation.isVisible());
	await screenshot("regenerate-confirmation");
	await page.check("#regenerate-skip-confirmation");
	await page.click("#btn-regenerate-cancel");
	assert.equal(await readHistory(), initialHistory);
	assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(sessionStorage.getItem("soramimic-editor")).results)), initialResults);
	assert.equal(await page.evaluate(() => localStorage.getItem("soramimic-skip-regenerate-confirmation")), null);
	await page.click("#btn-regenerate");
	assert.equal(await page.isChecked("#regenerate-skip-confirmation"), false);
	await page.keyboard.press("Escape");
	assert.equal(await confirmation.isVisible(), false);
	assert.equal(await readHistory(), initialHistory);

	// 実際の進捗表示中もツールバーと歌詞の先頭が移動しない。
	const positions = await page.evaluate(() => {
		const readPositions = () => ["#editor-toolbar", ".review-line"].map((selector) =>
			document.querySelector(selector).getBoundingClientRect().top);
		window.regenerationPositions = [];
		const progress = document.getElementById("regen-progress");
		new MutationObserver(() => {
			if (!progress.hidden) window.regenerationPositions.push(readPositions());
		}).observe(progress, { attributes: true, childList: true });
		return readPositions();
	});
	await page.click("#btn-regenerate");
	await page.click("#btn-regenerate-confirm");
	const waitRegenerated = (history) => page.waitForFunction((before) =>
		JSON.parse(sessionStorage.getItem("soramimic-editor")).history.length > before
		&& document.getElementById("regen-progress").hidden, history);
	await waitRegenerated(initialHistory);
	const samples = await page.evaluate(() => window.regenerationPositions);
	assert(samples.length > 0, "must observe progress during regeneration");
	for (const sample of samples) assert.deepEqual(sample, positions, "progress must not shift toolbar or lyrics");
	await page.click("#btn-regenerate");
	assert(await confirmation.isVisible(), "confirmation repeats unless opted out");
	await page.click("#btn-regenerate-cancel");

	const beforeLine = await readHistory();
	await page.locator(".line-regenerate").first().click();
	await waitRegenerated(beforeLine);
	assert.equal(await confirmation.isVisible(), false, "line regeneration must not require full regeneration confirmation");

	// 確認を省略する設定は再読み込み後も保持する。
	const beforeOptOut = await readHistory();
	await page.click("#btn-regenerate");
	await page.check("#regenerate-skip-confirmation");
	await page.click("#btn-regenerate-confirm");
	await waitRegenerated(beforeOptOut);
	await page.reload();
	await page.waitForFunction(() => !document.getElementById("btn-regenerate").disabled);
	const beforeSkipped = await readHistory();
	await page.click("#btn-regenerate");
	await waitRegenerated(beforeSkipped);
	assert.equal(await confirmation.isVisible(), false, "opt-out must survive reload");
	assert.deepEqual(errors, []);
	console.log("[ok] editor layout: settings retained, responsive lyrics and selection, menus, keyboard, source reading, custom input");
} finally {
	await browser?.close();
	try { process.kill(-server.pid); } catch {}
}
