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
		const value = override || (pair && (app === "video" ? pair[1] + "/" : pair[0] + "/editor.html"));
		if (!value) return null;
		try {
			const url = new URL(value);
			if (url.protocol !== "https:" && !(url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
			if (url.username || url.password || url.search || url.hash) return null;
			return url;
		} catch { return null; }
	}
	function portable(data) {
		if (!data || !Array.isArray(data.results) || !data.results.length ||
			!Array.isArray(data.unitsList) || data.results.length !== data.unitsList.length ||
			!data.results.every(Array.isArray) || !data.unitsList.every(Array.isArray)) {
			throw new Error("変換済みの歌詞を開いてください。");
		}
		const result = { format: "soramimic-editor/1" };
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
		if (new Blob([JSON.stringify(result)]).size > MAX_BYTES) {
			throw new Error("歌詞データが4MBを超えるため開けません。");
		}
		return result;
	}
	function send(target, getData) {
		if (!target) return Promise.reject(new Error("この環境では接続先が設定されていません。"));
		const url = new URL(target);
		const nonce = crypto.randomUUID();
		url.searchParams.set(PARAM, nonce);
		// Open synchronously inside the click, before fetching a completed job.
		const popup = window.open("about:blank", "_blank");
		if (!popup) return Promise.reject(new Error("ポップアップを許可して、もう一度お試しください。"));
		return new Promise((resolve, reject) => {
			let sending = false;
			const finish = (error) => {
				clearTimeout(timer);
				clearInterval(closed);
				window.removeEventListener("message", receive);
				error ? reject(error) : resolve();
			};
			const receive = async (event) => {
				const message = event.data;
				if (event.source !== popup || event.origin !== url.origin ||
					message?.type !== TYPE || message.nonce !== nonce) return;
				if (message.action === "accepted") return finish();
				if (message.action === "error") return finish(new Error("歌詞を渡せませんでした。開いた画面をご確認ください。"));
				if (message.action !== "ready" || sending) return;
				sending = true;
				try {
					const payload = portable(await getData());
					popup.postMessage({ type: TYPE, nonce, action: "data", payload }, url.origin);
				} catch (error) {
					popup.postMessage({ type: TYPE, nonce, action: "error" }, url.origin);
					finish(error);
				}
			};
			const timer = setTimeout(() => finish(new Error("接続がタイムアウトしました。ログイン後にもう一度開いてください。")), TIMEOUT);
			const closed = setInterval(() => {
				if (popup.closed) finish(new Error("歌詞を渡す前に画面が閉じられました。"));
			}, 1000);
			window.addEventListener("message", receive);
			popup.location = url.href;
		});
	}
	async function receive(target, apply) {
		const nonce = new URL(location.href).searchParams.get(PARAM);
		if (!nonce) return false;
		if (!target || !window.opener || !/^[\da-f-]{36}$/i.test(nonce)) {
			throw new Error("元の画面からもう一度開いてください。");
		}
		const source = window.opener;
		const origin = new URL(target).origin;
		return new Promise((resolve, reject) => {
			let applying = false;
			const post = (action) => source.postMessage({ type: TYPE, nonce, action }, origin);
			const finish = (error) => {
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
				if (event.source !== source || event.origin !== origin ||
					message?.type !== TYPE || message.nonce !== nonce || applying) return;
				if (message.action === "error") return finish(new Error("歌詞を受け取れませんでした。元の画面をご確認ください。"));
				if (message.action !== "data") return;
				applying = true;
				clearInterval(ready);
				try {
					await apply(portable(message.payload));
					post("accepted");
					finish();
				} catch (error) {
					post("error");
					finish(error);
				}
			};
			const ready = setInterval(() => post("ready"), 500);
			const timer = setTimeout(() => finish(new Error("受け取りがタイムアウトしました。元の画面からもう一度開いてください。")), TIMEOUT);
			window.addEventListener("message", onMessage);
			post("ready");
		});
	}
	window.SoramimicBridge = { peer, portable, send, receive };
})();
