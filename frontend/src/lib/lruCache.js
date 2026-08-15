// Mapの挿入順を利用した小さなLRUキャッシュ。
// getで最近使用した項目を末尾へ移し、set後に古い項目から上限まで破棄する。
export function createLruCache(maxEntries) {
	if (!Number.isInteger(maxEntries) || maxEntries < 1) {
		throw new TypeError("maxEntries must be a positive integer");
	}
	const values = new Map();
	function get(key) {
		if (!values.has(key)) return undefined;
		const value = values.get(key);
		values.delete(key);
		values.set(key, value);
		return value;
	}
	function set(key, value) {
		values.delete(key);
		values.set(key, value);
		while (values.size > maxEntries) {
			values.delete(values.keys().next().value);
		}
		return value;
	}
	return {
		get size() { return values.size; },
		has(key) { return values.has(key); },
		get,
		set,
		getOrCreate(key, factory) {
			if (values.has(key)) return get(key);
			// 構築中のPromiseも共有し、同じ巨大DBを並行構築しない。
			// 失敗したPromiseは次回に再試行できるようキャッシュから外す。
			const pending = Promise.resolve().then(factory);
			set(key, pending);
			pending.catch(() => {
				if (values.get(key) === pending) values.delete(key);
			});
			return pending;
		},
	};
}
