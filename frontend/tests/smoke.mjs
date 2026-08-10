// UIスモークテスト(#5): ビルド済みアプリを実ブラウザで駆動し、
// 「歌詞入力 → 変換 → 結果表示」と「MIDI取り込み」の導線が生きていることを確認する。
// 実行: npm run build && node tests/smoke.mjs
// 形態素解析はkuromoji.jsでブラウザ内完結(外部API通信なし)。
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { buildXfMidi } from "../../tests/xfmidi-fixture.mjs";

const PORT = 4199;

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

// detached + プロセスグループkillで、子のviteプロセスも確実に始末する
const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
	stdio: "ignore",
	detached: true,
});

let exitCode = 1;
try {
	await waitForServer(`http://localhost:${PORT}/`);
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e));

	await page.goto(`http://localhost:${PORT}/`);

	// 初期化完了(データ読み込み後、ボタンが「変換」になる)を待つ。失敗表示なら即エラー
	await page.waitForFunction(
		() => {
			const t = document.getElementById("btn-convert").textContent;
			return t === "変換" || t === "読み込みに失敗しました";
		},
		{ timeout: 60000 },
	);
	const initState = await page.textContent("#btn-convert");
	if (initState !== "変換") {
		throw new Error("初期化失敗: " + initState + " / " + pageErrors.map((e) => e.message).join("; "));
	}
	const defaultFormat = await page.inputValue("#format-select");
	if (defaultFormat !== "4") {
		throw new Error("既定の出力形式が対応区切りではない: " + defaultFormat);
	}
	const formatNearOutput = await page.evaluate(() =>
		document.getElementById("output-field").contains(document.getElementById("format-select")));
	if (!formatNearOutput) {
		throw new Error("出力形式が出力結果欄の中にない");
	}

	// ---- ファセット: Excel風の「すべて選択」で全選択・全解除・中間状態を表す ----
	await page.click("#wordlist-buttons button[data-value='POKEMON']");
	const initialFacetState = await page.locator("#wordlist-facets .facet-group").evaluateAll((groups) =>
		groups.map((group) => ({
			all: group.querySelectorAll("input.facet-value").length,
			checked: group.querySelectorAll("input.facet-value:checked").length,
			selectAll: group.querySelector("input.facet-select-all-input").checked,
			indeterminate: group.querySelector("input.facet-select-all-input").indeterminate,
		})));
	if (initialFacetState.length === 0 || initialFacetState.some((s) =>
		s.all === 0 || s.checked !== s.all || !s.selectAll || s.indeterminate)) {
		throw new Error("既定指定のないファセットが全チェックで始まらない: " +
			JSON.stringify(initialFacetState));
	}
	const firstFacet = page.locator("#wordlist-facets .facet-group").first();
	const selectAll = firstFacet.getByRole("checkbox", { name: "タイプをすべて選択" });
	await selectAll.uncheck();
	if (await firstFacet.locator("input.facet-value:checked").count() !== 0) {
		throw new Error("すべて選択を外しても個別チェックが外れない");
	}
	await selectAll.check();
	if (await firstFacet.locator("input.facet-value:checked").count() !==
		await firstFacet.locator("input.facet-value").count()) {
		throw new Error("すべて選択を入れても全件チェックされない");
	}
	await firstFacet.locator("input.facet-value").first().uncheck();
	if (!await selectAll.evaluate((el) => el.indeterminate)) {
		throw new Error("一部選択時にすべて選択が中間状態にならない");
	}
	// 後続の既存変換テストは従来どおり既定の野球選手リストで行う。
	await page.click("#wordlist-buttons button[data-value='BASEBALL']");
	const baseballSelectAll = page.getByRole("checkbox", { name: "種類をすべて選択" });
	if (!await baseballSelectAll.evaluate((el) => el.indeterminate)) {
		throw new Error("既定が部分選択のファセットで中間状態にならない");
	}

	await page.fill("#input-text", "夢は今もめぐりて 忘れがたきふるさと");
	await page.click("#btn-convert");

	// 変換完了(出力欄に結果が入る)を待つ。単語リストのロード・解析込み
	await page.waitForFunction(
		() => {
			const out = document.getElementById("output-text");
			return !document.getElementById("output-field").hidden && out.value.length > 0;
		},
		{ timeout: 120000 },
	);

	const output = await page.inputValue("#output-text");
	console.log("--- 変換結果 ---");
	console.log(output);

	if (output.includes("エラーが発生しました")) {
		throw new Error("変換がエラーで終了: " + output);
	}
	if (output.includes("うまく変換できる単語を見つけられませんでした")) {
		throw new Error("変換結果が空");
	}

	// ---- 結果コピー: 現在表示されている本文をそのままコピーする ----
	await page.evaluate(() => {
		window.__copiedResult = null;
		navigator.clipboard.writeText = (text) => {
			window.__copiedResult = text;
			return Promise.resolve();
		};
	});
	await page.click("#btn-copy-result");
	await page.waitForFunction(() => window.__copiedResult !== null, { timeout: 10000 });
	const copiedResult = await page.evaluate(() => window.__copiedResult);
	if (copiedResult !== output) {
		throw new Error("出力結果とコピー内容が一致しない");
	}
	if (await page.textContent("#btn-copy-result") !== "コピー") {
		throw new Error("コピー後にボタン文言が変わった");
	}
	if (!await page.locator("#btn-copy-result").evaluate((el) => el.classList.contains("copy-success"))) {
		throw new Error("コピー成功状態が表示されない");
	}
	if (await page.textContent("#copy-result-status") !== "コピーしました") {
		throw new Error("コピー成功が読み上げ通知されない");
	}

	// ---- パラメータ永続化: 設定を変えてリロードしても復元されることを確認 ----
	// プリセット「文節重視」(phrase=8)を選び、単語重複を「あり」にしてからリロードする
	const phraseSlider = "input[aria-label='文節の区切り(無視〜がっちり守る)']";
	await page.click("#preset-buttons button:has-text('文節重視')");
	await page.click("#duplicate-buttons button[data-value='true']");
	await page.waitForFunction((sel) => document.querySelector(sel).value === "8", phraseSlider);
	await page.reload();
	await page.waitForFunction(
		() => {
			const t = document.getElementById("btn-convert").textContent;
			return t === "変換" || t === "読み込みに失敗しました";
		},
		{ timeout: 60000 },
	);
	const restored = await page.evaluate((sel) => ({
		phrase: document.querySelector(sel).value,
		duplicate: document.querySelector("#duplicate-buttons button.active").dataset.value,
		preset: (document.querySelector("#preset-buttons button.active") || {}).textContent || null,
	}), phraseSlider);
	if (restored.phrase !== "8" || restored.duplicate !== "true" || restored.preset !== "文節重視") {
		throw new Error("パラメータ永続化に失敗: " + JSON.stringify(restored));
	}

	// ---- MIDI取り込み: 入力欄にテキストがあると元歌詞として使うか聞かれる ----
	// (変換直後なので入力欄は非空 → ダイアログで「読みカナで取り込む」を選ぶ)
	const fixtureMidi = {
		name: "fixture.mid",
		mimeType: "audio/midi",
		buffer: Buffer.from(buildXfMidi()),
	};
	await page.setInputFiles("#midi-file", fixtureMidi);
	await page.waitForSelector("#midi-lyrics-dialog[open]", { timeout: 15000 });
	await page.click("#midi-lyrics-no");
	await page.waitForFunction(
		() => document.getElementById("input-text").value === "シズム\nトケ",
		{ timeout: 15000 },
	);
	const midiStatus = await page.textContent("#midi-status");
	if (!midiStatus.includes("2行・5音符")) {
		throw new Error("MIDI取り込みステータスが想定外: " + midiStatus);
	}

	// ---- MIDI取り込み(元歌詞つき): 歌唱行と対応づけて表記ベースの行になる ----
	await page.fill("#input-text", "私は沈むけど、とけない");
	await page.setInputFiles("#midi-file", fixtureMidi);
	await page.waitForSelector("#midi-lyrics-dialog[open]", { timeout: 15000 });
	await page.click("#midi-lyrics-yes");
	await page.waitForFunction(
		() => document.getElementById("input-text").value === "沈む\nとけ",
		{ timeout: 15000 },
	);
	const alignStatus = await page.textContent("#midi-status");
	if (!alignStatus.includes("対応づけ: 2/2行")) {
		throw new Error("元歌詞対応づけのステータスが想定外: " + alignStatus);
	}

	// ---- サンプルチップ: クリックで歌詞と単語リストが入り、自動で変換が始まる ----
	// (完了まで待つと全曲変換で時間がかかるため、開始=ボタンdisabledまでを確認する)
	await page.click("#sample-buttons button:has-text('ももたろう × ポケモン')");
	await page.waitForFunction(
		() => document.getElementById("input-text").value.includes("桃太郎さん"),
		{ timeout: 15000 },
	);
	const sampleWordlist = await page.evaluate(
		() => document.querySelector("#wordlist-buttons button.active")?.dataset.value,
	);
	if (sampleWordlist !== "POKEMON") {
		throw new Error("サンプルチップで単語リストが切り替わらない: " + sampleWordlist);
	}
	await page.waitForFunction(
		() => document.getElementById("btn-convert").disabled,
		{ timeout: 15000 },
	);

	// ---- 中止ボタン: 変換中に押すとUIが即座に待機状態へ戻る ----
	await page.waitForSelector("#btn-cancel:not([hidden])", { timeout: 15000 });
	await page.click("#btn-cancel");
	await page.waitForFunction(
		() => {
			const b = document.getElementById("btn-convert");
			return !b.disabled && b.textContent === "変換" &&
				document.getElementById("progress").hidden &&
				document.getElementById("btn-cancel").hidden;
		},
		{ timeout: 5000 },
	);

	if (pageErrors.length > 0) {
		throw new Error("ページエラー: " + pageErrors.map((e) => e.message).join("; "));
	}

	console.log("[ok] smoke test passed");
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
