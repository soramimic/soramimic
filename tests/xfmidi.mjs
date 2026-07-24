// XF MIDI取り込み(frontend/src/xfMidi.js)のテスト。
// 実行: node tests/xfmidi.mjs
// 著作権のある実MIDIは使わず、XF風のバイト列を合成して検証する。
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildXfMidi, chunk, meta } from "./xfmidi-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseXfMidi, parseLyricEvents } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/xfMidi.js")).href);

const print = console.log.bind(console);

// ---- parseLyricEvents ----
{
	const moras = parseLyricEvents([
		{ tick: 0, text: "<" },
		{ tick: 0, text: "沈[し" },
		{ tick: 240, text: "ず]" },
		{ tick: 480, text: "む" },
		{ tick: 720, text: "/と" },
		{ tick: 960, text: "け" },
	]);
	assert.deepEqual(moras.map((m) => [m.surface, m.kana]), [
		["沈", "し"], ["", "ず"], ["む", "む"], ["と", "と"], ["け", "け"],
	]);
	assert.equal(moras[0].breakBefore, true);
	assert.equal(moras[3].breakBefore, true);
	assert.equal(moras[1].breakBefore, false);
	print("[ok] parseLyricEvents: 括弧の分割と行区切り");
}

// ---- parseXfMidi ----
{
	const { lines, noteCount, warnings } = parseXfMidi(buildXfMidi().buffer);
	assert.deepEqual(lines.map((l) => l.kana), ["シズム", "トケ"]);
	assert.deepEqual(lines.map((l) => l.surface), ["沈む", "とけ"]);
	assert.equal(noteCount, 5);
	// セクションラベル「<間奏」は音符が無いのでスキップされる
	assert.ok(warnings.some((w) => w.includes("スキップ")), "スキップ警告が出ること");
	print("[ok] parseXfMidi: 行分割・カナ正規化・ラベルのスキップ");
}

// ---- XFKMが無いMIDIはエラー ----
{
	const bytes = new Uint8Array([
		...chunk("MThd", [0, 1, 0, 1, 0x01, 0xe0]),
		...chunk("MTrk", [...meta(0, 0x2f, [])]),
	]).buffer;
	assert.throws(() => parseXfMidi(bytes), /XFカラオケ歌詞/);
	print("[ok] parseXfMidi: XFKMなしはエラー");
}

print("XF MIDI取り込み: 全テスト通過");
