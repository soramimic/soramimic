import assert from "node:assert/strict";
import {
	readCustomWordlistFile,
	countCustomWordlistRows,
	wordlistNameFromFilename,
	CUSTOM_WORDLIST_FILE_MAX_BYTES,
} from "../frontend/src/customWordlistFile.js";

function fakeFile(name, bytes, size = bytes.byteLength) {
	return {
		name,
		size,
		arrayBuffer: async () => bytes.buffer.slice(
			bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

const utf8Text = "surface,pronunciation\n林檎,リンゴ\n蜜柑,ミカン\n";
const utf8 = new TextEncoder().encode(utf8Text);
const loaded = await readCustomWordlistFile(fakeFile("果物.csv", utf8));
assert.equal(loaded.text, utf8Text);
assert.equal(loaded.rows, 2);
assert.equal(loaded.name, "果物");

// CP932/Shift_JISの「あ」(82 A0)をUTF-8失敗後のフォールバックで読める。
const sjis = await readCustomWordlistFile(fakeFile("かな.TXT", Uint8Array.from([0x82, 0xa0])));
assert.equal(sjis.text, "あ");
assert.equal(sjis.rows, 1);
assert.equal(sjis.name, "かな");

assert.equal(countCustomWordlistRows("# comment\n\n猫,ネコ\n犬,イヌ"), 2);
assert.equal(countCustomWordlistRows("語,ゴ,カタリ\n犬,イヌ"), 3,
	"plainの複数読みを正規化後の行数で数えること");
assert.equal(wordlistNameFromFilename("my.words.csv"), "my.words");
await assert.rejects(
	readCustomWordlistFile(fakeFile("empty.txt", new Uint8Array())), /単語が入っていません/);
await assert.rejects(
	readCustomWordlistFile(fakeFile("large.csv", new Uint8Array(), CUSTOM_WORDLIST_FILE_MAX_BYTES + 1)),
	/10MB/);
const tooMany = new TextEncoder().encode(Array.from({ length: 10001 }, () => "語").join("\n"));
await assert.rejects(readCustomWordlistFile(fakeFile("many.txt", tooMany)), /10,000行/);

console.log("[ok] custom wordlist file tests passed");
