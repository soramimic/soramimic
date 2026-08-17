// 編集ツールの「変換のしかた」モーダル(ツールバーの⚙から開く)のE2E: 生成画面へ戻らずに
// 変換パラメータ・単語重複・ファセット絞り込みを変えて再変換できること、
// 再変換が「戻る」1回で取り消せること、位置別重み(weightsList)が
// エンジンまで届くことを確認する。
// 実行: npm run build && node tests/editor-settings.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 4499;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";

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

// 編集画面の sessionStorage に入っている編集データ(= 親ページが拾う正)
const readData = (page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), EDITOR_KEY);

const wordsOf = (page) =>
	page.$$eval(".chip-word-surface", (els) => els.map((e) => e.textContent).join("|"));

const sliderValues = (page) =>
	page.$$eval("#editor-param-area input[type=range]", (els) => els.map((e) => Number(e.value)));

const activePreset = (page) =>
	page.$eval("#editor-preset-buttons", (el) => {
		const b = el.querySelector("button.active");
		return b ? b.textContent : null;
	});

// 候補チップの表記(同名グループの「×N」は落とす)
const candidateSurfaces = (page) =>
	page.$$eval(".panel-candidates .candidate .candidate-surface",
		(els) => els.map((e) => e.textContent.replace(/×\d+$/, "")));

// 再変換(手動・ファセット由来とも)が終わるまで待つ。
// 進捗はモーダルの外(ツールバー)に出るので、モーダルの開閉によらず見える
function waitIdle(page) {
	return page.waitForFunction(() => {
		const btn = document.getElementById("btn-reconvert");
		return btn && !btn.disabled && document.getElementById("reconvert-progress").hidden;
	}, undefined, { timeout: 180000 });
}

// ⚙でモーダルを開く(既に開いていれば何もしない)
async function openSettings(page) {
	const open = await page.$eval("#editor-settings", (d) => d.open);
	if (!open) await page.click("#btn-settings");
	await page.waitForFunction(() => document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
}

const settingsOpen = (page) => page.$eval("#editor-settings", (d) => d.open);

const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
	stdio: "ignore",
	detached: true,
});

let exitCode = 1;
try {
	await waitForServer(`${BASE}/`);
	const browser = await chromium.launch();
	const context = await browser.newContext();
	// 外部リクエスト(読みAPI・GA等)を遮断し、kuromojiの決定的なトークナイズに固定
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e));

	// 絞り込みの検証用に、単語リストの「登録名」だけの表記集合を作っておく
	const csv = await (await fetch(`${BASE}/wordlists/baseball.csv`)).text();
	const rows = csv.split(/\r\n|\n|\r/);
	const header = rows[0].split(",");
	const iSurface = header.indexOf("surface");
	const iType = header.indexOf("type");
	const registeredSurfaces = new Set(
		rows.slice(1).map((r) => r.split(","))
			.filter((r) => r[iType] === "registered")
			.map((r) => r[iSurface]));
	assert(registeredSurfaces.size > 0, "登録名の単語が見つからない(テストデータ不備)");

	// ---- 生成画面: 変換して編集ツールを開く(既定は野球選手リスト) ----
	await page.goto(`${BASE}/`);
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	await page.fill("#input-text", "夢は今もめぐりて\n忘れがたきふるさと");
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
	const warnings = [];
	editor.on("console", (m) => {
		if (m.type() === "warning") warnings.push(m.text());
	});

	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 60000 });
	await editor.waitForFunction(
		() => !document.getElementById("btn-reconvert").disabled,
		{ timeout: 120000 },
	);

	// ---- ⚙でモーダルが開く ----
	assert(!(await settingsOpen(editor)), "初期状態でモーダルが開いている");
	await openSettings(editor);
	await editor.waitForSelector("#editor-param-area input[type=range]", { timeout: 10000 });

	// Escで閉じ、⚙で開き直せる(生成画面のダイアログと同じ操作)
	await editor.keyboard.press("Escape");
	await editor.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await openSettings(editor);
	// ×でも閉じられる
	await editor.click("#btn-settings-close");
	await editor.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await openSettings(editor);

	// ---- 初期値: 引き継いだ data.param から逆算されていること ----
	const initialValues = await sliderValues(editor);
	const initialData = await readData(editor);
	assert(initialValues[0] === initialData.param.VOWEL_RATIO,
		`音の合わせ方の初期値がparamと違う: ${initialValues[0]} vs ${initialData.param.VOWEL_RATIO}`);
	assert(initialValues[1] * 20 === initialData.param.MID_PHRASE_BREAK_PENALTY,
		`文節の初期値がparamと違う: ${initialValues[1]}`);
	assert(initialValues[2] * 10 === initialData.param.WORD_NUMBER_PENALTY,
		`単語の長さの初期値がparamと違う: ${initialValues[2]}`);
	assert(await activePreset(editor) === "バランス",
		"生成画面の既定(バランス)がプリセットに反映されていない");
	const editorSelectAll = editor.getByRole("checkbox", { name: "種類をすべて選択" });
	assert(await editorSelectAll.evaluate((el) => el.indeterminate),
		"生成時の部分選択を復元しても、すべて選択が中間状態にならない");

	// ---- パラメータ変更 → 再変換で結果が変わる ----
	const wordsBefore = await wordsOf(editor);
	await editor.click("#editor-preset-buttons button:has-text('長い単語')");
	assert((await sliderValues(editor))[2] === 6, "プリセットでスライダーが動いていない");
	await editor.click("#btn-reconvert");
	// 押したらモーダルは閉じ、進捗はツールバー側(モーダルの外)で見える
	await editor.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	assert(await editor.isVisible("#reconvert-progress"),
		"再変換の進捗がツールバーに出ていない");
	await waitIdle(editor);
	const afterParam = await readData(editor);
	assert(afterParam.param.WORD_NUMBER_PENALTY === 60,
		"再変換後のparamが保存されていない: " + JSON.stringify(afterParam.param));
	assert(afterParam.param.OUTPUT_FORMAT === initialData.param.OUTPUT_FORMAT,
		"再変換でパネル外のパラメータ(OUTPUT_FORMAT)が失われた");
	const wordsLongWord = await wordsOf(editor);
	assert(wordsLongWord !== wordsBefore,
		"パラメータを変えて再変換したのに結果が同じ: " + wordsLongWord);

	// ---- 戻る: 再変換前の結果とパラメータに戻る(ダイアログなしの1操作) ----
	await editor.click("#btn-undo");
	await editor.waitForFunction(
		() => !document.getElementById("btn-redo").disabled, { timeout: 10000 });
	assert(await wordsOf(editor) === wordsBefore, "戻るで再変換前の結果に戻らない");
	const undone = await readData(editor);
	// 閉じている間の syncSettingsUi が、開き直したときに反映されていること
	assert(!(await settingsOpen(editor)), "再変換でモーダルが閉じたままになっていない");
	await openSettings(editor);
	assert(undone.param.WORD_NUMBER_PENALTY === initialData.param.WORD_NUMBER_PENALTY,
		"戻るでパラメータが元に戻らない: " + JSON.stringify(undone.param));
	assert((await sliderValues(editor))[2] === initialValues[2],
		"戻るでスライダー表示が元に戻らない");
	assert(await activePreset(editor) === "バランス", "戻るでプリセット表示が元に戻らない");

	// ---- 単語重複の切り替え ----
	await editor.click("#editor-duplicate-buttons button[data-value='true']");
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	assert((await readData(editor)).param.DUPLICATE === true,
		"単語重複ありが再変換のパラメータに反映されていない");
	await openSettings(editor);
	await editor.click("#editor-duplicate-buttons button[data-value='false']");

	// ---- ファセット絞り込み: 候補が絞られる ----
	// モーダルを閉じないと本文のチップは押せない(モーダルダイアログのため)
	await editor.click("#btn-settings-close");
	await editor.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await editor.locator(".editor-line[data-line='0'] .chip-unit").first().click();
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	const candBefore = await candidateSurfaces(editor);
	assert(candBefore.some((s) => !registeredSurfaces.has(s)),
		"絞り込み前から登録名だけの候補になっている(前提が崩れている)");

	// 「名字」「フルネーム」を外して「登録名」だけにする(変更即再変換)。
	// 絞り込みはモーダルを開いたまま走らせてよい(進捗はツールバー側に出る)
	await openSettings(editor);
	await editor.uncheck("#editor-facets input[value='family']");
	await editor.uncheck("#editor-facets input[value='full']");
	await editor.waitForFunction((k) => {
		const d = JSON.parse(sessionStorage.getItem(k));
		return d && d.where === "((type=registered))";
	}, EDITOR_KEY, { timeout: 180000 });
	await waitIdle(editor);
	// 選択即再変換ではモーダルは開いたまま(設定を続けて変えられる)
	assert(await settingsOpen(editor), "絞り込みの再変換でモーダルが閉じてしまった");
	await editor.click("#btn-settings-close");

	await editor.locator(".editor-line[data-line='0'] .chip-unit").first().click();
	await editor.waitForSelector(".panel-candidates .candidate", { timeout: 30000 });
	const candAfter = await candidateSurfaces(editor);
	assert(candAfter.length > 0, "絞り込み後に候補が出ない");
	const leaked = candAfter.filter((s) => !registeredSurfaces.has(s));
	assert(leaked.length === 0, "絞り込み後も対象外の候補が出ている: " + leaked.slice(0, 5).join(","));

	// 固定した単語は絞り込みの対象外になっても残る
	await editor.click(".panel-candidates .candidate");
	await editor.click(".panel-candidate-apply");
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	const lockedSurface = await editor.textContent(".chip-word.locked .chip-word-surface");
	await openSettings(editor);
	await editor.check("#editor-facets input[value='family']");
	await editor.waitForFunction((k) => {
		const d = JSON.parse(sessionStorage.getItem(k));
		return d && d.where !== "((type=registered))";
	}, EDITOR_KEY, { timeout: 180000 });
	await waitIdle(editor);
	await editor.click("#btn-settings-close");
	const lockedAfter = await editor.$$eval(".chip-word.locked .chip-word-surface",
		(els) => els.map((e) => e.textContent));
	assert(lockedAfter.includes(lockedSurface),
		`絞り込みの変更で固定単語が失われた: ${lockedSurface}`);

	// ---- ノート長α: 生重みからsoramimic側で導出し、設定・候補・書き出しへ通す ----
	// 行0だけ不正な生重み(-1)、行1は正常にして、導出した重みがエンジンまで届くことを
	// 行番号つきの検証警告で確認する。
	await editor.evaluate((k) => {
		const d = JSON.parse(sessionStorage.getItem(k));
		d.noteLengthRawList =
			d.unitsList.map((units, line) => units.map(() => (line === 0 ? -1 : 1)));
		d.noteLengthAlpha = 0.25;
		d.history = [];
		d.future = [];
		sessionStorage.setItem(k, JSON.stringify(d));
	}, EDITOR_KEY);
	await editor.reload();
	await editor.waitForFunction(
		() => !document.getElementById("btn-reconvert").disabled, { timeout: 120000 });
	await openSettings(editor);
	assert(await editor.isVisible("#editor-note-length-field"),
		"生重みがあるのにノート長設定が表示されない");
	assert(await editor.inputValue("#editor-note-length-alpha") === "0.25",
		"ノート長αの初期値が復元されていない");
	await editor.fill("#editor-note-length-alpha", "1");
	warnings.length = 0;
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	const weighted = await editor.evaluate((k) =>
		JSON.parse(sessionStorage.getItem(k)), EDITOR_KEY);
	assert(weighted.noteLengthAlpha === 1, "変更したノート長αが保存されていない");
	assert(warnings.some((w) => w.includes("重みに非負の有限数でない値") && w.includes("行0")),
		"再変換で導出したノート長重みがエンジンに届いていない: " + warnings.join(" / "));
	assert(!warnings.some((w) => w.includes("行1")),
		"正しいノート長重みなのに行1で警告が出た: " + warnings.join(" / "));

	// 候補計算(getCandidates)にも選択範囲ぶんの導出重みが渡ること
	warnings.length = 0;
	await editor.locator(".editor-line[data-line='0'] .chip-unit").first().click();
	await editor.waitForSelector(".panel-candidates, .panel-note", { timeout: 30000 });
	assert(warnings.some((w) => w.includes("getCandidates")),
		"候補計算にノート長重みが届いていない: " + warnings.join(" / "));

	// ---- 書き出し: 生重みとαがラウンドトリップで消えない ----
	const [download] = await Promise.all([
		editor.waitForEvent("download"),
		editor.click("#btn-export"),
	]);
	const exported = JSON.parse(await readFile(await download.path(), "utf8"));
	assert(Array.isArray(exported.noteLengthRawList)
		&& exported.noteLengthRawList[0][0] === -1,
		"書き出しJSONにnoteLengthRawListが含まれていない");
	assert(exported.noteLengthAlpha === 1,
		"書き出しJSONにnoteLengthAlphaが含まれていない");
	assert(Array.isArray(exported.weightsList) && exported.weightsList[0][0] === -1,
		"旧版互換weightsListが現在のαで書き出されていない");
	assert(exported.param && typeof exported.where === "string",
		"書き出しJSONに param/where が含まれていない");

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor settings test passed");
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
