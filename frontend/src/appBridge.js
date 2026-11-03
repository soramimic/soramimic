// Shared wire protocol with Soramimic Video. No lyrics or credentials in URLs.
(() => {
	const TYPE = "soramimic:lyrics-transfer/1";
	const PARAM = "lyrics-transfer";
	const MAX_BYTES = 4 * 1024 * 1024;
	const TIMEOUT = 5 * 60 * 1000;
	const PAIRS = [
		["https://dev.soramimic.pages.dev", "https://dev-video.soramimic.com"],
		["https://preview.soramimic.pages.dev", "https://preview-video.soramimic.com"],
		["https://soramimic.com", "https://video.soramimic.com"],
	];
	function peer(app, override = "") {
		const pair = PAIRS.find((p) => p.includes(location.origin));
		const value = override || (pair && (app === "video" ? pair[1] + "/" : app === "svs" ? pair[1] + "/score-editor" : pair[0] + "/editor.html"));
		if (!value) return null;
		try {
			const url = new URL(value);
			if (url.protocol !== "https:" && !(url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
			if (url.username || url.password || url.search || url.hash) return null;
			return url;
		} catch { return null; }
	}
	function scoreContext(data) {
		if (!data || data.format !== "soramimic-score-context/1" ||
			!Array.isArray(data.moras) || !data.moras.length || data.moras.length > 100000) {
			throw new Error("元歌の楽譜データが不正です。");
		}
		const moras = data.moras.map((note, index) => {
			if (!note || !Number.isFinite(note.start) || note.start < 0 ||
				!Number.isFinite(note.end) || note.end <= note.start ||
				!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 ||
				!Number.isInteger(note.line) || note.line < 0 ||
				typeof note.text !== "string" || !note.text.trim() || note.text.length > 256 ||
				/[\r\n\u0000]/u.test(note.text)) throw new Error("元歌の音符を確認してください。");
			return { id: index, line: note.line, text: note.text, start: note.start, end: note.end, pitch: note.pitch };
		});
		const song = data.song || {};
		const ticks = song.ticks_per_beat ?? 480;
		const tempo = song.tempo_map ?? [[0, 500000]];
		const signatures = song.time_signatures ?? [[0, 4, 4]];
		if (!Number.isInteger(ticks) || ticks < 1 || ticks > 32767 ||
			!Array.isArray(tempo) || !tempo.length || tempo.length > 10000 ||
			tempo.some((row, i) => !Array.isArray(row) || row.length !== 2 ||
				!Number.isInteger(row[0]) || row[0] < 0 || (i && row[0] < tempo[i - 1][0]) ||
				!Number.isInteger(row[1]) || row[1] < 1 || row[1] > 0xffffff) ||
			!Array.isArray(signatures) || signatures.length > 10000 ||
			signatures.some(row => !Array.isArray(row) || row.length !== 3 ||
				!Number.isInteger(row[0]) || row[0] < 0 || !Number.isInteger(row[1]) || row[1] < 1 || row[1] > 32 ||
				![1, 2, 4, 8, 16, 32, 64].includes(row[2]))) throw new Error("元歌のテンポ・拍子を確認してください。");
		const lineTexts = {};
		for (const line of new Set(moras.map(note => note.line))) {
			const text = data.lineTexts?.[line];
			if (typeof text === "string") lineTexts[line] = text.slice(0, 10000);
		}
		return { format: "soramimic-score-context/1", moras, lineTexts,
			song: { ticks_per_beat: ticks, tempo_map: tempo, time_signatures: signatures } };
	}
	function portable(data, { allowSetup = false, previous = false } = {}) {
		if (!data || !Array.isArray(data.results) ||
			!Array.isArray(data.unitsList) || data.results.length !== data.unitsList.length ||
			!data.results.every(Array.isArray) || !data.unitsList.every(Array.isArray)) {
			throw new Error("変換済みの歌詞を開いてください。");
		}
		const setup = data.results.length === 0;
		if (setup && (!allowSetup || data.setupFirst !== true || !data.scoreContext ||
			!Array.isArray(data.phrases) || !data.phrases.length ||
			data.phrases.some(line => typeof line !== "string" || !line.trim()))) {
			throw new Error("変換済みの歌詞を開いてください。");
		}
		const result = { format: "soramimic-editor/1" };
		if (setup) result.setupFirst = true;
		if (data.scoreContext) result.scoreContext = scoreContext(data.scoreContext);
		if (setup && data.scorePrevious && !previous) {
			result.scorePrevious = portable(data.scorePrevious, { previous: true });
		}
		for (const key of ["phrases", "tokensList", "results", "param", "wordlist", "where",
			"unitsList", "weightsList", "noteLengthRawList", "noteLengthAlpha", "lyrics", "originalLines", "song"]) {
			if (data[key] !== undefined) result[key] = data[key];
		}
		const entry = result.wordlist;
		if (String(entry?.value || "").startsWith("custom:") && typeof entry.csvText !== "string") {
			throw new Error("自作リストの単語データがありません。リストを選び直してください。");
		}
		if (entry && typeof entry.csvText === "string") {
			result.wordlist = { value: "ORIGINAL", text: entry.text || "自作リスト", csvText: entry.csvText };
			if (entry.textOnly === true) result.wordlist.textOnly = true;
		}
		if (result.song) result.song = { title: String(result.song.title || "") };
		// Carry only display metadata. Never forward host/session or upload details.
		if (data.videoMetadata && typeof data.videoMetadata === "object") {
			const metadata = {};
			for (const [key, limit] of [["songTitle", 200], ["songCredit", 2000], ["thumbnailWordlistLabel", 100]]) {
				if (typeof data.videoMetadata[key] === "string") {
					metadata[key] = data.videoMetadata[key].slice(0, limit);
				}
			}
			result.videoMetadata = metadata;
		}
		if (new Blob([JSON.stringify(result)]).size > MAX_BYTES) {
			throw new Error("歌詞データが4MBを超えるため開けません。");
		}
		return result;
	}
	function send(target, getData, { signal, allowSetup = false } = {}) {
		if (signal?.aborted) return Promise.reject(new DOMException("転送を中断しました。", "AbortError"));
		if (!target) return Promise.reject(new Error("この環境では接続先が設定されていません。"));
		const url = new URL(target);
		const nonce = crypto.randomUUID();
		url.searchParams.set(PARAM, nonce);
		// Open synchronously inside the click, before fetching a completed job.
		const popup = window.open("about:blank", "_blank");
		if (!popup) return Promise.reject(new Error("ポップアップを許可して、もう一度お試しください。"));
		return new Promise((resolve, reject) => {
			let sending = false, finished = false;
			const onAbort = () => {
				try { popup.postMessage({ type: TYPE, nonce, action: "error" }, url.origin); }
				catch { /* The peer may already have closed. */ }
				finish(new DOMException("転送を中断しました。", "AbortError"));
			};
			const finish = (error) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				clearTimeout(timer);
				clearInterval(closed);
				window.removeEventListener("message", receive);
				error ? reject(error) : resolve();
			};
			const receive = async (event) => {
				const message = event.data;
				if (finished || event.source !== popup || event.origin !== url.origin ||
					message?.type !== TYPE || message.nonce !== nonce) return;
				if (message.action === "accepted") return finish();
				if (message.action === "error") return finish(new Error("歌詞を渡せませんでした。開いた画面をご確認ください。"));
				if (message.action !== "ready" || sending) return;
				sending = true;
				try {
					const payload = portable(await getData(), { allowSetup });
					if (finished) return;
					popup.postMessage({ type: TYPE, nonce, action: "data", payload }, url.origin);
				} catch (error) {
					if (finished) return;
					try { popup.postMessage({ type: TYPE, nonce, action: "error" }, url.origin); }
					catch { /* Complete cleanup even if the peer is gone. */ }
					finish(error);
				}
			};
			const timer = setTimeout(() => finish(new Error("接続がタイムアウトしました。ログイン後にもう一度開いてください。")), TIMEOUT);
			const closed = setInterval(() => {
				if (popup.closed) finish(new Error("歌詞を渡す前に画面が閉じられました。"));
			}, 1000);
			window.addEventListener("message", receive);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) { onAbort(); return; }
			popup.location = url.href;
		});
	}
	async function receive(target, apply, { signal, onApplying = () => {}, allowSetup = false } = {}) {
		const nonce = new URL(location.href).searchParams.get(PARAM);
		if (!nonce) return false;
		if (!target || !window.opener || !/^[\da-f-]{36}$/i.test(nonce)) {
			throw new Error("元の画面からもう一度開いてください。");
		}
		const source = window.opener;
		const origin = new URL(target).origin;
		return new Promise((resolve, reject) => {
			let applying = false, finished = false;
			const onAbort = () => {
				if (applying) return;
				try { post("error"); } catch { /* The peer may already have closed. */ }
				finish(new DOMException("受け取りを中断しました。", "AbortError"));
			};
			const post = (action) => source.postMessage({ type: TYPE, nonce, action }, origin);
			const finish = (error) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				clearInterval(ready);
				clearTimeout(timer);
				window.removeEventListener("message", onMessage);
				const url = new URL(location.href);
				url.searchParams.delete(PARAM);
				history.replaceState(null, "", url);
				window.opener = null;
				error ? reject(error) : resolve(true);
			};
			const onMessage = async (event) => {
				const message = event.data;
				if (finished || event.source !== source || event.origin !== origin ||
					message?.type !== TYPE || message.nonce !== nonce || applying) return;
				if (message.action === "error") return finish(new Error("歌詞を受け取れませんでした。元の画面をご確認ください。"));
				if (message.action !== "data") return;
				applying = true;
				clearInterval(ready);
				clearTimeout(timer);
				try {
					onApplying();
					await apply(portable(message.payload, { allowSetup }));
					post("accepted");
					finish();
				} catch (error) {
					try { post("error"); } catch { /* Complete cleanup even if the peer is gone. */ }
					finish(error);
				}
			};
			const ready = setInterval(() => post("ready"), 500);
			const timer = setTimeout(() => finish(new Error("受け取りがタイムアウトしました。元の画面からもう一度開いてください。")), TIMEOUT);
			window.addEventListener("message", onMessage);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) { onAbort(); return; }
			post("ready");
		});
	}
	window.SoramimicBridge = { peer, portable, scoreContext, send, receive };
})();
