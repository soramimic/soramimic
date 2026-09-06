// セットアップ画面の曲選択(ホストへの依頼)のE2E。
// soramimic はMIDIの実体も解析も持たないので、曲の切替は埋め込み元(ホスト)に頼む
// という契約を、テスト自身がホスト役になって実ブラウザで確認する:
//   host.songs 入りのシード → いまの曲名と「サンプルから選ぶ」の折りたたみが出る。
//   折りたたみを開いて選ぶと hostRequest が書かれて待機になる。
//   ホスト役が phrases を差し替えて hostRequest を消す → 新しい曲で描き直され変換できる。
//   ホスト役が hostRequest だけ消す(キャンセル) → 待機解除で曲は元のまま。
//   host.canUploadSong → 「自分のMIDIを使う」から song-upload の依頼が出る。
//   host 無しのシード → 従来どおり曲名の読み取り専用表示(単体運用が変わらないこと)。
// 実行: npm run build && node tests/editor-song.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 4603;
const BASE = `http://localhost:${PORT}`;
const EDITOR_KEY = "soramimic-editor";

const SONGS = [
	{ id: "furusato", title: "ふるさと" },
	{ id: "katatsumuri", title: "かたつむり" },
];
const PHRASES = ["夢は今もめぐりて", "忘れがたきふるさと"];
const NEXT_PHRASES = ["でんでんむしむし", "かたつむり"];

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

// サンプル曲のselectは折りたたみの中にあるので、触る前に開く
const openSamples = async (page) => {
	await page.click("#setup-song-samples > summary");
	await page.waitForSelector("#setup-song-select", { state: "visible", timeout: 10000 });
};

// セットアップ画面が操作できる状態(エンジン初期化済み)になるまで待つ
const waitSetupReady = (page) =>
	page.waitForFunction(() => {
		const btn = document.getElementById("btn-setup-convert");
		return btn && !btn.disabled && !document.getElementById("editor-setup").hidden;
	}, undefined, { timeout: 180000 });

// 依頼中(待機状態)になるまで待つ: hostRequest が書かれ、操作がロックされている
const waitRequest = (page, type) =>
	page.waitForFunction((t) => {
		const d = JSON.parse(sessionStorage.getItem("soramimic-editor"));
		return d && d.hostRequest && d.hostRequest.type === t
			&& document.getElementById("btn-setup-convert").disabled;
	}, type, { timeout: 30000 });

// ホスト役の書き戻し。mutate(関数本体のソース)でペイロードをいじってから
// hostRequest を消す = 依頼への応答
const respondAsHost = (page, mutate) =>
	page.evaluate((src) => {
		const k = "soramimic-editor";
		const d = JSON.parse(sessionStorage.getItem(k));
		new Function("d", src)(d);
		delete d.hostRequest;
		sessionStorage.setItem(k, JSON.stringify(d));
	}, mutate);

// 待機が解けるまで(=エディタが応答を取り込むまで)待つ
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

	// ---- host.songs 入りのシード → 曲名+「自分のMIDIを使う」+折りたたんだ一覧 ----
	await page.goto(`${BASE}/editor.html`);
	await seed(page, {
		phrases: PHRASES,
		song: { id: "furusato", title: "ふるさと" },
		host: { songs: SONGS, canUploadSong: true },
	});
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	// いまの曲名は折りたたみを開かなくても常に見える
	assert(!(await isHidden(page, "#setup-song-title")), "いまの曲名が出ていない");
	assert(await page.textContent("#setup-song-title") === "ふるさと", "いまの曲名が違う");
	assert(!(await isHidden(page, "#btn-setup-song-upload")),
		"canUploadSong なのに「自分のMIDIを使う」が無い");
	// サンプル一覧は既定で閉じた折りたたみ(=selectはまだ見えない)
	assert(!(await isHidden(page, "#setup-song-samples")), "サンプルの折りたたみが出ていない");
	assert(!(await page.$eval("#setup-song-samples", (el) => el.open)),
		"サンプルの折りたたみが既定で開いている");
	assert(await isHidden(page, "#setup-song-select"), "折りたたむ前から曲selectが見えている");
	// 主役は「自分のMIDIを使う」。サンプル一覧より上にあること(DOM順)
	assert(await page.evaluate(() => {
		const actions = document.getElementById("setup-song-actions");
		const samples = document.getElementById("setup-song-samples");
		return !!(actions.compareDocumentPosition(samples) & Node.DOCUMENT_POSITION_FOLLOWING);
	}), "「自分のMIDIを使う」がサンプル一覧より下にある");

	await openSamples(page);
	assert(!(await isHidden(page, "#setup-song-select")), "開いても曲selectが出ていない");
	assert(await page.$eval("#setup-song-select", (el) => el.value) === "furusato",
		"いまの曲がselectに反映されていない");
	assert(await page.$$eval("#setup-song-select option", (els) => els.length) === SONGS.length,
		"曲の選択肢の数が合わない");
	await waitSetupReady(page);
	// 単語リストの選択が曲の切替をまたいで維持されることを、あとで確認する
	await page.waitForSelector("#editor-wordlist-field:not([hidden])", { timeout: 30000 });
	await page.selectOption("#editor-wordlist", "STATION");

	// ---- 曲を選ぶ → hostRequest が書かれて待機 ----
	await page.selectOption("#setup-song-select", "katatsumuri");
	await waitRequest(page, "song");
	const req = (await readData(page)).hostRequest;
	assert(req.id === "katatsumuri", "依頼に選んだ曲のidが入っていない: " + JSON.stringify(req));
	assert(typeof req.nonce === "number", "依頼にnonceが無い");
	assert(!(await isHidden(page, "#setup-song-status")), "依頼中の表示が出ていない");
	assert(await page.$eval("#setup-song-select", (el) => el.disabled),
		"依頼中なのに曲を選び直せる(多重依頼になる)");
	assert(await page.$eval("#editor-wordlist", (el) => el.disabled),
		"依頼中なのに単語リストを触れる");

	// ---- ホスト役が曲を差し替えて応答 → 新しい曲で描き直される ----
	await respondAsHost(page, `
		d.phrases = ${JSON.stringify(NEXT_PHRASES)};
		d.song = { id: "katatsumuri", title: "かたつむり" };
		delete d.results; delete d.tokensList; delete d.unitsList;
	`);
	await waitIdleSetup(page);
	assert(await page.$eval("#setup-song-select", (el) => el.value) === "katatsumuri",
		"新しい曲がselectに反映されていない");
	// 描き直したあとは折りたたみに戻る。新しい曲名は上に出ているので分かる
	assert(await page.textContent("#setup-song-title") === "かたつむり",
		"新しい曲名が上に出ていない");
	assert(!(await page.$eval("#setup-song-samples", (el) => el.open)),
		"応答後もサンプルの折りたたみが開いたままになっている");
	assert(await isHidden(page, "#setup-song-status"), "応答後も依頼中の表示が残っている");
	assert(!(await isHidden(page, "#editor-setup")),
		"曲を替えたのにセットアップ画面から出てしまった");
	assert(await isHidden(page, "#btn-setup-back"),
		"未変換に戻ったのに編集画面へ戻れてしまう");
	assert(await page.$eval("#editor-wordlist", (el) => el.value) === "STATION",
		"曲の切替で単語リストの選択が失われた");

	// ---- 新しい曲で変換できる ----
	await waitSetupReady(page);
	await page.click("#btn-setup-convert");
	await page.waitForSelector(".editor-line .chip-word", { timeout: 180000 });
	const converted = await readData(page);
	assert(converted.results.length === NEXT_PHRASES.length,
		"新しい曲の行数で変換されていない: " + converted.results.length);
	assert(converted.wordlist.value === "STATION",
		"曲の切替をまたいで選んだ単語リストが使われていない");
	assert(converted.host && converted.host.songs.length === SONGS.length,
		"ホストが渡した host が失われている");

	// ---- 書き出しJSONに host / hostRequest は載らない ----
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.click("#btn-export"),
	]);
	const exported = JSON.parse(await readFile(await download.path(), "utf8"));
	assert(!("host" in exported) && !("hostRequest" in exported),
		"書き出しJSONにホスト固有の一時情報が入っている");

	// ---- キャンセル(hostRequestだけ消す) → 待機解除で曲は元のまま ----
	await seed(page, {
		phrases: PHRASES,
		song: { id: "furusato", title: "ふるさと" },
		host: { songs: SONGS, canUploadSong: true },
	});
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	await waitSetupReady(page);
	await openSamples(page);
	await page.selectOption("#setup-song-select", "katatsumuri");
	await waitRequest(page, "song");
	await respondAsHost(page, "void d;"); // phrases はそのまま = キャンセル
	await waitIdleSetup(page);
	assert(await page.$eval("#setup-song-select", (el) => el.value) === "furusato",
		"キャンセルなのにselectが選び直したままになっている");
	const afterCancel = await readData(page);
	assert(JSON.stringify(afterCancel.phrases) === JSON.stringify(PHRASES),
		"キャンセルで歌詞が変わった");
	assert(await isHidden(page, "#setup-song-status"), "キャンセル後も依頼中の表示が残っている");

	// ---- 「自分のMIDIを使う」→ 専用モーダル → song-upload の依頼 ----
	await page.click("#btn-setup-song-upload");
	await page.waitForSelector("#editor-midi-dialog[open]", { timeout: 10000 });
	assert(await page.$eval("#setup-lyrics-field", (el) => !!el.closest("#editor-midi-dialog")),
		"元歌詞欄が持ち込みMIDI用モーダルの外にある");
	await page.click("#btn-setup-midi-file");
	await waitRequest(page, "song-upload");
	const upReq = (await readData(page)).hostRequest;
	assert(!("id" in upReq), "MIDI持ち込みの依頼にidが入っている: " + JSON.stringify(upReq));
	await respondAsHost(page, `
		d.phrases = ${JSON.stringify(NEXT_PHRASES)};
		d.song = { title: "自分のMIDI" };
		delete d.results; delete d.tokensList; delete d.unitsList;
	`);
	await waitIdleSetup(page);
	assert(await page.textContent("#setup-song-title") === "自分のMIDI",
		"持ち込んだ曲の名前が上に出ていない");
	// 一覧に無い曲(持ち込み)なので、その曲名の項目が先頭に足されて選ばれる
	assert(await page.$eval("#setup-song-select", (el) => el.selectedOptions[0].textContent)
		=== "自分のMIDI", "持ち込んだ曲の名前がselectに出ていない");
	assert(JSON.stringify((await readData(page)).phrases) === JSON.stringify(NEXT_PHRASES),
		"持ち込んだ曲の歌詞に差し替わっていない");
	assert(await page.$eval("#editor-midi-dialog", (el) => el.open),
		"MIDI選択後に元歌詞を入力する前にモーダルが閉じている");
	await page.click("#btn-setup-midi-done");

	// ---- host 無しのシード → 従来どおり読み取り専用の曲名表示 ----
	await seed(page, { phrases: PHRASES, song: { title: "ふるさと" } });
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(await isHidden(page, "#setup-song-samples"),
		"host が無いのにサンプルの折りたたみが出ている");
	assert(await isHidden(page, "#setup-song-select"), "host が無いのに曲selectが出ている");
	assert(await isHidden(page, "#btn-setup-song-upload"),
		"host が無いのにMIDI持ち込みボタンが出ている");
	assert(!(await isHidden(page, "#setup-song-title")), "曲名の読み取り専用表示が出ていない");
	assert(await page.textContent("#setup-song-title") === "ふるさと", "曲名が違う");

	// ---- 曲も host も無いシード → 曲セクションごと出ない ----
	await seed(page, { phrases: PHRASES });
	await page.waitForSelector("#editor-setup:not([hidden])", { timeout: 30000 });
	assert(await isHidden(page, "#setup-song-field"),
		"曲の情報が無いのに曲セクションが出ている");

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] editor song test passed");
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
