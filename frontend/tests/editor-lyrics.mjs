// セットアップ画面の「元歌詞(字幕用)」のE2E。
// 埋め込み元(soramimic-video)は元歌詞を字幕に使うので、エディタで入力・確認でき、
// 行ごとの対応づけ(originalLines)まで作って渡す、という契約を実ブラウザで確認する:
//   シードの lyrics が初期表示される → その場で対応づけ(originalLines)が保存される。
//   originalLines は phrases と同じ長さで、対応づかない行は空文字。
//   入力を書き替えると対応づけし直す。曲が変わっても(ホストの応答)対応づけし直す。
//   書き出しJSONにも lyrics / originalLines が載る。
//   ホストも lyrics も無いシード(本家単体)では欄ごと出ない=従来どおり。
// 実行: npm run build && node tests/editor-lyrics.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 4604;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";

const SONGS = [
	{ id: "furusato", title: "ふるさと" },
	{ id: "katatsumuri", title: "かたつむり" },
];
// 3行目は元歌詞に無い行(対応づかない=空文字になる)
const PHRASES = ["夢は今もめぐりて", "忘れがたきふるさと", "ラララ"];
const LYRICS = "夢は今も めぐりて\n忘れがたき ふるさと";
const NEXT_PHRASES = ["でんでんむしむし", "かたつむり"];
const NEXT_LYRICS = "でんでんむしむし かたつむり";

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
const isHidden = (page, sel) => page.isHidden(sel);

// セットアップ画面が操作できる状態(エンジン初期化済み)になるまで待つ
const waitSetupReady = (page) =>
	page.waitForFunction(() => {
		const btn = document.getElementById("btn-setup-convert");
		return btn && !btn.disabled && !document.getElementById("editor-setup").hidden;
	}, undefined, { timeout: 180000 });

// 元歌詞の対応づけは打鍵から少し遅れて走るので、保存された結果を待つ
const waitOriginalLines = (page, expected) =>
	page.waitForFunction((want) => {
		const d = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return d && JSON.stringify(d.originalLines) === want;
	}, JSON.stringify(expected), { timeout: 30000 });

// ホスト役の書き戻し(editor-song.mjs と同じ流儀)
const respondAsHost = (page, mutate) =>
	page.evaluate((src) => {
		const k = "soramimic-editor";
		const d = JSON.parse(sessionStorage.getItem(k));
		new Function("d", src)(d);
		delete d.hostRequest;
		sessionStorage.setItem(k, JSON.stringify(d));
	}, mutate);

const waitIdleSetup = (page) =>
	page.waitForFunction(() => {
		const d = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return d && !d.hostRequest && !document.getElementById("btn-setup-convert").disabled;
	}, undefined, { timeout: 30000 });

async function seed(page, obj) {
	await page.evaluate(([k, v]) => {
		sessionStorage.setItem(k, JSON.stringify(v));
	}, [EDITOR_KEY, obj]);
	await page.reload();
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

	// ---- シードの lyrics が初期表示され、読み込み直後に対応づけまで済む ----
	await page.goto(`${BASE}/editor.html`);
	await seed(page, {
		phrases: PHRASES,
		song: { id: "furusato", title: "ふるさと" },
		host: { songs: SONGS, canUploadSong: true },
		lyrics: LYRICS,
	});
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(!(await isHidden(page, "#setup-lyrics-field")), "元歌詞の欄が出ていない");
	assert(await page.inputValue("#setup-lyrics") === LYRICS,
		"シードの元歌詞が初期表示されていない: " + await page.inputValue("#setup-lyrics"));
	// 曲の下に置く(埋め込み元の並びに合わせる)
	assert(await page.evaluate(() => {
		const song = document.getElementById("setup-song-field");
		const lyrics = document.getElementById("setup-lyrics-field");
		return !!(song.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING);
	}), "元歌詞の欄が曲セクションより上にある");

	await waitOriginalLines(page, ["夢は今も めぐりて", "忘れがたき ふるさと", ""]);
	const seeded = await readData(page);
	assert(seeded.originalLines.length === PHRASES.length,
		"originalLines が phrases と同じ長さでない: " + JSON.stringify(seeded.originalLines));
	assert(seeded.lyrics === LYRICS, "lyrics が保存されていない");
	const status = await page.textContent("#setup-lyrics-status");
	assert(status.includes("2/3"), "対応づけの状態表示が出ていない: " + status);

	// ---- 書き替えると対応づけし直す(元歌詞が空なら originalLines ごと落ちる) ----
	await waitSetupReady(page);
	await page.fill("#setup-lyrics", "忘れがたき ふるさと");
	await waitOriginalLines(page, ["", "忘れがたき ふるさと", ""]);
	assert((await page.textContent("#setup-lyrics-status")).includes("1/3"),
		"書き替えたあとの状態表示が更新されていない");
	await page.fill("#setup-lyrics", "");
	await page.waitForFunction(() => {
		const d = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return d && d.lyrics === "" && !("originalLines" in d);
	}, undefined, { timeout: 30000 });
	assert(await isHidden(page, "#setup-lyrics-status"),
		"元歌詞が空なのに対応づけの表示が残っている");
	await page.fill("#setup-lyrics", LYRICS);
	await waitOriginalLines(page, ["夢は今も めぐりて", "忘れがたき ふるさと", ""]);

	// ---- 曲が変わったら(ホストの応答)新しい phrases で対応づけし直す ----
	await page.click("#setup-song-samples > summary");
	await page.waitForSelector("#setup-song-select", { state: "visible", timeout: 10000 });
	await page.selectOption("#setup-song-select", "katatsumuri");
	await page.waitForFunction(() => {
		const d = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return d && d.hostRequest && d.hostRequest.type === "song";
	}, undefined, { timeout: 30000 });
	// ホストは曲とセットで元歌詞も差し替え、前の曲の originalLines は捨てて寄こす
	await respondAsHost(page, `
		d.phrases = ${JSON.stringify(NEXT_PHRASES)};
		d.song = { id: "katatsumuri", title: "かたつむり" };
		d.lyrics = ${JSON.stringify(NEXT_LYRICS)};
		delete d.originalLines;
		delete d.results; delete d.tokensList; delete d.unitsList;
	`);
	await waitIdleSetup(page);
	assert(await page.inputValue("#setup-lyrics") === NEXT_LYRICS,
		"新しい曲の元歌詞が欄に反映されていない");
	await waitOriginalLines(page, ["でんでんむしむし", "かたつむり"]);
	assert((await page.textContent("#setup-lyrics-status")).includes("2/2"),
		"曲の切替後に対応づけの表示が更新されていない");

	// ---- 変換しても保持され、書き出しJSONにも載る ----
	await waitSetupReady(page);
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".editor-line .chip-word", { timeout: 180000 });
	const converted = await readData(page);
	assert(converted.lyrics === NEXT_LYRICS, "変換で元歌詞が失われた");
	assert(JSON.stringify(converted.originalLines)
		=== JSON.stringify(["でんでんむしむし", "かたつむり"]),
		"変換で originalLines が失われた: " + JSON.stringify(converted.originalLines));
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.click("#btn-export"),
	]);
	const exported = JSON.parse(await readFile(await download.path(), "utf8"));
	assert(exported.lyrics === NEXT_LYRICS, "書き出しJSONに元歌詞が入っていない");
	assert(Array.isArray(exported.originalLines)
		&& exported.originalLines.length === exported.phrases.length,
		"書き出しJSONの originalLines が phrases と同じ長さでない: "
		+ JSON.stringify(exported.originalLines));

	// ---- ホストも lyrics も無いシード(本家単体)では欄ごと出ない ----
	await seed(page, { phrases: PHRASES, song: { title: "ふるさと" } });
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(await isHidden(page, "#setup-lyrics-field"),
		"ホストも元歌詞も無いのに元歌詞の欄が出ている");
	assert(!("originalLines" in await readData(page)),
		"元歌詞が無いのに originalLines が書かれている");

	// ---- lyrics だけ渡された(ホスト無し)ときも従来の欄として使える ----
	await seed(page, { phrases: PHRASES, lyrics: LYRICS });
	await page.waitForSelector("#setup-lyrics-field:not([hidden])", { timeout: 30000 });
	await waitOriginalLines(page, ["夢は今も めぐりて", "忘れがたき ふるさと", ""]);

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor lyrics test passed");
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
