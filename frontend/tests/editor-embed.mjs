// editorのナビゲーション契約:
// 単体起動では従来どおり生成画面へのリンク、video埋め込み時は親へのclose request。
// 実行: npm run build && node tests/editor-embed.mjs
import { startPreview } from "./preview.mjs";
import { chromium } from "playwright";

const { url: BASE, close: closePreview } = await startPreview();

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

let browser;
try {
	browser = await chromium.launch();
	const page = await browser.newPage();

	// 単体起動は既存の生成画面リンクを維持する。
	await page.goto(`${BASE}/editor.html`);
	assert(await page.getAttribute("#editor-brand", "href") === "./",
		"単体起動のブランドリンクが ./ ではない");
	assert(await page.textContent("#editor-brand") === "Soramimic",
		"単体起動のブランド表示が変わっている");
	// embedクエリだけをトップレベルで開いても、受信する親がいなければ通常導線。
	await page.goto(`${BASE}/editor.html?embed=video`);
	assert(await page.getAttribute("#editor-brand", "href") === "./",
		"トップレベル起動なのにブランドリンクが無効化されている");
	assert(await page.textContent("#editor-brand") === "Soramimic",
		"トップレベル起動なのに埋め込み用表示へ変わっている");

	// 同一オリジンの親ページへeditorを埋め込み、メッセージを実際に受信する。
	await page.evaluate((editorUrl) => {
		window.__closeRequests = [];
		window.addEventListener("message", (event) => {
			if (event.data && event.data.type === "soramimic:request-close") {
				window.__closeRequests.push(event.data);
			}
		});
		document.body.innerHTML = `<iframe id="editor-frame" src="${editorUrl}"></iframe>`;
	}, `${BASE}/editor.html?embed=video`);

	const frame = page.frameLocator("#editor-frame");
	const brand = frame.locator("#editor-brand");
	// The initial HTML still has the standalone link until the module runs.
	await frame.locator('#editor-brand[role="button"]').waitFor();
	assert(await brand.getAttribute("href") === null,
		"埋め込み時にも通常の ./ リンクが残っている");
	assert(await brand.textContent() === "← 動画作成に戻る",
		"埋め込み時の戻る表示が分かりにくい");
	assert(await brand.getAttribute("aria-label") === "動画作成に戻る",
		"埋め込み時のaria-labelがない");

	await brand.click();
	await page.waitForFunction(() => window.__closeRequests.length === 1);
	assert(await page.evaluate(() => window.__closeRequests[0].type)
		=== "soramimic:request-close", "close requestのメッセージ名が違う");

	console.log("[ok] editor embed navigation test passed");
} finally {
	await Promise.all([browser?.close(), closePreview()]);
}
