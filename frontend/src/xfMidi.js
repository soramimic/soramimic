// XF MIDI(カラオケ歌詞入りMIDI)から歌唱行(読みカナ)を抽出する。
// soramimic-video の xfparse.py と同じ解析方針のJS移植(秒変換は行わない):
//   - XFKMチャンクの歌詞イベント(`表記[かな` / `かな]` / `かな`、`/`=改行、`<`=改ページ)
//   - $Lyrcヘッダのメロディチャンネル(なければ歌詞と音符の一致率で自動判定)
//   - 歌詞イベントと音符開始tickのペアリング(1音符複数モーラは直前に結合)
// 歌詞テキストのエンコーディングはXF仕様のShift_JIS(TextDecoderで復号)。

const PAIRING_TOLERANCE_BEATS = 1 / 8;

// ---- バイナリ読み取り ----

class Reader {
	constructor(bytes, pos = 0, end = bytes.length) {
		this.bytes = bytes;
		this.pos = pos;
		this.end = end;
	}
	u8() {
		if (this.pos >= this.end) throw new Error("MIDIデータが途中で終わっています");
		return this.bytes[this.pos++];
	}
	u16() {
		return (this.u8() << 8) | this.u8();
	}
	u32() {
		return (this.u16() << 16 | this.u16()) >>> 0;
	}
	varint() {
		let value = 0;
		for (let i = 0; i < 4; i++) {
			const b = this.u8();
			value = (value << 7) | (b & 0x7f);
			if ((b & 0x80) === 0) break;
		}
		return value;
	}
	slice(length) {
		const out = this.bytes.subarray(this.pos, this.pos + length);
		this.pos += length;
		return out;
	}
}

// トラック状チャンク(MTrk/XFIH/XFKM)のイベントを列挙する
function readTrackEvents(bytes, start, size, onEvent) {
	const r = new Reader(bytes, start, start + size);
	let tick = 0;
	let lastStatus = null;
	while (r.pos < r.end) {
		tick += r.varint();
		let status = r.u8();
		let firstData = null;
		if (status < 0x80) {
			if (lastStatus === null) throw new Error("running statusの前に状態がありません");
			firstData = status;
			status = lastStatus;
		} else if (status !== 0xff) {
			lastStatus = status;
		}
		if (status === 0xff) {
			const type = r.u8();
			const data = r.slice(r.varint());
			onEvent({ tick, meta: type, data });
		} else if (status === 0xf0 || status === 0xf7) {
			r.slice(r.varint());
		} else {
			const kind = status & 0xf0;
			const channel = status & 0x0f;
			const d1 = firstData ?? r.u8();
			const d2 = kind === 0xc0 || kind === 0xd0 ? null : r.u8();
			if (kind === 0x90 || kind === 0x80) {
				onEvent({ tick, note: d1, velocity: d2, on: kind === 0x90 && d2 > 0, channel });
			}
		}
	}
}

// ---- 歌詞イベントの解釈 ----

// `/` `<` の行区切りを畳み込みつつ `表記[かな` 断片列をモーラ列にする
export function parseLyricEvents(events) {
	const result = [];
	let inBracket = false;
	let pendingBreak = false;
	for (const { tick, text: raw } of events) {
		let text = raw;
		while (text.startsWith("/") || text.startsWith("<")) {
			pendingBreak = true;
			text = text.slice(1);
		}
		if (!text) continue;
		let surface;
		let kana;
		if (inBracket) {
			surface = "";
			kana = text;
			if (kana.includes("]")) {
				kana = kana.split("]")[0];
				inBracket = false;
			}
		} else if (text.includes("[")) {
			[surface, kana] = [text.split("[")[0], text.split("[").slice(1).join("[")];
			if (kana.includes("]")) {
				kana = kana.split("]")[0];
			} else {
				inBracket = true;
			}
		} else {
			surface = text;
			kana = text;
		}
		result.push({ tick, raw, surface, kana, breakBefore: pendingBreak });
		pendingBreak = false;
	}
	return result;
}

function hiraToKata(text) {
	return text.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function normalizeKana(text) {
	return hiraToKata(text).replace(/[^ァ-ヺー]/g, "");
}

// ---- 本体 ----

// buffer: ArrayBuffer(.midファイルの中身)
// 戻り値: { lines: [{ surface, kana, moraCount }], noteCount, warnings }
export function parseXfMidi(buffer) {
	const bytes = new Uint8Array(buffer);
	const warnings = [];

	// ヘッダ
	const head = new Reader(bytes);
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== "MThd") {
		throw new Error("MIDIファイルではありません(MThdがありません)");
	}
	head.pos = 8;
	head.u16(); // format
	head.u16(); // ntrks(宣言数。XF拡張チャンクは含まれないため無視して全チャンクを走査)
	const division = head.u16();

	// 全チャンクを走査
	const decoder = new TextDecoder("shift_jis");
	const lyricEventsRaw = [];
	const cueTexts = [];
	const noteOns = new Map(); // channel -> tick[]
	let pos = 8 + 6;
	while (pos + 8 <= bytes.length) {
		const name = String.fromCharCode(...bytes.subarray(pos, pos + 4));
		const size = new Reader(bytes, pos + 4).u32();
		const bodyStart = pos + 8;
		if (name === "MTrk" || name === "XFIH" || name === "XFKM") {
			try {
				readTrackEvents(bytes, bodyStart, size, (ev) => {
					if (ev.meta === 0x05 && name === "XFKM") {
						lyricEventsRaw.push({ tick: ev.tick, text: decoder.decode(ev.data) });
					} else if (ev.meta === 0x07) {
						cueTexts.push(decoder.decode(ev.data));
					} else if (ev.on) {
						if (!noteOns.has(ev.channel)) noteOns.set(ev.channel, []);
						noteOns.get(ev.channel).push(ev.tick);
					}
				});
			} catch (err) {
				warnings.push(`チャンク${name}の解析を中断: ${err.message}`);
			}
		}
		pos = bodyStart + size;
	}

	if (lyricEventsRaw.length === 0) {
		throw new Error("XFカラオケ歌詞(XFKM)が見つかりません。XF形式のMIDIを指定してください");
	}
	const moras = parseLyricEvents(lyricEventsRaw);

	// メロディチャンネル: $Lyrc:<ch>:... を優先候補に、歌詞tickとの一致率で決める
	let headerChannel = null;
	for (const t of cueTexts) {
		const m = t.match(/^\$Lyrc:(\d+):/);
		if (m) headerChannel = Number(m[1]);
	}
	const tolerance = Math.max(1, Math.floor(division * PAIRING_TOLERANCE_BEATS));
	const score = (ch) => {
		const ticks = noteOns.get(ch);
		if (!ticks || moras.length === 0) return 0;
		const sorted = [...ticks].sort((a, b) => a - b);
		let hit = 0;
		for (const { tick } of moras) {
			let lo = 0;
			let hi = sorted.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (sorted[mid] < tick - tolerance) lo = mid + 1;
				else hi = mid;
			}
			if (lo < sorted.length && sorted[lo] <= tick + tolerance) hit++;
		}
		return hit / moras.length;
	};
	const candidates = [];
	if (headerChannel !== null) candidates.push(headerChannel - 1, headerChannel);
	candidates.push(...noteOns.keys());
	let melodyChannel = null;
	let best = -1;
	for (const ch of candidates) {
		if (!noteOns.has(ch)) continue;
		const s = score(ch);
		if (s > best) {
			melodyChannel = ch;
			best = s;
		}
		if (s >= 0.9) {
			melodyChannel = ch;
			break;
		}
	}
	if (melodyChannel === null) {
		throw new Error("メロディの音符が見つかりません");
	}

	// 歌詞イベント→音符のペアリング(最近傍、許容差内)。
	// 対応する音符がないモーラは直前のモーラに結合(1音符複数モーラ)
	const melodyTicks = [...noteOns.get(melodyChannel)].sort((a, b) => a - b);
	const used = new Set();
	const sung = []; // { surface, kana, breakBefore }
	let skipped = 0;
	for (const mora of moras) {
		let bestIdx = null;
		let bestDist = tolerance + 1;
		for (let i = 0; i < melodyTicks.length; i++) {
			if (used.has(i)) continue;
			const d = Math.abs(melodyTicks[i] - mora.tick);
			if (d < bestDist) {
				bestIdx = i;
				bestDist = d;
			}
		}
		if (bestIdx === null) {
			if (sung.length > 0 && !mora.breakBefore) {
				const prev = sung[sung.length - 1];
				prev.kana += mora.kana;
				prev.surface += mora.surface;
			} else {
				skipped++; // 改ページ直後のセクションラベル(「<間奏」等)
			}
			continue;
		}
		used.add(bestIdx);
		sung.push({ surface: mora.surface, kana: mora.kana, breakBefore: mora.breakBefore });
	}
	if (skipped > 0) warnings.push(`音符が対応しない歌詞${skipped}件をスキップしました`);

	// 行にまとめる
	const lines = [];
	let current = null;
	for (const mora of sung) {
		if (current === null || mora.breakBefore) {
			current = { surface: "", kana: "", moraCount: 0 };
			lines.push(current);
		}
		current.surface += mora.surface;
		current.kana += normalizeKana(mora.kana);
		current.moraCount += 1;
	}

	return { lines: lines.filter((l) => l.kana), noteCount: sung.length, warnings };
}
