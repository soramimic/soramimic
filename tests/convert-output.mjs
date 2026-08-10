import assert from "node:assert/strict";
import { makeResultText } from "../frontend/src/convert.js";

const result = [
	[
		{ surface: "ルーペ", kana: "ルーペ", original_surface: "夢", originalkana: "ユメ", original: "ルーペ" },
		{ surface: "速さ", kana: "ハヤサ", original_surface: "ならば", originalkana: "ナラバ", original: "速さ" },
		{ surface: "モル濃度", kana: "モルノウド", original_surface: "どれほど", originalkana: "ドレホド", original: "モル濃度" },
	],
	[
		{ surface: "ろ過", kana: "ロカ", original_surface: "良かっ", originalkana: "ヨカッ", original: "ろ過" },
		{ surface: "楕円", kana: "ダエン", original_surface: "たで", originalkana: "タデ", original: "楕円" },
		{ surface: "商", kana: "ショウ", original_surface: "しょう", originalkana: "ショー", original: "商" },
	],
];

assert.equal(
	makeResultText(result, "4"),
	[
		"ルーペ  速さ  モル濃度",
		"ゆめ  ならば  どれほど",
		"",
		"ろ過  楕円  商",
		"よかっ  たで  しょう",
		"",
	].join("\n"),
	"既定形式は替え歌と元歌詞ひらがなを同じ境界で区切る",
);

// 従来形式の意味は保存済み設定との互換性のため維持する。
assert.equal(
	makeResultText([result[0]], "1"),
	"ルーペ  速さ  モル濃度\n夢ならばどれほど\n",
);
assert.equal(
	makeResultText([[
		{ surface: "ユメハ", original_surface: "夢は", originalkana: "ユメワ" },
		{ surface: "コキョウ", original_surface: "故郷", originalkana: "コキョー" },
	]], "4"),
	"ユメハ  コキョウ\nゆめは  こきょー\n",
	"元表記の助詞は保ち、漢字だけの区間は読みで補う",
);
assert.equal(
	makeResultText([result[0]], "2"),
	"ルーペ/ハヤサ/モルノウド\nユメ/ナラバ/ドレホド\n",
);
assert.equal(
	makeResultText([result[0]], "3"),
	"夢/ならば/どれほど\nユメ/ナラバ/ドレホド\nルーペ/速さ/モル濃度\nルーペ/ハヤサ/モルノウド\nルーペ/速さ/モル濃度\n",
);

console.log("出力形式: 全テスト通過");
