// filler(万能候補)のE2E(#128)。
// 語数の少ない自作リストで再変換すると、置ける単語が無い区間は「元歌詞のまま」の
// filler チップ(破線)になり、行が空にならないこと。filler をタップすれば通常どおり
// 候補パネルが開き、実単語に差し替えると filler ではなくなることを確認する。
// 実行: npm run build && node tests/editor-filler.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4601;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";

// 歌詞「夢は今もめぐりて」(ユメワイマモメグリテ=10ユニット)に対し、
// 先頭3ユニットと1モーラ分しか埋められない自作リスト。残りは filler になる。
// 1モーラの語を入れてあるので、filler をタップしたときに候補が出る
const ORIGINAL_PLAIN = [
	"# filler テスト用(わざと語数を減らしたリスト)",
	"ユメワ",
	"モ",
	"ミ",
].join("\n");

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

const readData = (page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), EDITOR_KEY);

const CANDIDATE = "#editor-panel.open .panel-candidates .candidate";

function waitIdle(page) {
	return page.waitForFunction(() => {
		const btn = document.getElementById("btn-reconvert");
		return btn && !btn.disabled && document.getElementById("reconvert-progress").hidden;
	}, undefined, { timeout: 180000 });
}

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

	// ---- 生成画面で変換して編集ツールを開く ----
	await page.goto(`${BASE}/`);
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	await page.fill("#input-text", "夢は今もめぐりて");
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
		() => !document.getElementById("btn-reconvert").disabled, { timeout: 120000 });

	// ---- 語数の少ない自作リストで再変換する ----
	await editor.click("#btn-settings");
	await editor.waitForFunction(() => document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await editor.selectOption("#editor-wordlist", "ORIGINAL");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	await editor.fill("#editor-original-text", ORIGINAL_PLAIN);
	await editor.click("#btn-original-register");
	await editor.click("#btn-reconvert");
	await waitIdle(editor);

	// ---- 空行にならず、埋まらない区間が filler になっている ----
	const data = await readData(editor);
	assert(data.results.every((line) => line && line.length > 0),
		"単語が足りないのに空の行がある");
	const line0 = data.results[0];
	const units = data.unitsList[0].map((u) => u.pronunciation);
	const fillers = line0.filter((w) => w.filler);
	assert(fillers.length > 0, "fillerが1つも出ていない: " + JSON.stringify(line0));
	assert(line0.some((w) => !w.filler), "実単語が1つも置かれていない");
	// 行が隙間なく覆われ、fillerは1文字単位で元歌詞のかなそのまま
	let cursor = 0;
	for (const w of line0) {
		assert(w.period[0] === cursor, "periodが連続していない: " + JSON.stringify(line0));
		cursor = w.period[1];
	}
	assert(cursor === units.length, "行末まで覆われていない");
	for (const f of fillers) {
		const expected = units.slice(f.period[0], f.period[1]).join("");
		assert(f.surface === expected && f.kana === expected,
			`fillerの表記が元歌詞のかなと違う: ${f.surface} != ${expected}`);
		assert(!f.id, "fillerがidを持っている");
	}

	// ---- 表示: 破線の控えめなチップ・🔒は出さない ----
	const fillerChips = editor.locator(".editor-line[data-line='0'] .chip-word.filler");
	assert(await fillerChips.count() === fillers.length,
		"fillerチップの数が結果と一致しない");
	// 候補差し替えの検証には、1モーラ語しかないテスト用リストに合わせて
	// 1ユニットのfillerを選ぶ（複数ユニット漢字のfiller表示は上で検証済み）。
	const replaceIndex = fillers.findIndex((f) => f.period[1] - f.period[0] === 1);
	assert(replaceIndex >= 0, "差し替え可能な1ユニットfillerがない");
	const replaceFiller = fillers[replaceIndex];
	const replaceChip = fillerChips.nth(replaceIndex);
	const style = await replaceChip.evaluate((el) => {
		const s = getComputedStyle(el);
		return { borderStyle: s.borderTopStyle, text: el.textContent, locks: el.querySelectorAll(".chip-lock").length };
	});
	assert(style.borderStyle === "dashed", "fillerチップが破線になっていない: " + style.borderStyle);
	assert(style.locks === 0, "fillerチップに🔒が出ている");
	assert(style.text === replaceFiller.surface,
		`fillerチップの文字が元歌詞のかなでない: ${style.text} != ${replaceFiller.surface}`);

	// ---- タップすると候補パネルが開き、実単語に差し替えられる ----
	await replaceChip.click();
	await editor.waitForSelector(CANDIDATE, { timeout: 30000 });
	const candCount = await editor.locator(CANDIDATE).count();
	assert(candCount > 0, "fillerをタップしても候補が出ない");
	const picked = await editor.locator(CANDIDATE + " .candidate-surface").first()
		.evaluate((el) => el.textContent.replace(/×\d+$/, ""));
	await editor.locator(CANDIDATE).first().click();
	await editor.waitForSelector(".editor-line[data-line='0'] .chip-word.locked", { timeout: 10000 });

	const after = await readData(editor);
	const replaced = after.results[0].find(
		(w) => w.period[0] === replaceFiller.period[0]
			&& w.period[1] === replaceFiller.period[1]);
	assert(replaced, "差し替えた区間の単語が見つからない");
	assert(!replaced.filler, "差し替えてもfillerのままになっている");
	assert(replaced.surface === picked,
		`差し替えた単語が候補と違う: ${replaced.surface} != ${picked}`);
	assert(after.results[0].filter((w) => w.filler).length === fillers.length - 1,
		"差し替えでfillerが1つ減っていない");
	assert(await editor.locator(".editor-line[data-line='0'] .chip-word.filler").count()
		=== fillers.length - 1, "表示上のfillerチップが減っていない");

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log(`[ok] editor filler test passed (filler ${fillers.length}件 → ${picked} に差し替え)`);
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
