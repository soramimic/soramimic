// テスト用のXF MIDIフィクスチャ合成(最小限のSMFライタ)。
// 著作権のある実MIDIを使わずにMIDI取り込みを検証するための共有ヘルパ。
// tests/xfmidi.mjs(ユニット)と frontend/tests/smoke.mjs(E2E)から使う。

export function varint(value) {
	const out = [value & 0x7f];
	while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
	return out;
}

export function u32(value) {
	return [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
}

export function chunk(name, body) {
	return [...[...name].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body];
}

export function meta(delta, type, data) {
	return [...varint(delta), 0xff, type, ...varint(data.length), ...data];
}

export function noteOn(delta, channel, note) {
	return [...varint(delta), 0x90 | channel, note, 100];
}

export function noteOff(delta, channel, note) {
	return [...varint(delta), 0x80 | channel, note, 64];
}

// Shift_JISのバイト列(TextEncoderはUTF-8しか書けないため事前計算した定数)
export const SJIS = {
	header: [0x24, 0x4c, 0x79, 0x72, 0x63, 0x3a, 0x31, 0x3a, 0x30, 0x3a, 0x4a, 0x50], // $Lyrc:1:0:JP
	"沈[し": [0x92, 0xbe, 0x5b, 0x82, 0xb5],
	"ず]": [0x82, 0xb8, 0x5d],
	"む": [0x82, 0xde],
	"/と": [0x2f, 0x82, 0xc6],
	"け": [0x82, 0xaf],
	"<間奏": [0x3c, 0x8a, 0xd4, 0x91, 0x74],
};

// 「沈[しず]む / とけ」を歌うXF MIDI(メロディch0・伴奏ch1・セクションラベル付き)
export function buildXfMidi() {
	const track = [
		...meta(0, 0x51, [0x07, 0xa1, 0x20]), // tempo 500000
		...noteOn(480, 0, 60), ...noteOff(240, 0, 60),
		...noteOn(0, 1, 40), // 伴奏
		...noteOn(0, 0, 62), ...noteOff(240, 0, 62),
		...noteOff(0, 1, 40),
		...noteOn(0, 0, 64), ...noteOff(240, 0, 64),
		...noteOn(240, 0, 65), ...noteOff(240, 0, 65),
		...noteOn(0, 0, 67), ...noteOff(240, 0, 67),
		...meta(0, 0x2f, []),
	];
	const xfih = [...meta(0, 0x07, [0x24, 0x58]), ...meta(0, 0x2f, [])]; // ダミーヘッダ
	const xfkm = [
		...meta(0, 0x07, SJIS.header),
		...meta(480, 0x05, SJIS["沈[し"]),
		...meta(240, 0x05, SJIS["ず]"]),
		...meta(240, 0x05, SJIS["む"]),
		...meta(480, 0x05, SJIS["/と"]),
		...meta(240, 0x05, SJIS["け"]),
		...meta(240, 0x05, SJIS["<間奏"]),
		...meta(0, 0x2f, []),
	];
	const bytes = [
		...chunk("MThd", [0, 1, 0, 1, 0x01, 0xe0]), // format1, 1track, 480tpb
		...chunk("MTrk", track),
		...chunk("XFIH", xfih),
		...chunk("XFKM", xfkm),
	];
	return new Uint8Array(bytes);
}
