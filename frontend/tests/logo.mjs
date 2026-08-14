import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

for (const file of ["index.html", "editor.html"]) {
	const html = await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8");
	assert.match(html, /<link rel="icon" type="image\/png" href="\/logo-soramimic-symbol-v4\.png" \/>/);
	assert.match(html, /<link rel="apple-touch-icon" href="\/logo-soramimic-symbol-v4\.png" \/>/);
	assert.match(html, /<img class="brand-logo"\s+src="\/logo-soramimic-horizontal-v3\.png" width="1900" height="467"/);
	assert.match(html, /<span class="visually-hidden">Soramimic<\/span>/);
}

for (const [file, width, height, sha256] of [
	["logo-soramimic-symbol-v4.png", 512, 512, "42101a49907d7f25495b8f6b672b659cae73e1bc0c57ba96c418554f1f244418"],
	["logo-soramimic-horizontal-v3.png", 1900, 467, "1abf8461b6db03f4658554f49c02321891fdad049335f95163edebc4455cd0a9"],
]) {
	const logo = await readFile(new URL(`../dist/${file}`, import.meta.url));
	assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
	assert.equal(logo.readUInt32BE(16), width, `${file} width`);
	assert.equal(logo.readUInt32BE(20), height, `${file} height`);
	assert.equal(createHash("sha256").update(logo).digest("hex"), sha256, `${file} content`);
}

console.log("[ok] logo test passed");
