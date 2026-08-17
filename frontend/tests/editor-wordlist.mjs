// 編集ツールの⚙モーダルにある「単語リスト」選択のE2E。
// 生成画面に戻らずカタログのリストを切り替えられること、切替時は固定(🔒)が
// 解除されて全行が新リストで作り直され、戻る1回で完全に元へ戻ること、
// 自作リストをその場で書いて使えること、書き出しJSONが自作リストごと
// 自己完結する(csvText契約)ことを確認する。
// 実行: npm run build && node tests/editor-wordlist.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";
const ORIGINAL_KEY = "originalWordlist"; // appCore.js の ORIGINAL_STORAGE_KEY

// 自作リスト(plain形式)。歌詞「夢は今もめぐりて」(ユメワイマモメグリテ)を
// 埋められる読みだけを並べ、カタログのどのリストにも無い表記にしてある
const ORIGINAL_PLAIN = [
	"# 自作リスト(テスト用)",
	"ユメワ",
	"イマモ",
	"メグリテ",
	"ユメ",
	"イマ",
	"メグリ",
	"ワイ",
	"モメ",
	"リテ",
].join("\n");
const ORIGINAL_SURFACES = new Set(
	ORIGINAL_PLAIN.split("\n").filter((l) => l && !l.startsWith("#")));

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

const lockedOf = (page) =>
	page.$$eval(".chip-word.locked .chip-word-surface", (els) => els.map((e) => e.textContent));

const facetGroupCount = (page) =>
	page.$$eval("#editor-facets .facet-group", (els) => els.length);

// パネルは閉じても中身が残る(スライドアウトするだけ)ので、
// 候補を見るときは必ず「開いている」状態に限定する
const CANDIDATE = "#editor-panel.open .panel-candidates .candidate";

const candidateSurfaces = (page) =>
	page.$$eval(CANDIDATE + " .candidate-surface",
		(els) => els.map((e) => e.textContent.replace(/×\d+$/, "")));

function waitIdle(page) {
	return page.waitForFunction(() => {
		const btn = document.getElementById("btn-reconvert");
		return btn && !btn.disabled && document.getElementById("reconvert-progress").hidden;
	}, undefined, { timeout: 180000 });
}

async function openSettings(page) {
	const open = await page.$eval("#editor-settings", (d) => d.open);
	if (!open) await page.click("#btn-settings");
	await page.waitForFunction(() => document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
}

// 「この設定で再変換」は自分でモーダルを閉じるので、開いているときだけ×を押す
async function closeSettings(page) {
	if (await page.$eval("#editor-settings", (d) => d.open)) {
		await page.click("#btn-settings-close");
	}
	await page.waitForFunction(() => !document.getElementById("editor-settings").open,
		undefined, { timeout: 10000 });
}

// 1行目の先頭ユニットを選び直して候補パネルを開く
async function openCandidates(page) {
	if (await page.isVisible("#editor-panel.open .panel-close")) {
		await page.click("#editor-panel.open .panel-close");
		await page.waitForFunction(
			() => !document.getElementById("editor-panel").classList.contains("open"),
			undefined, { timeout: 10000 });
	}
	await page.locator(".editor-line[data-line='0'] .chip-unit").first().click();
	await page.waitForSelector(CANDIDATE, { timeout: 30000 });
}

// 配置済みの替え歌単語チップを選び直して候補パネルを開く。単語1つ分の範囲なので
// 語数の少ない自作リストでも候補が出る(1モーラだけ選ぶと候補0件になりうる)
async function openCandidatesForWord(page) {
	if (await page.isVisible("#editor-panel.open .panel-close")) {
		await page.click("#editor-panel.open .panel-close");
		await page.waitForFunction(
			() => !document.getElementById("editor-panel").classList.contains("open"),
			undefined, { timeout: 10000 });
	}
	await page.locator(".editor-line[data-line='0'] .chip-word").first().click();
	await page.waitForSelector(CANDIDATE, { timeout: 30000 });
}

// 単語リストDBの組み直しは進捗表示のない非同期処理(戻る/進むの直後)なので、
// 候補の顔ぶれが変わるまで開き直して待つ
async function waitCandidatesChanged(page, previous) {
	const deadline = Date.now() + 180000;
	for (;;) {
		await openCandidates(page);
		const now = await candidateSurfaces(page);
		if (now.join("|") !== previous.join("|")) return now;
		if (Date.now() > deadline) return now;
		await page.waitForTimeout(1000);
	}
}

const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
	stdio: "ignore",
	detached: true,
});

let exitCode = 1;
try {
	await waitForServer(`${BASE}/`);

	// 切替先(ポケモン)の表記集合。結果・候補が新リストの語だけになったかを見る
	const pokeCsv = await (await fetch(`${BASE}/wordlists/pokemon.csv`)).text();
	const pokeRows = pokeCsv.split(/\r\n|\n|\r/);
	const iPokeSurface = pokeRows[0].split(",").indexOf("surface");
	const pokemonSurfaces = new Set(
		pokeRows.slice(1).map((r) => r.split(",")[iPokeSurface]).filter(Boolean));
	assert(pokemonSurfaces.size > 0, "ポケモンの表記集合が空(テストデータ不備)");

	const browser = await chromium.launch();
	const context = await browser.newContext();
	// 外部リクエスト(読みAPI・GA等)を遮断し、kuromojiの決定的なトークナイズに固定
	await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e));

	// ---- 生成画面: 既定(野球選手)で変換して編集ツールを開く ----
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

	// ---- 単語リストのセクションが conf から組まれ、現在のリストが選ばれている ----
	await openSettings(editor);
	await editor.waitForSelector("#editor-wordlist-field:not([hidden])", { timeout: 10000 });
	assert(await editor.inputValue("#editor-wordlist") === "BASEBALL",
		"現在の単語リストが選択されていない");
	assert(await editor.isHidden("#editor-original-text"),
		"カタログのリスト選択中に自作リストの編集欄が出ている");
	// グループ(架空・生物)は optgroup になっている
	const optgroups = await editor.$$eval("#editor-wordlist optgroup", (els) => els.map((e) => e.label));
	assert(optgroups.includes("架空"), "グループがoptgroupになっていない: " + optgroups.join(","));
	assert(await facetGroupCount(editor) === 1, "野球選手のファセットは1グループのはず");
	await closeSettings(editor);

	// ---- 切替前に単語をひとつ固定しておく ----
	await openCandidates(editor);
	await editor.click(CANDIDATE);
	await editor.click(".panel-candidate-apply");
	await editor.waitForSelector(".chip-word.locked", { timeout: 10000 });
	const lockedBefore = await lockedOf(editor);
	assert(lockedBefore.length > 0, "固定した単語がない");
	const wordsBefore = await wordsOf(editor);

	// ---- リストを選び直すだけでは再変換しない(ファセットだけ組み直る) ----
	await openSettings(editor);
	await editor.selectOption("#editor-wordlist", "POKEMON");
	await editor.waitForFunction(() => {
		const n = document.querySelectorAll("#editor-facets .facet-group").length;
		return n === 3;
	}, undefined, { timeout: 10000 });
	assert(await editor.isVisible("#editor-facet-field"), "切替後にファセットが消えた");
	assert((await readData(editor)).wordlist.value === "BASEBALL",
		"リストを選んだだけで適用されてしまった");
	assert(await wordsOf(editor) === wordsBefore, "リストを選んだだけで結果が変わった");

	// ---- 「この設定で再変換」で切替が適用される ----
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	const afterSwitch = await readData(editor);
	assert(afterSwitch.wordlist.value === "POKEMON",
		"再変換で単語リストが切り替わっていない: " + JSON.stringify(afterSwitch.wordlist));
	// 固定は全解除(別リストの単語を持ち越すとidが衝突するため)
	assert((await lockedOf(editor)).length === 0, "リスト切替なのに固定が残っている");
	const wordsPokemon = (await wordsOf(editor)).split("|").filter(Boolean);
	assert(wordsPokemon.length > 0, "切替後の結果が空");
	const leaked = wordsPokemon.filter((s) => !pokemonSurfaces.has(s));
	assert(leaked.length === 0, "切替後も旧リストの単語が残っている: " + leaked.join(","));

	// 候補も新しいリストのものになる
	await closeSettings(editor);
	await openCandidates(editor);
	const candPokemon = await candidateSurfaces(editor);
	const candLeaked = candPokemon.filter((s) => !pokemonSurfaces.has(s));
	assert(candLeaked.length === 0, "候補に旧リストの単語が出ている: " + candLeaked.join(","));

	// ---- 戻る1回でリスト・結果・固定がまとめて元に戻る ----
	await editor.click("#btn-undo");
	await editor.waitForFunction(
		() => !document.getElementById("btn-redo").disabled, { timeout: 10000 });
	const undone = await readData(editor);
	assert(undone.wordlist.value === "BASEBALL",
		"戻るで単語リストが元に戻らない: " + JSON.stringify(undone.wordlist));
	assert(await wordsOf(editor) === wordsBefore, "戻るで結果が元に戻らない");
	assert((await lockedOf(editor)).join("|") === lockedBefore.join("|"),
		"戻るで固定が復元されない");
	await openSettings(editor);
	assert(await editor.inputValue("#editor-wordlist") === "BASEBALL",
		"戻るでリストの選択表示が元に戻らない");
	assert(await facetGroupCount(editor) === 1, "戻るでファセットが元に戻らない");
	// 候補DBも旧リストで組み直されている(表示だけ戻して中身が新リストのまま、を防ぐ)
	await closeSettings(editor);
	const candBaseball = await waitCandidatesChanged(editor, candPokemon);
	assert(candBaseball.join("|") !== candPokemon.join("|"),
		"戻るのあとも候補がポケモンのまま: " + candBaseball.slice(0, 5).join(","));

	// ---- 自作リスト: モーダル内で書いてそのまま使える ----
	await openSettings(editor);
	// 選んだだけでは設定画面に入力操作を常駐させず、専用モーダルを開く。
	// キャンセルしたときは直前のリストへ戻る。
	await editor.selectOption("#editor-wordlist", "ORIGINAL");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	await editor.click("#btn-original-cancel");
	await editor.waitForFunction(
		() => document.getElementById("editor-wordlist").value === "BASEBALL",
		undefined, { timeout: 10000 });
	assert(await editor.inputValue("#editor-wordlist") === "BASEBALL",
		"自作リスト登録のキャンセルで元の選択へ戻らない");
	assert(await facetGroupCount(editor) === 1,
		"自作リスト登録のキャンセルで元のファセットへ戻らない");
	await editor.selectOption("#editor-wordlist", "ORIGINAL");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	assert(await editor.isHidden("#editor-facet-field"),
		"自作リストなのにファセットが出ている");
	await editor.fill("#editor-original-text", ORIGINAL_PLAIN);
	// 明示的な貼り付けボタンでもtextareaと同じ入力経路を通る
	const clipboardText = "山田,ヤマダ\n佐藤,サトウ";
	await editor.evaluate((text) => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { readText: async () => text },
		});
	}, clipboardText);
	await editor.click("#btn-original-paste");
	await editor.waitForFunction(
		(t) => document.getElementById("editor-original-text").value === t,
		clipboardText, { timeout: 10000 });
	assert((await editor.textContent("#original-file-status")).includes("2語"),
		"クリップボード貼り付けの件数が表示されていない");
	// 後続の既存テストは元の自作リストを使う
	await editor.fill("#editor-original-text", ORIGINAL_PLAIN);
	await editor.click("#btn-original-register");
	// 登録したときだけ生成画面と共有する localStorage に保存される
	assert(await editor.evaluate((k) => localStorage.getItem(k), ORIGINAL_KEY) === ORIGINAL_PLAIN,
		"登録した自作リストが localStorage に保存されていない");
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	const afterOriginal = await readData(editor);
	assert(afterOriginal.wordlist.value === "ORIGINAL",
		"自作リストが適用されていない: " + JSON.stringify(afterOriginal.wordlist));
	assert(typeof afterOriginal.wordlist.csvText === "string"
		&& afterOriginal.wordlist.csvText.startsWith("id,original,surface,pronunciation"),
		"csvText(正規化CSV)が保持されていない");
	const wordsOriginal = (await wordsOf(editor)).split("|").filter(Boolean);
	assert(wordsOriginal.length > 0, "自作リストでの結果が空");
	const notMine = wordsOriginal.filter((s) => !ORIGINAL_SURFACES.has(s));
	assert(notMine.length === 0, "自作リスト以外の単語が出ている: " + notMine.join(","));

	// ---- 自作リスト: CSV/テキストファイルからも読み込める ----
	// 貼り付けと同じ経路(textarea → input → localStorage → 正規化CSV)を通ること、
	// そのまま再変換すれば自作リストの語だけになることを見る
	await openSettings(editor);
	await editor.click("#btn-original-edit");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	await editor.fill("#editor-original-text", ""); // 消してからファイルで埋め直す
	const [chooser] = await Promise.all([
		editor.waitForEvent("filechooser"),
		editor.click("#btn-original-file"),
	]);
	await chooser.setFiles({
		name: "mylist.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(ORIGINAL_PLAIN, "utf8"),
	});
	await editor.waitForFunction(
		(t) => document.getElementById("editor-original-text").value === t,
		ORIGINAL_PLAIN, { timeout: 10000 });
	const fileStatus = await editor.textContent("#original-file-status");
	assert(fileStatus.includes("mylist.csv") && fileStatus.includes("9"),
		"読み込みの状態表示(ファイル名・件数)が出ていない: " + fileStatus);
	await editor.click("#btn-original-register");
	assert(await editor.evaluate((k) => localStorage.getItem(k), ORIGINAL_KEY) === ORIGINAL_PLAIN,
		"ファイルから登録した内容がlocalStorageに保存されていない");
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	const wordsFromFile = (await wordsOf(editor)).split("|").filter(Boolean);
	assert(wordsFromFile.length > 0, "ファイルから読み込んだ自作リストでの結果が空");
	const notMineFile = wordsFromFile.filter((s) => !ORIGINAL_SURFACES.has(s));
	assert(notMineFile.length === 0,
		"ファイル読み込み後に自作リスト以外の単語が出ている: " + notMineFile.join(","));

	// ---- 従来の2MBを超える有効なCSVも読み込める ----
	// 配信wordlistはビルド時の列射影で2MB未満になり得るため、サイズ上限の
	// 回帰テストは配信データ量に依存しない合成CSVで行う。
	await openSettings(editor);
	await editor.click("#btn-original-edit");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	const largeCsv = Buffer.from("id,original,surface,pronunciation\n"
		+ "1,駅,駅,エキ\n".repeat(180000), "utf8");
	assert(largeCsv.byteLength > 2 * 1024 * 1024,
		"合成CSVが旧上限を超えていないため回帰テストにならない");
	const [largeChooser] = await Promise.all([
		editor.waitForEvent("filechooser"),
		editor.click("#btn-original-file"),
	]);
	await largeChooser.setFiles({
		name: "large-valid.csv",
		mimeType: "text/csv",
		buffer: largeCsv,
	});
	await editor.waitForFunction(
		() => document.getElementById("original-file-status").textContent
			.includes("large-valid.csv"),
		undefined, { timeout: 10000 });
	assert((await editor.inputValue("#editor-original-text")).startsWith("id,"),
		"2MB超の有効CSVが自作リスト欄に読み込まれていない");
	// 後続の拒否テストでは「入力欄が書き換わらない」ことを小さい値で比較する
	await editor.fill("#editor-original-text", ORIGINAL_PLAIN);

	// ---- 上限(10MB)を超えるファイルは読み込まずに断る ----
	const [bigChooser] = await Promise.all([
		editor.waitForEvent("filechooser"),
		editor.click("#btn-original-file"),
	]);
	await bigChooser.setFiles({
		name: "huge.csv",
		mimeType: "text/csv",
		buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
	});
	await editor.waitForFunction(
		() => document.getElementById("original-file-status").textContent.includes("大きすぎ"),
		undefined, { timeout: 10000 });
	assert(await editor.inputValue("#editor-original-text") === ORIGINAL_PLAIN,
		"上限を超えるファイルなのに編集欄が書き換わっている");
	await editor.click("#btn-original-cancel");
	await closeSettings(editor);

	// ---- 書き出し: 自作リストのCSVごと自己完結する ----
	const [download] = await Promise.all([
		editor.waitForEvent("download"),
		editor.click("#btn-export"),
	]);
	const exportPath = await download.path();
	const exported = JSON.parse(await readFile(exportPath, "utf8"));
	assert(exported.wordlist && exported.wordlist.value === "ORIGINAL"
		&& typeof exported.wordlist.csvText === "string",
		"書き出しJSONに自作リストのcsvTextが入っていない");
	assert(exported.wordlist.csvText.includes(",ユメワ,ユメワ"),
		"csvTextの中身が想定と違う:\n" + exported.wordlist.csvText.slice(0, 200));

	// ---- 読み込み: localStorage が空でも csvText からDBが組める ----
	await editor.evaluate((k) => {
		sessionStorage.clear();
		localStorage.removeItem(k);
	}, ORIGINAL_KEY);
	await editor.reload();
	await editor.waitForSelector("#editor-empty:not([hidden])", { timeout: 10000 });
	await editor.setInputFiles("#import-file", exportPath);
	await editor.waitForSelector(".editor-line .chip-unit", { timeout: 30000 });
	assert((await wordsOf(editor)).split("|").filter(Boolean).join("|") === wordsOriginal.join("|"),
		"読み込みで自作リストの結果が変わった");
	await editor.waitForFunction(
		() => !document.getElementById("btn-reconvert").disabled, { timeout: 120000 });
	await openCandidatesForWord(editor);
	const importedCands = await candidateSurfaces(editor);
	assert(importedCands.length > 0, "csvTextから候補DBが組めていない(候補0件)");
	const importedLeak = importedCands.filter((s) => !ORIGINAL_SURFACES.has(s));
	assert(importedLeak.length === 0,
		"csvText以外から候補が出ている: " + importedLeak.join(","));

	// ---- 読みを書いていない漢字の語は、推定した読みをcsvTextに焼き込む ----
	// (再変換・書き出し・埋め込み先の行解決がどれも同じ読みを見るようにするため)
	await openSettings(editor);
	await editor.waitForSelector("#editor-wordlist-field:not([hidden])", { timeout: 30000 });
	await editor.click("#btn-original-edit");
	await editor.waitForSelector("#editor-original-dialog[open]", { timeout: 10000 });
	await editor.fill("#editor-original-text", ORIGINAL_PLAIN + "\n林檎");
	await editor.click("#btn-original-register");
	await editor.click("#btn-reconvert");
	await waitIdle(editor);
	const guessedCsv = (await readData(editor)).wordlist.csvText;
	const kanjiRow = guessedCsv.split("\n").find((r) => r.split(",")[2] === "林檎");
	assert(kanjiRow && /^[ァ-ヶー]+$/.test(kanjiRow.split(",")[3]),
		"漢字1列の語の読みがカナになっていない: " + kanjiRow);

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor wordlist test passed");
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
