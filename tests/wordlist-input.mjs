import assert from "node:assert";
import { originalTextToCsv } from "../frontend/src/wordlistInput.js";

const app = {
	textAnalyzer: {
		getYomi(words) {
			const readings = new Map([
				["アルバニア", "アルバニア"],
				["日本", "ニホン"],
			]);
			return words.map((word) => readings.get(word) || "");
		},
	},
};

// 公開の nations.csv と同じ多列形式。URLや説明文を「読みの候補」として
// 展開せず、1レコードを1単語として扱うことを固定する。
const nations = [
	"id,original,surface,pronunciation,status,image,image_page,wikidata,capital,continent,population,area_km2,established_year,description,ended_year,population_year",
	"1,アルバニア,アルバニア,,current,https://example.com/flag.svg,https://example.com/page,Q222,ティラナ,ヨーロッパ,2811655,28748,1912,東南ヨーロッパに位置する国家。,,2023",
	"2,日本国,日本,ニホン,current,https://example.com/jp.svg,https://example.com/jp,Q17,東京,アジア,123802000,377975,1947,東アジアに位置する島国。,,2024",
].join("\n");

const normalized = originalTextToCsv(nations, app);
const rows = normalized.split("\n");
assert.strictEqual(rows.length, 3, "多列CSVの各セルを別の読みとして展開している");
assert.ok(rows[0].includes("pronunciation"), "読み列が保持されない");
assert.ok(!rows[0].includes("image"), "画像URL列を正規化後も保持している");
assert.ok(rows[1].includes("アルバニア"), "読みなし行を正規化できない");
assert.ok(rows[2].includes("ニホン"), "指定された読みを保持できない");

// 従来の簡単形式も引き続き受け付ける。
assert.strictEqual(
	originalTextToCsv("林檎,リンゴ\n寿司,スシ", app).split("\n").length,
	3,
);

process.stdout.write("[ok] custom wordlist input normalization\n");
