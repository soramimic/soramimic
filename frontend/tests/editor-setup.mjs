// セットアップ画面(第1ステップ)のE2E。
// エディタがゼロから変換するのに要るのは phrases(行ごとの歌詞)だけ、という契約を
// 実ブラウザで確認する:
//   results 無しのシード → セットアップ画面から始まり、設定を変えて
//   「この設定で変換」すると tokensList/unitsList/results が作られて編集画面に入る。
//   results ありのシード → 従来どおり編集画面から(後方互換)。
//   setupFirst:true → results があってもセットアップ画面から始まり、離脱もできる。
// 実行: npm run build && node tests/editor-setup.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4602;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";

// ホスト(soramimic-video等)が渡すのと同じ形のシード: 歌詞の行だけ
const PHRASES = ["夢は今もめぐりて", "忘れがたきふるさと"];
const SONG_TITLE = "ふるさと";

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

const wordsOf = (page) =>
	page.$$eval(".chip-word-surface", (els) => els.map((e) => e.textContent).join("|"));

// hidden属性だけでなく、CSSのdisplay指定で見えてしまっていないかまで見る
const isHidden = (page, sel) => page.isHidden(sel);

// セットアップ画面が操作できる状態(エンジン初期化済み)になるまで待つ
const waitSetupReady = (page) =>
	page.waitForFunction(() => {
		const btn = document.getElementById("btn-setup-convert");
		return btn && !btn.disabled && !document.getElementById("editor-setup").hidden;
	}, undefined, { timeout: 180000 });

// 編集画面(結果表示)に入るまで待つ
const waitEditor = (page) =>
	page.waitForSelector(".editor-line .chip-word", { timeout: 180000 });

function waitIdle(page) {
	return page.waitForFunction(() => {
		const btn = document.getElementById("btn-reconvert");
		return btn && !btn.disabled && document.getElementById("reconvert-progress").hidden;
	}, undefined, { timeout: 180000 });
}

// sessionStorage にシードを書いてから editor.html を開き直す
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

	// ---- 未変換シード(phrasesだけ)→ セットアップ画面から始まる ----
	await page.goto(`${BASE}/editor.html`);
	await seed(page, { phrases: PHRASES, song: { title: SONG_TITLE } });

	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(await isHidden(page, "#editor-toolbar"), "セットアップ中にツールバーが出ている");
	assert(await isHidden(page, "#editor-lines"), "セットアップ中に編集画面が出ている");
	assert(await isHidden(page, "#editor-empty"), "セットアップ画面なのに空表示が出ている");
	assert(await isHidden(page, "#btn-setup-back"),
		"未変換なのに編集画面へ戻れてしまう(変換だけが出口のはず)");
	assert(await page.textContent("#setup-song-title") === SONG_TITLE,
		"曲名が表示されていない");

	// 設定UI(⚙モーダルと同じ実体)がセットアップ画面の中に来ていること
	assert(await page.$eval("#editor-settings-body",
		(el) => !!el.closest("#editor-setup")),
		"設定UIがセットアップ画面に入っていない");
	await waitSetupReady(page);
	await page.waitForSelector("#editor-wordlist-field:not([hidden])", { timeout: 30000 });
	// 単語リスト未指定なので、生成画面と同じ既定(conf の active)が選ばれる
	assert(await page.$eval("#editor-wordlist", (el) => el.value) === "BASEBALL",
		"単語リストの既定が選ばれていない");

	// ---- 設定(単語リスト・パラメータ)を変えて「この設定で変換」 ----
	await page.selectOption("#editor-wordlist", "STATION");
	await page.click("#editor-preset-buttons button:has-text('長い単語')");
	await page.click("#btn-setup-convert");
	assert(await page.isVisible("#setup-progress"), "変換の進捗が出ていない");
	await waitEditor(page);

	assert(await isHidden(page, "#editor-setup"), "変換後もセットアップ画面が残っている");
	assert(!(await isHidden(page, "#editor-toolbar")), "変換後にツールバーが出ていない");
	// 設定UIは⚙モーダルの中へ戻る
	assert(await page.$eval("#editor-settings-body",
		(el) => !!el.closest("#editor-settings")),
		"設定UIが⚙モーダルに戻っていない");

	const afterConvert = await readData(page);
	assert(afterConvert.results.length === PHRASES.length,
		"resultsの行数がphrasesと合わない: " + afterConvert.results.length);
	assert(afterConvert.tokensList.length === PHRASES.length, "tokensListが作られていない");
	assert(afterConvert.unitsList.length === PHRASES.length, "unitsListが作られていない");
	assert(afterConvert.unitsList[0].every(
		(u) => typeof u.pronunciation === "string" && typeof u.surface_form === "string"
			&& u.phrase !== undefined),
		"unitsListの形が生成画面からの受け渡しと違う");
	assert(afterConvert.results.some((line) => line.length > 0), "変換結果が空");
	assert(afterConvert.wordlist.value === "STATION",
		"選んだ単語リストが使われていない: " + afterConvert.wordlist.value);
	assert(afterConvert.param.WORD_NUMBER_PENALTY === 60,
		"選んだパラメータが使われていない: " + JSON.stringify(afterConvert.param));
	assert(!("setupFirst" in afterConvert), "変換後も setupFirst が残っている");
	const wordsFirst = await wordsOf(page);
	assert(wordsFirst.length > 0, "替え歌単語が表示されていない");

	// ---- 変換後: ⚙モーダルと再変換が従来どおり効く ----
	await page.click("#btn-settings");
	await page.waitForFunction(() => document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
	await page.click("#editor-preset-buttons button:has-text('音そっくり')");
	await page.click("#btn-reconvert");
	await waitIdle(page);
	const afterReconvert = await readData(page);
	assert(afterReconvert.param.WORD_NUMBER_PENALTY === 0,
		"⚙からの再変換でパラメータが反映されていない");
	assert(await wordsOf(page) !== wordsFirst, "再変換したのに結果が同じ");
	// 「固定以外を再生成」も使える
	await page.click("#btn-regenerate");
	await page.waitForFunction(() => document.getElementById("regen-progress").hidden,
		undefined, { timeout: 180000 });

	// ---- 変換済みシード → 従来どおり編集画面から始まる(後方互換) ----
	await page.reload();
	await waitEditor(page);
	assert(await isHidden(page, "#editor-setup"),
		"results があるのにセットアップ画面が出た(後方互換が壊れている)");
	const wordsReloaded = await wordsOf(page);

	// ---- setupFirst:true → results があってもセットアップ画面から ----
	await page.evaluate((k) => {
		const d = JSON.parse(sessionStorage.getItem(k));
		d.setupFirst = true;
		sessionStorage.setItem(k, JSON.stringify(d));
	}, EDITOR_KEY);
	await page.reload();
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(!(await isHidden(page, "#btn-setup-back")),
		"変換済みなのに編集画面へ戻る手段がない");
	await waitSetupReady(page);
	// 変換せずに離脱でき、結果はそのまま
	await page.click("#btn-setup-back");
	await waitEditor(page);
	assert(await isHidden(page, "#editor-setup"), "戻るでセットアップ画面が閉じない");
	assert(await wordsOf(page) === wordsReloaded, "離脱で結果が変わった");
	assert(!("setupFirst" in await readData(page)),
		"離脱後も setupFirst が残っている(リロードでまたセットアップに戻ってしまう)");

	// ---- ホストが渡した絞り込み(トップレベルwhere)がそのまま効く ----
	// soramimic-video のような生成側は、conf のファセット既定から where を組んで
	// シードに載せてくる。その式は facetClause + compileWhere と同じ形なので、
	// restoreFacets がチェック状態を復元でき、「この設定で変換」で組み直しても
	// 同じ条件に戻る。ここが崩れると、渡した絞り込みが黙って消えて(=条件が
	// 広がって)ホスト側の出力と食い違う。
	const conf = await (await fetch(`${BASE}/conf/setting.json`)).json();
	const baseball = conf.wordlist.find((w) => w.value === "BASEBALL");
	assert(baseball && baseball.facets, "confに野球選手のファセットが無い");
	const checkedValues = (p) =>
		p.$$eval("#editor-facets input[type=checkbox]",
			(els) => els.filter((e) => e.checked).map((e) => e.value).join(","));

	// 既定どおりの絞り込み(ホストが何も触らずに送ってくる式)
	await seed(page, {
		phrases: PHRASES,
		wordlist: baseball,
		where: "((type=family) or (type=full) or (type=registered))",
	});
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	await waitSetupReady(page);
	await page.waitForSelector("#editor-facet-field:not([hidden])", { timeout: 30000 });
	assert(await checkedValues(page) === "family,full,registered",
		"既定の絞り込みが復元されていない: " + await checkedValues(page));

	// 既定と違う絞り込み(ホスト側で絞り込み直した状態)
	const HOST_WHERE = "((type=nick))";
	await seed(page, { phrases: PHRASES, wordlist: baseball, where: HOST_WHERE });
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	await waitSetupReady(page);
	await page.waitForSelector("#editor-facet-field:not([hidden])", { timeout: 30000 });
	assert(await checkedValues(page) === "nick",
		"渡した絞り込みが復元されていない: " + await checkedValues(page));
	await page.click("#btn-setup-convert");
	await waitEditor(page);
	const afterFiltered = await readData(page);
	assert(afterFiltered.where === HOST_WHERE,
		"変換で絞り込みが変わった: " + JSON.stringify(afterFiltered.where));

	// ---- 壊れたシード(phrasesもresultsも無い)は従来どおり空表示 ----
	await seed(page, { param: {} });
	await page.waitForSelector("#editor-empty:not([hidden])", { timeout: 30000 });
	assert(await isHidden(page, "#editor-setup"),
		"phrasesが無いのにセットアップ画面が出た");

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor setup test passed");
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
