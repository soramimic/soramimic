export const GENERATION_HISTORY_LIMIT = 20;
export const GENERATION_HISTORY_DATABASE = "soramimic-generation-history";

// 履歴とJSON書き出しに必要な編集データだけを保存する。
// undoやホストとの通信状態は、別の編集セッションには持ち込まない。
export function generationHistoryPayload(data) {
	const payload = {};
	for (const key of ["phrases", "tokensList", "results", "param", "wordlist", "wordlistSource",
		"where", "unitsList", "weightsList", "noteLengthRawList", "noteLengthAlpha", "lyrics", "originalLines"]) {
		if (data[key] !== undefined) payload[key] = data[key];
	}
	if (data.song?.title) payload.song = { title: data.song.title };
	return structuredClone(payload);
}

export function createGenerationHistoryRepository({
	databaseName = GENERATION_HISTORY_DATABASE,
	provider,
	now = () => Date.now(),
	makeId = () => crypto.randomUUID(),
} = {}) {
	let databasePromise;
	function open() {
		if (databasePromise) return databasePromise;
		databasePromise = new Promise((resolve, reject) => {
			const request = (provider || globalThis.indexedDB).open(databaseName, 1);
			let blocked = false;
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore("results", { keyPath: "id" });
				store.createIndex("createdAt", "createdAt");
			};
			request.onerror = () => reject(request.error);
			request.onblocked = () => { blocked = true; reject(new Error("history database is blocked")); };
			request.onsuccess = () => {
				const database = request.result;
				if (blocked) { database.close(); return; }
				database.onversionchange = () => { database.close(); databasePromise = null; };
				resolve(database);
			};
		});
		databasePromise.catch(() => { databasePromise = null; });
		return databasePromise;
	}

	async function transaction(mode, action) {
		const database = await open();
		return new Promise((resolve, reject) => {
			const tx = database.transaction("results", mode);
			let value;
			let failure;
			tx.oncomplete = () => resolve(value);
			tx.onabort = () => reject(failure || tx.error || new Error("history transaction aborted"));
			try { action(tx.objectStore("results"), result => { value = result; }); }
			catch (error) { failure = error; tx.abort(); }
		});
	}

	return {
		list() {
			return transaction("readonly", (store, result) => {
				const request = store.getAll();
				request.onsuccess = () => result(request.result.sort((a, b) => b.createdAt - a.createdAt));
			});
		},
		async add(data, sourceText, { id = makeId() } = {}) {
			const payload = generationHistoryPayload(data);
			return transaction("readwrite", (store, result) => {
				const existing = store.get(id);
				existing.onsuccess = () => {
					if (existing.result) { result(existing.result); return; }
					const newest = store.index("createdAt").openCursor(null, "prev");
					newest.onsuccess = () => {
						const createdAt = Math.max(now(), (newest.result?.value.createdAt || 0) + 1);
						const entry = { id, createdAt, updatedAt: createdAt, sourceText, payload };
						store.add(entry);
						result(entry);
						let count = 0;
						const cursor = store.index("createdAt").openCursor(null, "prev");
						cursor.onsuccess = () => {
							if (!cursor.result) return;
							if (++count > GENERATION_HISTORY_LIMIT) cursor.result.delete();
							cursor.result.continue();
						};
					};
				};
			});
		},
		async update(id, data) {
			const payload = generationHistoryPayload(data);
			return transaction("readwrite", (store, result) => {
				const request = store.get(id);
				request.onsuccess = () => {
					if (!request.result) { result(false); return; }
					store.put({ ...request.result, payload, updatedAt: Math.max(now(), request.result.createdAt) });
					result(true);
				};
			});
		},
		remove(id) {
			return transaction("readwrite", store => { store.delete(id); });
		},
		async close() {
			if (databasePromise) (await databasePromise).close();
			databasePromise = null;
		},
	};
}
