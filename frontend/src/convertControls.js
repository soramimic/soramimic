// 変換の設定UI(パラメータ・単語重複・ファセット絞り込み)の共有部品。
// 生成画面(app.js)と編集ツール(editor.js)の両方から使うため、
// DOMのidには依存せずコンテナ要素を引数で受け取って中身を組み立てる。

// 単一選択のボタングループ
export function setupButtonGroup(container, onChange) {
	container.addEventListener("click", (e) => {
		const btn = e.target.closest("button");
		if (!btn) return;
		for (const b of container.querySelectorAll("button")) {
			b.classList.toggle("active", b === btn);
		}
		if (onChange) onChange(btn);
	});
}

export function activeValue(container) {
	const btn = container.querySelector("button.active");
	return btn ? btn.dataset.value : null;
}

// 両端ラベル付きスライダーの1項目を作る(「音の合わせ方」「文節の区切り」「単語の長さ」で共通)。
// val() は生のスライダー値(数値)を返す。ペナルティへの写像は paramFromValues() が行う。
export function createSliderItem({ label, leftText, rightText, min, max, step, defaultValue, ariaLabel }) {
	const item = document.createElement("div");
	item.className = "param-item param-item-wide";
	const title = document.createElement("h4");
	title.className = "field-label";
	title.textContent = label;
	const row = document.createElement("div");
	row.className = "slider-row";
	const left = document.createElement("span");
	left.className = "slider-end";
	left.textContent = leftText;
	const right = document.createElement("span");
	right.className = "slider-end";
	right.textContent = rightText;
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.value = String(defaultValue);
	slider.setAttribute("aria-label", ariaLabel || label);
	row.append(left, slider, right);
	item.append(title, row);
	return {
		element: item,
		val: () => Number(slider.value),
		set: (value) => { slider.value = String(value); },
	};
}

// プリセット: ワンタップで詳細設定(スライダー)へ値を流し込む。
// 全プリセット r=0.8(母音ロック)固定で、文節・単語長の強さだけ変える(#102):
//   バランス   MID20(文節1)/WNP20(音そっくりと文節重視の中間、既定)
//   音そっくり MID0/WNP0(音韻マックス)
//   文節重視   MID160(文節8=スライダー最大・実測の飽和点)/WNP20
//   長い単語   MID20(文節1)/WNP60(スライダー最大)
export const PRESETS = [
	{ name: "バランス", sound: 0.8, phrase: 1, wordnum: 2 },
	{ name: "音そっくり", sound: 0.8, phrase: 0, wordnum: 0 },
	{ name: "文節重視", sound: 0.8, phrase: 8, wordnum: 2 },
	{ name: "長い単語", sound: 0.8, phrase: 1, wordnum: 6 },
];

// スライダー値の既定(= バランス プリセット + 単語重複なし)
export const DEFAULT_VALUES = { sound: 0.8, phrase: 1, wordnum: 2, duplicate: false };

// UIのスライダー値 → エンジンに渡すパラメータ。
// SAME_VOWEL/CONSONANT_REWARD は撤廃(#102)。母音ロックは類似度行列自体が
// monophoneタイブレーク方式になったことで表現され、掛け算ハックは不要。
// 未指定なのでlib既定(=1、無効化)のまま。母音/子音の重みは VOWEL_RATIO で調整する。
export function paramFromValues(values) {
	const v = Object.assign({}, DEFAULT_VALUES, values);
	return {
		VOWEL_RATIO: v.sound,
		// ン/ッ/ーの1変換操作コスト。母音準一致セル(名目20)相当を実効値として
		// vowelRatio(=r)に連動させる(実効=20×r。行列は母音側が2r倍される)。#105
		VARIATION_COST: 20 * Number(v.sound),
		// 文節つまみは「境界一致への報酬」ではなく「文節内で切ることへの
		// ペナルティ」に写像する(#98)。報酬方式は30で飽和し、文節内分割を
		// 抑止できなかったため置き換え。係数は×20(UI0〜8→内部0〜160)。
		// MIDスイープ実測でMID=160が3入力とも文節内切断ゼロの飽和点・線形応答
		// (1ステップ=編集距離1.25操作分)。旧×5(上限40)では文節重視でも切断が残った
		SAME_PHRASE_BREAK_REWARD: 0,
		MID_PHRASE_BREAK_PENALTY: v.phrase * 20,
		WORD_NUMBER_PENALTY: v.wordnum * 10,
		DUPLICATE: v.duplicate === true || v.duplicate === "true",
	};
}

// paramFromValues の逆写像。既存パラメータ(編集ツールが引き継いだもの等)から
// スライダーの初期値を復元する。スライダーの刻みに合わせて丸め・クランプする
export function valuesFromParam(param) {
	const p = param || {};
	const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
	const num = (v, fallback) => (typeof v === "number" && isFinite(v) ? v : fallback);
	return {
		sound: clamp(Math.round(num(p.VOWEL_RATIO, DEFAULT_VALUES.sound) * 10) / 10, 0.1, 0.9),
		phrase: clamp(Math.round(num(p.MID_PHRASE_BREAK_PENALTY, DEFAULT_VALUES.phrase * 20) / 20), 0, 8),
		wordnum: clamp(Math.round(num(p.WORD_NUMBER_PENALTY, DEFAULT_VALUES.wordnum * 10) / 10), 0, 6),
		duplicate: p.DUPLICATE === true,
	};
}

// パラメータUI(プリセット + スライダー3本 + 単語重複)をコンテナへ組み立てる。
// - paramArea / presetArea は必須。duplicateArea は省略可(省略時 DUPLICATE=false 固定)
// - duplicateArea が空なら「あり/なし」ボタンをここで作る(HTMLに置いてあればそれを使う)
// - onChange(kind, detail) の kind は "preset" | "param" | "duplicate"
export function createParamControls({ paramArea, presetArea, duplicateArea, values, onChange }) {
	const notify = (kind, detail) => { if (onChange) onChange(kind, detail); };

	// パラメータUIの再設計(#21 → #102)。monophoneタイブレーク行列(#102)に基づく:
	// - 「音の合わせ方」= vowelRatio(r)。行列がコア音素タイブレーク方式になったので、
	//   rは純粋な母音/子音の重み。既定 r=0.8 で「母音ロック・子音タイブレーク」、
	//   左に振ると子音ロックへ滑らかに移る
	// - 文節・単語長は3択トグルではなくスライダー。内部ペナルティは線形
	const iptSound = createSliderItem({
		label: "音の合わせ方", leftText: "子音重視", rightText: "母音重視",
		min: 0.1, max: 0.9, step: 0.1, defaultValue: DEFAULT_VALUES.sound,
		ariaLabel: "音の合わせ方(子音重視〜母音重視)",
	});
	const iptPhrasebreak = createSliderItem({
		label: "文節の区切り", leftText: "無視", rightText: "がっちり守る",
		min: 0, max: 8, step: 1, defaultValue: DEFAULT_VALUES.phrase,
		ariaLabel: "文節の区切り(無視〜がっちり守る)",
	});
	const iptWordnum = createSliderItem({
		label: "単語の長さ", leftText: "細かめ", rightText: "長め",
		min: 0, max: 6, step: 1, defaultValue: DEFAULT_VALUES.wordnum,
		ariaLabel: "単語の長さ(細かめ〜長め)",
	});
	for (const p of [iptSound, iptPhrasebreak, iptWordnum]) {
		paramArea.appendChild(p.element);
	}

	if (duplicateArea) {
		if (duplicateArea.querySelector("button") === null) {
			for (const d of [{ v: "true", text: "あり" }, { v: "false", text: "なし" }]) {
				const btn = document.createElement("button");
				btn.className = "btn" + (d.v === "false" ? " active" : "");
				btn.dataset.value = d.v;
				btn.textContent = d.text;
				duplicateArea.appendChild(btn);
			}
		}
		setupButtonGroup(duplicateArea, () => notify("duplicate"));
	}

	for (const preset of PRESETS) {
		const btn = document.createElement("button");
		btn.className = "btn";
		btn.textContent = preset.name;
		btn.__preset = preset;
		presetArea.appendChild(btn);
	}

	function applyPreset(p) {
		iptSound.set(p.sound);
		iptPhrasebreak.set(p.phrase);
		iptWordnum.set(p.wordnum);
	}

	// 詳細設定を手で触ったらプリセットの選択表示を外す(値はカスタム扱い)
	function clearPresetSelection() {
		for (const b of presetArea.querySelectorAll("button")) {
			b.classList.remove("active");
		}
	}

	// 名前でプリセットを選択状態にする(null で全解除)
	function setPreset(name) {
		for (const b of presetArea.querySelectorAll("button")) {
			b.classList.toggle("active", b.textContent === name);
		}
	}

	function getValues() {
		return {
			sound: iptSound.val(),
			phrase: iptPhrasebreak.val(),
			wordnum: iptWordnum.val(),
			duplicate: duplicateArea ? activeValue(duplicateArea) === "true" : false,
		};
	}

	// 与えられたキーだけ反映する(欠けているキーは現状維持)
	function setValues(v) {
		if (!v) return;
		if (typeof v.sound === "number") iptSound.set(v.sound);
		if (typeof v.phrase === "number") iptPhrasebreak.set(v.phrase);
		if (typeof v.wordnum === "number") iptWordnum.set(v.wordnum);
		if (duplicateArea && v.duplicate !== undefined) {
			const want = String(v.duplicate);
			for (const b of duplicateArea.querySelectorAll("button")) {
				b.classList.toggle("active", b.dataset.value === want);
			}
		}
	}

	// いまのスライダー値に一致するプリセット名(なければ null)
	function matchedPresetName() {
		const v = getValues();
		const hit = PRESETS.find((p) =>
			p.sound === v.sound && p.phrase === v.phrase && p.wordnum === v.wordnum);
		return hit ? hit.name : null;
	}

	setupButtonGroup(presetArea, (btn) => {
		applyPreset(btn.__preset);
		notify("preset", btn.__preset);
	});
	paramArea.addEventListener("click", (e) => {
		if (e.target.closest("button")) { clearPresetSelection(); notify("param"); }
	});
	paramArea.addEventListener("input", () => { clearPresetSelection(); notify("param"); });

	setValues(Object.assign({}, DEFAULT_VALUES, values));
	setPreset(matchedPresetName()); // 既定(バランス)や引き継ぎ値が一致すれば点灯

	return {
		getValues,
		setValues,
		getParam: () => paramFromValues(getValues()),
		applyPreset,
		setPreset,
		clearPresetSelection,
		matchedPresetName,
		// 現在の値からプリセットの点灯状態を引き直す(undo等でまとめて値を戻したとき用)
		syncPreset: () => setPreset(matchedPresetName()),
		activePresetName: () => {
			const btn = presetArea.querySelector("button.active");
			return btn ? btn.textContent : null;
		},
	};
}

// ---- ファセット絞り込み ----

// facet の1つの選択肢を where 断片に変換する。設定で述語を定義できる:
// - item.where があればそれをそのまま使う(任意の述語。SQL 的な自由度)
// - facet.columns(配列)があれば全列の or に展開する
//   (例: {columns:["type1","type2"]} で炎チェック→ type1=ほのお or type2=ほのお)
// - どちらも無ければ facet.column=値(従来互換)
export function facetClause(f, item) {
	if (item.where) return item.where;
	const cols = f.columns || [f.column];
	return "(" + cols.map((c) => `${c}=${item.v}`).join(" or ") + ")";
}

// 単語リストエントリがファセット絞り込みを持つか
export function hasFacets(entry) {
	return !!(entry && Array.isArray(entry.facets) && entry.facets.length > 0);
}

// 選択中リストの facets(絞り込みチェックボックス)を container に描画する
export function renderFacets(container, entry) {
	container.innerHTML = "";
	const facets = (entry && entry.facets) || [];
	for (const f of facets) {
		const group = document.createElement("div");
		group.className = "facet-group";
		const label = document.createElement("span");
		label.className = "facet-label";
		label.textContent = f.label || f.column || "";
		group.appendChild(label);
		const actions = document.createElement("span");
		actions.className = "facet-actions";
		for (const [text, checked] of [["全チェック", true], ["全はずし", false]]) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "facet-action";
			button.textContent = text;
			button.setAttribute("aria-label", `${label.textContent}を${text}`);
			button.addEventListener("click", () => {
				for (const cb of group.querySelectorAll('input[type="checkbox"]')) {
					cb.checked = checked;
				}
			});
			actions.appendChild(button);
		}
		group.appendChild(actions);
		// default 指定がない facet は未チェックでも全選択扱いになるため、
		// 同じ意味を保ったまま初期表示だけ分かりやすく全チェックにする。
		const hasDefault = f.values.some((item) => item.default === true);
		for (const item of f.values) {
			const lbl = document.createElement("label");
			lbl.className = "facet-check";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.value = item.v;
			cb.checked = !hasDefault || item.default === true;
			// 各選択肢が担う where 断片を要素に持たせる(単一列に限らない)
			cb.__where = facetClause(f, item);
			lbl.append(cb, document.createTextNode(item.label || item.v));
			group.appendChild(lbl);
		}
		container.appendChild(group);
	}
}

// 現在のチェック状態を where 文字列にコンパイルする。
// 同一 facet 内は or、facet をまたぐと and。未チェックの facet は制約なし。
// 各選択肢の断片は facetClause() が決める(column= / columns の or / 任意の where)。
// facets 未定義のエントリは従来どおり entry.where を返す。
export function compileWhere(container, entry) {
	const facets = (entry && entry.facets) || [];
	if (facets.length === 0) return entry ? entry.where : undefined;
	const clauses = [];
	for (const group of container.querySelectorAll(".facet-group")) {
		const frags = [...group.querySelectorAll("input:checked")]
			.map((cb) => cb.__where);
		if (frags.length === 0) continue; // 制約なし
		clauses.push("(" + frags.join(" or ") + ")");
	}
	return clauses.join(" and ");
}

// where 文字列の中に断片がそのまま(区切りで挟まれた形で)現れるか。
// "field~=物理" が "field~=物理学" の一部にマッチしてしまうのを避ける
function containsFragment(where, frag) {
	for (let i = where.indexOf(frag); i >= 0; i = where.indexOf(frag, i + 1)) {
		const before = where.slice(0, i);
		const after = where.slice(i + frag.length);
		const okBefore = before === "" || before.endsWith("(") ||
			before.endsWith(" or ") || before.endsWith(" and ");
		const okAfter = after === "" || after.startsWith(")") ||
			after.startsWith(" or ") || after.startsWith(" and ");
		if (okBefore && okAfter) return true;
	}
	return false;
}

// compileWhere が作った where 文字列からチェック状態を復元する
// (編集ツールが生成時の絞り込みを引き継ぐ用)。where が文字列でなければ
// renderFacets の既定(default:true)のまま何もしない
export function restoreFacets(container, where) {
	if (typeof where !== "string") return;
	for (const cb of container.querySelectorAll("input[type=checkbox]")) {
		cb.checked = containsFragment(where, cb.__where);
	}
}
