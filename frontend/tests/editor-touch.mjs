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
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
			"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
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

	// iPhoneでも「読みを修正」を開くと入力欄へ自動フォーカスする。
	// 実機ではvisualViewportに合わせて専用小窓を持ち上げ、入力欄への重なりを防ぐ。
	await editor.locator(".chip-unit", { hasText: "コ" }).first().tap();
	await editor.waitForSelector(".editor-panel.open .panel-yomi-toggle", { timeout: 10000 });
	const selectedBeforeReadingDialog = await editor.$$eval(".chip-unit.selected",
		(els) => els.map((e) => e.textContent).join(""));
	await editor.locator(".panel-yomi-toggle").tap();
	assert(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open) &&
		await editor.locator(".panel-yomi .input").isVisible(),
		"読み修正専用の小窓が表示されない");
	assert(await editor.evaluate(() => document.activeElement?.matches(".panel-yomi .input")),
		"iPhoneで読み修正を開いても入力欄へ自動フォーカスされない");
	const panelViewportPosition = await editor.evaluate(() => {
		const viewport = window.visualViewport;
		const expected = Math.max(
			0, window.innerHeight - viewport.height - viewport.offsetTop);
		return {
			actual: document.getElementById("editor-reading-dialog").style.bottom,
			expected: `${expected}px`,
		};
	});
	assert(panelViewportPosition.actual === panelViewportPosition.expected,
		"iPhoneの表示領域に合わせてパネル位置が調整されない: " +
		JSON.stringify(panelViewportPosition));
	// 入力から文字対応へ触れた時も、blurでiOS用の位置追従を早期解除せず、
	// detailsの高さ変化でdialogの上端が跳ねない。
	const readingDialogTop = await editor.locator("#editor-reading-dialog").evaluate(
		(el) => el.getBoundingClientRect().top);
	assert(!(await editor.locator("#reading-fix-align-details").evaluate((el) => el.open)),
		"文字ごとの対応調整が初期状態で閉じていない");
	await editor.locator("#reading-fix-align-details > summary").tap();
	const readingDialogAfterAlign = await editor.locator("#editor-reading-dialog").evaluate((el) => ({
		top: el.getBoundingClientRect().top,
		bottomStyle: el.style.bottom,
		alignVisible: !!el.querySelector(".panel-align")?.getClientRects().length,
	}));
	assert(Math.abs(readingDialogAfterAlign.top - readingDialogTop) < 2 &&
		readingDialogAfterAlign.bottomStyle === panelViewportPosition.expected &&
		readingDialogAfterAlign.alignVisible,
		"文字対応の開閉で読み修正小窓がずれた: " + JSON.stringify({
			beforeTop: readingDialogTop, after: readingDialogAfterAlign,
		}));
	await editor.locator("#btn-reading-fix-cancel").tap();
	assert(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open")) &&
		await editor.$$eval(".chip-unit.selected",
			(els) => els.map((e) => e.textContent).join("")) === selectedBeforeReadingDialog,
		"読み修正のキャンセルで背後の候補選択が変わった");

	// 適用で閉じたタップが背後の鉛筆へ遅れて届いても、dialogを開き直さない。
	await editor.locator(".panel-yomi-toggle").tap();
	await editor.locator("#btn-reading-fix-apply").tap();
	await editor.waitForTimeout(500);
	assert(!(await editor.locator("#editor-reading-dialog").evaluate((d) => d.open)) &&
		!(await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open"))) &&
		await editor.locator(".chip-unit.selected").count() === 0,
		"変更適用後の遅延タップで読み修正小窓が開き直した");

	// 後続のパネル閉じる操作のため、通常のタップが再び有効になってから選び直す。
	await editor.locator(".chip-unit", { hasText: "コ" }).first().tap();
	await editor.waitForSelector(".editor-panel.open", { timeout: 10000 });
	await editor.locator(".panel-close").tap();
	await editor.waitForFunction(() =>
		!document.getElementById("editor-panel").classList.contains("open"));

	// 固定アイコンは3行目を増やさず、指で直接切り替えられる大きさにする
	const firstLock = editor.locator(".chip-word:not(.filler) .chip-lock").first();
	const lockBox = await firstLock.boundingBox();
	assert(lockBox && lockBox.width >= 28 && lockBox.height >= 28,
		`固定アイコンがタッチには小さい: ${lockBox?.width}x${lockBox?.height}`);
	const lockInput = firstLock.locator(".chip-lock-input");
	const initiallyLocked = await lockInput.isChecked();
	await editor.touchscreen.tap(lockBox.x + lockBox.width / 2, lockBox.y + lockBox.height / 2);
	await editor.waitForFunction((expected) =>
		document.querySelector(".chip-word:not(.filler) .chip-lock-input")?.checked === expected,
		!initiallyLocked, { timeout: 5000 });
	assert(!await editor.locator("#editor-panel").evaluate((el) => el.classList.contains("open")),
		"固定アイコンのタップで候補パネルが開いた");
	const toggledLock = await editor.locator(".chip-word:not(.filler) .chip-lock").first().boundingBox();
	await editor.touchscreen.tap(
		toggledLock.x + toggledLock.width / 2,
		toggledLock.y + toggledLock.height / 2,
	); // 初期状態へ戻す

	// ユニットチップの中心座標(再描画で要素が入れ替わるため毎回取り直す)
	async function unitCenter(i) {
		const box = await editor.locator(".chip-unit").nth(i).boundingBox();
		assert(box, `ユニット${i}が見つからない`);
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}

	async function selTitle() {
		return editor.evaluate(() => {
			const panel = document.getElementById("editor-panel");
			const surface = panel.querySelector(".panel-original-surface");
			const reading = panel.querySelector(".panel-original-reading");
			return panel.classList.contains("open") && surface && reading
				? `${surface.textContent}(${reading.textContent})` : "(選択なし)";
		});
	}

	// タップ後の選択状態を条件待ちで検証する。固定waitだと遅いCIランナーで
	// 描画が間に合わずフレークするため、期待状態になるまで待つ
	async function tapAndExpect(unitIndex, expected, label) {
		await editor.touchscreen.tap(...Object.values(await unitCenter(unitIndex)));
		try {
			await editor.waitForFunction((exp) => {
				const panel = document.getElementById("editor-panel");
				const surface = panel.querySelector(".panel-original-surface");
				const reading = panel.querySelector(".panel-original-reading");
				const title = panel.classList.contains("open") && surface && reading
					? `${surface.textContent}(${reading.textContent})` : "(選択なし)";
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
	await tapAndExpect(0, "忘(", "タップで新規選択されない");
	await tapAndExpect(1, "ワス", "隣接タップで拡張されない");
	await tapAndExpect(1, "忘(", "端タップで縮小されない");
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
			const t = document.querySelector("#editor-panel.open .panel-original-reading");
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

	// ---- 自由入力から候補選択へは、キーボード表示中でも1タップで戻れる ----
	await editor.locator(".panel-free-toggle").tap();
	assert(await editor.locator(".panel-candidates").count() === 0,
		"自由入力中にも候補一覧が表示されている");
	await editor.fill(".panel-free-surface", "仮入力");
	const freeBack = await editor.locator(".panel-free-back").boundingBox();
	await editor.touchscreen.tap(
		freeBack.x + freeBack.width / 2,
		freeBack.y + freeBack.height / 2,
	);
	assert(await editor.locator(".panel-free").count() === 0 &&
		await editor.locator(".panel-candidates").count() === 1,
		"候補選択へ戻るボタンの1回のタップで候補一覧へ戻らない");

	// ---- タップで候補を選び、明示確定で差し替えられること ----
	// ×N付き(同名グループ)は個別選択リストが開くため、単独候補を選ぶ
	const single = editor.locator(".panel-candidates .candidate:not(:has(.candidate-count))").first();
	const candSurface = await single.locator(".candidate-surface").textContent();
	const cand2 = await single.boundingBox();
	await editor.touchscreen.tap(cand2.x + 10, cand2.y + 10);
	await editor.waitForSelector(".panel-candidate-apply", { timeout: 10000 });
	assert(await editor.locator(".chip-word.locked").count() === lockedBefore,
		"候補タップだけで差し替えが確定した");
	const panelFits = await editor.locator("#editor-panel").evaluate((panel) =>
		panel.scrollWidth <= panel.clientWidth);
	assert(panelFits, "狭い画面で差し替えパネルが横にはみ出した");
	await editor.locator(".panel-draft-reading").tap();
	const draftViewportPosition = await editor.evaluate(() => {
		const viewport = window.visualViewport;
		const expected = Math.max(
			0, window.innerHeight - viewport.height - viewport.offsetTop);
		return {
			actual: document.getElementById("editor-panel").style.bottom,
			expected: `${expected}px`,
		};
	});
	assert(draftViewportPosition.actual === draftViewportPosition.expected,
		"候補読み入力時にiPhoneの表示領域へパネルが追従しない: " +
		JSON.stringify(draftViewportPosition));
	const applyBox = await editor.locator(".panel-candidate-apply").boundingBox();
	assert(applyBox.width >= 28 && applyBox.height >= 28,
		`差し替えボタンがタッチには小さい: ${applyBox.width}x${applyBox.height}`);
	await editor.locator(".panel-candidate-apply").tap();
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
