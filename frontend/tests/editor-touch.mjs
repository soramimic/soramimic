// 編集ツール(#17)のタッチ操作E2E: モバイル相当の環境(狭い画面+実タッチイベント)で
// タップによる選択の伸縮・ドラッグ範囲選択・長押し詳細を検証する。
// マウスとタッチでイベント経路が異なる(clickが飛ばない・指の揺れ等)ため、
// editor-smoke.mjs(マウス)とは別にタッチで一通り操作する。
// 実行: npm run build && node tests/editor-touch.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4399;

function waitForServer(url, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		(async function poll() {
			try {
				const res = await fetch(url);
				if (res.ok) return resolve();
			} catch {}
			if (Date.now() - started > timeoutMs) {
				return reject(new Error("preview server did not start"));
			}
			setTimeout(poll, 300);
		})();
	});
}

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
	stdio: "ignore",
	detached: true,
});

let exitCode = 1;
try {
	await waitForServer(`http://localhost:${PORT}/`);
	const browser = await chromium.launch();
	// スマホ相当: 狭い画面+タッチ入力
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	// 外部リクエスト(読みAPI・GA)を遮断して決定的なトークナイズに固定
	await context.route(
		(url) => url.hostname !== "localhost",
		(route) => route.abort(),
	);
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e));

	// ---- 変換して編集ツールを開く ----
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	await page.fill("#input-text", "忘れがたき故郷");
	await page.click("#btn-convert");
	await page.waitForFunction(
		() => {
			const out = document.getElementById("output-text");
			return !document.getElementById("output-field").hidden && out.value.length > 0;
		},
		{ timeout: 120000 },
	);
	const [editor] = await Promise.all([
		context.waitForEvent("page"),
		page.click("#btn-open-editor"),
	]);
	editor.on("pageerror", (e) => pageErrors.push(e));
	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 60000 });
	await editor.waitForFunction(
		() => !document.getElementById("btn-regenerate").disabled,
		{ timeout: 120000 },
	);

	const cdp = await context.newCDPSession(editor);

	// ユニットチップの中心座標(再描画で要素が入れ替わるため毎回取り直す)
	async function unitCenter(i) {
		const box = await editor.locator(".chip-unit").nth(i).boundingBox();
		assert(box, `ユニット${i}が見つからない`);
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}

	async function selTitle() {
		return editor.evaluate(() => {
			const panel = document.getElementById("editor-panel");
			const t = panel.querySelector(".panel-title");
			return panel.classList.contains("open") && t ? t.textContent : "(選択なし)";
		});
	}

	// タップ後の選択状態を条件待ちで検証する。固定waitだと遅いCIランナーで
	// 描画が間に合わずフレークするため、期待状態になるまで待つ
	async function tapAndExpect(unitIndex, expected, label) {
		await editor.touchscreen.tap(...Object.values(await unitCenter(unitIndex)));
		try {
			await editor.waitForFunction((exp) => {
				const panel = document.getElementById("editor-panel");
				const t = panel.querySelector(".panel-title");
				const title = panel.classList.contains("open") && t
					? t.textContent : "(選択なし)";
				return exp === "(選択なし)" ? title === exp : title.includes(exp);
			}, expected, { timeout: 5000 });
		} catch {
			throw new Error(`${label}: ${await selTitle()}(期待: ${expected})`);
		}
		// 次のタップまで人間相当の間隔をあける(同一チップへの超高速連打は
		// ブラウザのダブルタップ判定と競合し、実利用では起きない)
		await editor.waitForTimeout(300);
	}

	// ---- タップでの選択の伸縮(実タッチ) ----
	await tapAndExpect(0, "選択範囲: 忘(", "タップで新規選択されない");
	await tapAndExpect(1, "ワス", "隣接タップで拡張されない");
	await tapAndExpect(1, "選択範囲: 忘(", "端タップで縮小されない");
	await tapAndExpect(0, "(選択なし)", "単独再タップで解除されない");

	// ---- タッチドラッグでの範囲選択 ----
	const from = await unitCenter(0);
	const to = await unitCenter(3);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart", touchPoints: [{ x: from.x, y: from.y }],
	});
	// 中間点を数回なぞる(スロップ閾値超え→ドラッグ確定の経路を通す)
	for (let i = 1; i <= 6; i++) {
		const x = from.x + ((to.x - from.x) * i) / 6;
		const y = from.y + ((to.y - from.y) * i) / 6;
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove", touchPoints: [{ x, y }],
		});
		await editor.waitForTimeout(30);
	}
	// ドラッグ中はパネルが出ないこと
	const openDuringDrag = await editor.evaluate(
		() => document.getElementById("editor-panel").classList.contains("open"));
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	assert(!openDuringDrag, "ドラッグ中にパネルが表示されている");
	try {
		await editor.waitForFunction(() => {
			const t = document.querySelector("#editor-panel.open .panel-title");
			return t && t.textContent.includes("ワスレガ");
		}, undefined, { timeout: 5000 });
	} catch {
		throw new Error("ドラッグで範囲選択されない: " + await selTitle());
	}

	// ---- 候補の長押しで詳細ポップオーバー(差し替えは発火しない) ----
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	// パネル表示時の自動スムーススクロールが座標取得とずれないよう静定を待つ
	await editor.waitForTimeout(600);
	const lockedBefore = await editor.locator(".chip-word.locked").count();
	const cand = await editor.locator(".panel-candidates .candidate").first().boundingBox();
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart", touchPoints: [{ x: cand.x + 10, y: cand.y + 10 }],
	});
	// 押したままポップオーバーが出るのを待つ(長押し判定は500ms)
	let popoverShown = true;
	try {
		await editor.waitForSelector(".editor-popover", { timeout: 3000 });
	} catch {
		popoverShown = false;
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await editor.waitForTimeout(300);
	assert(popoverShown, "長押しで詳細ポップオーバーが出ない");
	const lockedAfter = await editor.locator(".chip-word.locked").count();
	assert(lockedAfter === lockedBefore, "長押しなのに差し替えが発火した");

	// ---- タップでの差し替えは通常どおり動くこと ----
	// ×N付き(同名グループ)は個別選択リストが開くため、単独候補を選ぶ
	const single = editor.locator(".panel-candidates .candidate:not(:has(.candidate-count))").first();
	const candSurface = await single.locator(".candidate-surface").textContent();
	const cand2 = await single.boundingBox();
	await editor.touchscreen.tap(cand2.x + 10, cand2.y + 10);
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	const lockedSurface = await editor.textContent(".chip-word.locked .chip-word-surface");
	assert(candSurface.startsWith(lockedSurface),
		`タップ差し替えが反映されない: 候補=${candSurface} チップ=${lockedSurface}`);

	// ---- 「変換のしかた」モーダルがタッチで開けて操作できること ----
	// ツールバーの⚙・中のプリセット・×は、指でも押せる大きさで並んでいる必要がある
	const gearEl = editor.locator("#btn-settings");
	await gearEl.scrollIntoViewIfNeeded();
	const gear = await gearEl.boundingBox();
	assert(gear.width >= 28 && gear.height >= 28,
		`⚙がタッチには小さい: ${gear.width}x${gear.height}`);
	await editor.touchscreen.tap(gear.x + gear.width / 2, gear.y + gear.height / 2);
	await editor.waitForFunction(() => document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await editor.waitForSelector("#editor-param-area input[type=range]", { timeout: 10000 });

	// 狭い画面ではほぼ全画面(横幅いっぱい)になっていること
	const dlg = await editor.locator("#editor-settings").boundingBox();
	assert(dlg.width >= 390 * 0.95,
		"狭い画面でモーダルが全画面になっていない(幅): " + dlg.width);
	assert(dlg.height >= 844 * 0.9,
		"狭い画面でモーダルが全画面になっていない(高さ): " + dlg.height);

	const preset = await editor.locator("#editor-preset-buttons button:has-text('長い単語')").boundingBox();
	assert(preset.height >= 28, "プリセットボタンがタッチには小さい: " + preset.height);
	await editor.touchscreen.tap(preset.x + preset.width / 2, preset.y + preset.height / 2);
	const wordnum = await editor.$$eval("#editor-param-area input[type=range]",
		(els) => Number(els[2].value));
	assert(wordnum === 6, "タッチでプリセットが適用されない: " + wordnum);

	// ×のタップで閉じられること(Esc の使えないスマホでの主な閉じ方)
	const close = await editor.locator("#btn-settings-close").boundingBox();
	assert(close.width >= 20 && close.height >= 20,
		`×がタッチには小さい: ${close.width}x${close.height}`);
	await editor.touchscreen.tap(close.x + close.width / 2, close.y + close.height / 2);
	await editor.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor touch test passed");
	exitCode = 0;
	await browser.close();
} catch (err) {
	console.error("[FAIL]", err.message);
} finally {
	try {
		process.kill(-preview.pid);
	} catch {}
	process.exit(exitCode);
}
