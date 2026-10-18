// XF MIDI取り込み(frontend/src/xfMidi.js)のテスト。
// 実行: node tests/xfmidi.mjs
// 著作権のある実MIDIは使わず、XF風のバイト列を合成して検証する。
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildXfMidi, buildLyricMidi, chunk, meta } from "./xfmidi-fixture.mjs";

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

// ---- 音符に対応する歌詞が無いMIDIはエラー ----
{
	const bytes = new Uint8Array([
		...chunk("MThd", [0, 1, 0, 1, 0x01, 0xe0]),
		...chunk("MTrk", [...meta(0, 0x2f, [])]),
	]).buffer;
	assert.throws(() => parseXfMidi(bytes), /音符に対応する歌詞/);
	print("[ok] parseXfMidi: 歌詞なしはエラー");
}



// Videoと同じUTF-8歌詞、別トラックの歌詞、SMF type 0。
for (const format of [0, 1]) {
 for (const separate of [false, true]) {
  const result = parseXfMidi(buildLyricMidi({format, separate}).buffer);
  assert.deepEqual(result.lines.map(line => line.kana), ["ハル", "ナツ"]);
  assert.equal(result.noteCount, 4);
  assert.deepEqual(result.warnings, []);
 }
}

// UTF-8以外の従来の日本語MIDIも読める(Shift_JIS: は・る・な・つ)。
{
 const bytes = [[0, [0x82, 0xcd]], [240, [0x82, 0xe9]],
                [960, [0x0a, 0x82, 0xc8]], [1200, [0x82, 0xc2]]];
 const result = parseXfMidi(buildLyricMidi({lyrics: bytes}).buffer);
 assert.deepEqual(result.lines.map(line => line.kana), ["ハル", "ナツ"]);
}

// 改行が歌詞の前・後・単独のイベントでも同じ行に戻る。
for (const marker of ["\r", "\n", "\r\n", "/", "\\"]) {
 for (const position of ["leading", "trailing", "standalone"]) {
  const lyrics = [[0, "は"], [240, "る"], [960, "な"], [1200, "つ"]];
  if (position === "leading") lyrics[2][1] = marker + "な";
  else if (position === "trailing") lyrics[1][1] += marker;
  else lyrics.splice(2, 0, [480, marker]);
  assert.deepEqual(parseXfMidi(buildLyricMidi({lyrics}).buffer).lines.map(line => line.kana),
                   ["ハル", "ナツ"]);
 }
}

// 複数の旋律・歌詞を連結しない。同じチャンネルの別トラックも区別する。
{
 const melody = buildLyricMidi();
 const harmony = buildLyricMidi({lyrics: [[0, "あ"], [240, "い"], [960, "う"], [1200, "え"]]});
 const combined = new Uint8Array([
  ...chunk("MThd", [0, 1, 0, 2, 0x01, 0xe0]), ...melody.slice(14), ...harmony.slice(14),
 ]);
 assert.deepEqual(parseXfMidi(combined.buffer).lines.map(line => line.kana), ["ハル", "ナツ"]);
 assert.equal(parseXfMidi(combined.buffer).noteCount, 4);
}

// XFと標準歌詞が併存するときは、従来どおりXFのルビを優先する。
{
 const standard = buildLyricMidi();
 const xf = buildXfMidi();
 const combined = new Uint8Array([
  ...chunk("MThd", [0, 1, 0, 2, 0x01, 0xe0]), ...xf.slice(14), ...standard.slice(14),
 ]);
 const parsed = parseXfMidi(combined.buffer);
 assert.deepEqual(parsed.lines.map(line => line.kana), ["シズム", "トケ"]);
 assert.equal(parsed.noteCount, 5);
}

// 別トラックの歌詞がchannel prefixを指定している場合は、それを守る。
assert.equal(parseXfMidi(buildLyricMidi({channel: 3, separate: true, channelPrefix: 3}).buffer).noteCount, 4);
assert.throws(() => parseXfMidi(buildLyricMidi({channel: 3, separate: true, channelPrefix: 4}).buffer), /音符に対応する歌詞/);

// 歌詞があるだけでなく、対応する音符が必要。
assert.throws(() => parseXfMidi(buildLyricMidi({lyrics: [[9000, "はる"]]}).buffer), /音符に対応する歌詞/);
print("歌詞入りMIDI取り込み: XF・標準の全テスト通過");
