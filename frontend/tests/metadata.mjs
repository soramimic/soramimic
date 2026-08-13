import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = {
	"index.html": {
		title: "Soramimic（ソラミミック）｜空耳歌詞を自動生成",
		description: "好きな歌詞を、野球選手名・ポケモン・駅名などの言葉で再現。「○○で歌ってみた」風の空耳歌詞・替え歌を自動生成できるWebツールです。",
		url: "https://soramimic.com/",
	},
	"editor.html": {
		title: "Soramimic 編集ツール｜空耳歌詞を思いどおりに仕上げる",
		description: "Soramimicで作った空耳歌詞・替え歌を、候補の差し替えや読みの調整で思いどおりに仕上げる編集ツールです。",
		url: "https://soramimic.com/editor.html",
	},
};

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertOnce(html, pattern, label) {
	const matches = html.match(new RegExp(pattern, "g")) ?? [];
	assert.equal(matches.length, 1, `${label} must occur exactly once`);
}

for (const [file, metadata] of Object.entries(expected)) {
	const html = await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8");
	assertOnce(html, `<title>${escapeRegExp(metadata.title)}</title>`, `${file} title`);
	assertOnce(html, `<meta name="description" content="${escapeRegExp(metadata.description)}" ?/?>`, `${file} description`);
	assertOnce(html, `<link rel="canonical" href="${escapeRegExp(metadata.url)}" ?/?>`, `${file} canonical`);
	assertOnce(html, '<link rel="icon" type="image/png" href="/logo-soramimic-symbol-v4\\.png" ?/?>', `${file} favicon`);
	assertOnce(html, '<link rel="apple-touch-icon" href="/logo-soramimic-symbol-v4\\.png" ?/?>', `${file} apple touch icon`);
	assertOnce(html, '<img class="brand-logo"\\s+src="/logo-soramimic-horizontal-v2\\.png"', `${file} brand logo`);
	assertOnce(html, `<meta property="og:title" content="${escapeRegExp(metadata.title)}" ?/?>`, `${file} og:title`);
	assertOnce(html, `<meta property="og:description" content="${escapeRegExp(metadata.description)}" ?/?>`, `${file} og:description`);
	assertOnce(html, `<meta property="og:url" content="${escapeRegExp(metadata.url)}" ?/?>`, `${file} og:url`);
	assertOnce(html, '<meta property="og:image" content="https://soramimic\\.com/og-image\\.png" ?/?>', `${file} og:image`);
	assertOnce(html, '<meta name="twitter:card" content="summary_large_image" ?/?>', `${file} twitter:card`);
	assertOnce(html, '<meta name="twitter:image" content="https://soramimic\\.com/og-image\\.png" ?/?>', `${file} twitter:image`);
}

const image = await readFile(new URL("../dist/og-image.png", import.meta.url));
assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "OG image must be a PNG");
assert.equal(image.readUInt32BE(16), 1200, "OG image width");
assert.equal(image.readUInt32BE(20), 630, "OG image height");

for (const [file, width, height, sha256] of [
	["logo-soramimic-symbol-v4.png", 512, 512, "42101a49907d7f25495b8f6b672b659cae73e1bc0c57ba96c418554f1f244418"],
	["logo-soramimic-horizontal-v2.png", 1899, 466, "79eeb3734a198f392132523797425fdfd901227131d8c0c1f2b7ad1526c7630b"],
]) {
	const logo = await readFile(new URL(`../dist/${file}`, import.meta.url));
	assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
	assert.equal(logo.readUInt32BE(16), width, `${file} width`);
	assert.equal(logo.readUInt32BE(20), height, `${file} height`);
	assert.equal(createHash("sha256").update(logo).digest("hex"), sha256, `${file} content`);
}

console.log("[ok] social metadata test passed");
