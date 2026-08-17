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

	// ---- 名前付き自作リスト: 旧1件データの移行・複数保存・編集・削除 ----
	await page.evaluate(() => {
		localStorage.removeItem("soramimic-custom-wordlists");
		localStorage.setItem("originalWordlist", "山田,ヤマダ");
		sessionStorage.removeItem("soramimic-main");
	});
	await page.reload();
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	const migrated = await page.evaluate(() => ({
		legacy: localStorage.getItem("originalWordlist"),
		state: JSON.parse(localStorage.getItem("soramimic-custom-wordlists")),
	}));
	if (migrated.legacy !== null || migrated.state.version !== 1
		|| migrated.state.lists.length !== 1
		|| migrated.state.lists[0].text !== "山田,ヤマダ") {
		throw new Error("旧自作リストの移行に失敗: " + JSON.stringify(migrated));
	}
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 320, height: 568 });
	const customTrigger = page.locator(".custom-wordlist-trigger");
	const customMenu = page.locator("#custom-wordlist-menu");
	if (await customTrigger.getAttribute("aria-haspopup") !== "menu"
		|| await customTrigger.getAttribute("aria-controls") !== "custom-wordlist-menu"
		|| await customTrigger.getAttribute("aria-expanded") !== "false") {
		throw new Error("自作リストtriggerのARIA属性が不正");
	}
	await customTrigger.click();
	const rowStructure = await customMenu.locator(".custom-wordlist-menu-row").first().evaluate((row) => ({
		children: [...row.children].map((el) => ({
			role: el.getAttribute("role"),
			label: el.ariaLabel,
			icon: !!el.querySelector("svg[aria-hidden='true']"),
		})),
		nested: row.querySelectorAll("button button").length,
		rect: (() => {
			const rect = row.getBoundingClientRect();
			return { left: rect.left, right: rect.right, width: rect.width };
		})(),
		heights: [...row.children].map((el) => el.getBoundingClientRect().height),
	}));
	if (rowStructure.children.length !== 3
		|| rowStructure.children[0].role !== "menuitemradio"
		|| rowStructure.children[1].role !== "menuitem"
		|| rowStructure.children[2].role !== "menuitem"
		|| !rowStructure.children[1].label.includes("編集")
		|| !rowStructure.children[2].label.includes("削除")
		|| !rowStructure.children[1].icon || !rowStructure.children[2].icon
		|| rowStructure.nested !== 0 || rowStructure.rect.left < 0
		|| rowStructure.rect.right > 320 || rowStructure.heights.some((height) => height < 43)) {
		throw new Error("自作リスト行の3操作・狭幅配置が不正: " + JSON.stringify(rowStructure));
	}
	// 基本キー操作と、閉じた後のtrigger focusを確認する。
	await page.keyboard.press("End");
	if ((await page.locator(":focus").textContent()).trim() !== "＋ 新しいリスト") {
		throw new Error("Endで末尾項目へ移動しない");
	}
	await page.keyboard.press("Home");
	if (await page.locator(":focus").getAttribute("role") !== "menuitemradio") {
		throw new Error("Homeで先頭項目へ移動しない");
	}
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("Escape");
	if (!await customMenu.isHidden() || !await customTrigger.evaluate((el) => el === document.activeElement)) {
		throw new Error("Escapeでメニューを閉じてtriggerへfocusしない");
	}
	await customTrigger.click();
	await page.keyboard.press("Tab");
	if (!await customMenu.isHidden()) throw new Error("Tabでメニューが閉じない");
	await customTrigger.click();
	await page.click("#input-text");
	if (!await customMenu.isHidden()
		|| !await page.locator("#input-text").evaluate((el) => el === document.activeElement)) {
		throw new Error("外側クリックでメニューを閉じた後にクリック先へfocusしない");
	}
	await customTrigger.click();
	await customMenu.getByRole("menuitemradio", { name: "自作リスト", exact: true }).click();
	if (!await customTrigger.evaluate((el) => el.classList.contains("active")
		&& el === document.activeElement)) {
		throw new Error("保存済み自作リストの選択後にtriggerへfocusしない");
	}
	await customTrigger.focus();
	await page.keyboard.press("ArrowDown");
	const selectedMenuVisual = await customMenu.getByRole(
		"menuitemradio", { name: "自作リスト", exact: true }).evaluate((el) => {
		const style = getComputedStyle(el);
		const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
		const luminance = (value) => {
			const channels = rgb(value).map((n) => {
				const v = n / 255;
				return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
		};
		const [hi, lo] = [luminance(style.color), luminance(style.backgroundColor)]
			.sort((a, b) => b - a);
		return {
			contrast: (hi + 0.05) / (lo + 0.05),
			outlineWidth: parseFloat(style.outlineWidth),
			outlineStyle: style.outlineStyle,
		};
	});
	if (selectedMenuVisual.contrast < 4.5 || selectedMenuVisual.outlineWidth < 2
		|| selectedMenuVisual.outlineStyle === "none") {
		throw new Error("ダークモードの選択行・focus表示が不明瞭: "
			+ JSON.stringify(selectedMenuVisual));
	}
	await page.keyboard.press("Escape");
	// 自作リストから通常のnative selectへ移ると、自作triggerのactiveを解除する。
	await page.selectOption("#wordlist-buttons select[aria-label='生物']", "MARINE_LIFE");
	if (await customTrigger.evaluate((el) => el.classList.contains("active"))) {
		throw new Error("通常リスト選択後も自作リストがactiveのまま");
	}
	await customTrigger.click();
	await customMenu.getByRole("menuitemradio", { name: "自作リスト", exact: true }).click();
	await customTrigger.click();
	await customMenu.getByRole("menuitem", { name: "「自作リスト」を編集" }).click();
	await page.waitForSelector("#original-dialog[open]");
	if (await page.inputValue("#original-text") !== "山田,ヤマダ") {
		throw new Error("移行した自作リスト本文が編集画面に復元されない");
	}
	const darkColors = await page.evaluate(() => {
		const input = getComputedStyle(document.getElementById("original-name"));
		const textarea = getComputedStyle(document.getElementById("original-text"));
		const dialog = getComputedStyle(document.getElementById("original-dialog"));
		const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
		const luminance = (value) => {
			const channels = rgb(value).map((n) => {
				const v = n / 255;
				return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
		};
		const contrast = (fg, bg) => {
			const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
			return (hi + 0.05) / (lo + 0.05);
		};
		return {
			inputContrast: contrast(input.color, input.backgroundColor),
			textareaContrast: contrast(textarea.color, textarea.backgroundColor),
			inputFontSize: parseFloat(input.fontSize),
			dialogBackground: dialog.backgroundColor,
			inputBackground: input.backgroundColor,
			buttonsInsideViewport: [...document.querySelectorAll(
				"#original-dialog .custom-wordlist-dialog-buttons button:not([hidden])")]
				.every((button) => {
					const rect = button.getBoundingClientRect();
					return rect.left >= 0 && rect.right <= innerWidth;
				}),
		};
	});
	if (darkColors.inputContrast < 4.5 || darkColors.textareaContrast < 4.5
		|| darkColors.dialogBackground !== darkColors.inputBackground
		|| darkColors.inputFontSize < 16 || !darkColors.buttonsInsideViewport) {
		throw new Error("ダークモード・狭幅の保存画面表示が不正: " + JSON.stringify(darkColors));
	}
	await page.fill("#original-name", "名字");
	await page.fill("#original-text", "佐藤,サトウ");
	await page.click("#original-register");
	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize({ width: 1280, height: 720 });

	await customTrigger.click();
	await customMenu.getByRole("menuitem", { name: "＋ 新しいリスト" }).click();
	await page.waitForSelector("#original-dialog[open]");
	const dropzoneText = await page.textContent("#btn-original-file");
	if (!dropzoneText.includes("ここにドロップ") || !dropzoneText.includes("クリックして選択")) {
		throw new Error("ファイルのドラッグ＆ドロップ案内が表示されない");
	}
	const droppedText = "surface,pronunciation\n葡萄,ブドウ";
	await page.evaluate((text) => {
		const file = new File([text], "果物.csv", { type: "text/csv" });
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const zone = document.getElementById("btn-original-file");
		zone.dispatchEvent(new DragEvent("dragenter", {
			bubbles: true, cancelable: true, dataTransfer: transfer,
		}));
		if (!zone.classList.contains("is-dragging")) {
			throw new Error("ドラッグ中の表示にならない");
		}
		zone.dispatchEvent(new DragEvent("drop", {
			bubbles: true, cancelable: true, dataTransfer: transfer,
		}));
	}, droppedText);
	await page.waitForFunction(
		(text) => document.getElementById("original-text").value === text,
		droppedText, { timeout: 10000 });
	if (!(await page.textContent("#original-status")).includes("果物.csv")) {
		throw new Error("ドロップしたファイルの読み込み状態が表示されない");
	}
	await page.fill("#original-name", "");
	const uploadedText = "surface,pronunciation\n林檎,リンゴ";
	const [chooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.click("#btn-original-file"),
	]);
	await chooser.setFiles({
		name: "食べ物.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(uploadedText, "utf8"),
	});
	await page.waitForFunction(
		(text) => document.getElementById("original-text").value === text,
		uploadedText, { timeout: 10000 });
	if (await page.inputValue("#original-name") !== "食べ物"
		|| !(await page.textContent("#original-status")).includes("1語")) {
		throw new Error("自作リストファイルの名前・件数表示が不正");
	}
	await page.click("#original-register");
	const savedCustom = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("soramimic-custom-wordlists")));
	if (savedCustom.lists.length !== 2
		|| savedCustom.lists[0].name !== "名字"
		|| savedCustom.lists[0].text !== "佐藤,サトウ"
		|| savedCustom.lists[1].name !== "食べ物") {
		throw new Error("複数自作リストの保存に失敗: " + JSON.stringify(savedCustom));
	}

	// 選択中IDも既存sessionStorage経由で復元され、本文はlocalStorageから再構築される。
	await page.reload();
	await page.waitForFunction(
		() => document.getElementById("btn-convert").textContent === "変換",
		{ timeout: 60000 },
	);
	const restoredCustom = await page.evaluate(() => ({
		active: document.querySelector(".custom-wordlist-trigger")?.classList.contains("active"),
		label: document.querySelector(".custom-wordlist-trigger span:last-of-type")?.textContent,
	}));
	if (!restoredCustom.active || restoredCustom.label !== "食べ物") {
		throw new Error("自作リスト選択の復元に失敗: " + JSON.stringify(restoredCustom));
	}
	await page.fill("#input-text", "りんご");
	await page.click("#btn-convert");
	await page.waitForFunction(
		() => !document.getElementById("output-field").hidden
			&& document.getElementById("output-text").value.length > 0,
		{ timeout: 120000 },
	);
	const customOutput = await page.inputValue("#output-text");
	if (!customOutput.includes("林檎") || customOutput.includes("エラーが発生しました")) {
		throw new Error("保存済み自作リストで変換できない: " + customOutput);
	}

	// 非選択行を編集しても、現在選択しているリストを維持する。
	await customTrigger.click();
	await customMenu.getByRole("menuitem", { name: "「名字」を編集" }).click();
	await page.fill("#original-name", "名字改");
	await page.click("#original-register");
	if (await customTrigger.locator("span:last-of-type").textContent() !== "食べ物") {
		throw new Error("非選択リストの編集後に現在選択が変わった");
	}

	// 行の削除はcancelでは残り、accept後も非選択削除なら現在選択を維持する。
	await customTrigger.click();
	page.once("dialog", (dialog) => dialog.dismiss());
	await customMenu.getByRole("menuitem", { name: "「名字改」を削除" }).click();
	if ((await page.evaluate(() => JSON.parse(localStorage.getItem(
		"soramimic-custom-wordlists")).lists.length)) !== 2) {
		throw new Error("削除確認cancelでリストが消えた");
	}
	page.once("dialog", (dialog) => dialog.accept());
	await customMenu.getByRole("menuitem", { name: "「名字改」を削除" }).click();
	if (await customTrigger.locator("span:last-of-type").textContent() !== "食べ物") {
		throw new Error("非選択リスト削除後に現在選択が変わった");
	}

	// 選択中行のごみ箱から削除した場合は、既定リストへ安全に戻る。
	await customTrigger.click();
	page.once("dialog", (dialog) => dialog.accept());
	await customMenu.getByRole("menuitem", { name: "「食べ物」を削除" }).click();
	const afterDelete = await page.evaluate(() => ({
		count: JSON.parse(localStorage.getItem("soramimic-custom-wordlists")).lists.length,
		active: document.querySelector("#wordlist-buttons button.active")?.dataset.value,
		triggerFocused: document.querySelector(".custom-wordlist-trigger") === document.activeElement,
	}));
	if (afterDelete.count !== 0 || afterDelete.active !== "BASEBALL" || !afterDelete.triggerFocused) {
		throw new Error("自作リスト削除後の状態が不正: " + JSON.stringify(afterDelete));
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
	const headerLayout = await firstFacet.locator(".facet-header").evaluate((header) => {
		const label = header.querySelector(".facet-label").getBoundingClientRect();
		const selectAll = header.querySelector(".facet-select-all").getBoundingClientRect();
		return {
			labelCenterY: label.top + label.height / 2,
			selectAllCenterY: selectAll.top + selectAll.height / 2,
			selectAllRight: selectAll.right,
			headerRight: header.getBoundingClientRect().right,
		};
	});
	if (Math.abs(headerLayout.labelCenterY - headerLayout.selectAllCenterY) > 1 ||
		Math.abs(headerLayout.headerRight - headerLayout.selectAllRight) > 1) {
		throw new Error("ファセットのすべて選択が見出し行の右端にない: " +
			JSON.stringify(headerLayout));
	}
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
