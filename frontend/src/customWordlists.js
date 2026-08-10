// 名前付き自作単語リストの永続化。UIや変換処理からlocalStorageの形式を隠し、
// 旧版の単一リスト(originalWordlist)も初回だけ安全に移行する。
export const CUSTOM_WORDLISTS_STORAGE_KEY = "soramimic-custom-wordlists";
export const LEGACY_ORIGINAL_STORAGE_KEY = "originalWordlist";
export const CUSTOM_WORDLIST_VALUE_PREFIX = "CUSTOM:";

const SCHEMA_VERSION = 1;

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function validateState(value) {
	if (!value || value.version !== SCHEMA_VERSION || !Array.isArray(value.lists)) {
		throw new Error("保存されている自作リストの形式を読み取れません");
	}
	const ids = new Set();
	for (const list of value.lists) {
		if (!list || typeof list.id !== "string" || !list.id || ids.has(list.id)
			|| typeof list.name !== "string" || typeof list.text !== "string"
			|| typeof list.createdAt !== "string" || typeof list.updatedAt !== "string") {
			throw new Error("保存されている自作リストの形式を読み取れません");
		}
		ids.add(list.id);
	}
	return value;
}

function defaultMakeId() {
	if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function customWordlistValue(id) {
	return CUSTOM_WORDLIST_VALUE_PREFIX + id;
}

export function customWordlistId(value) {
	return typeof value === "string" && value.startsWith(CUSTOM_WORDLIST_VALUE_PREFIX)
		? value.slice(CUSTOM_WORDLIST_VALUE_PREFIX.length) : null;
}

export function createCustomWordlistRepository(storage, {
	now = () => new Date().toISOString(),
	makeId = defaultMakeId,
} = {}) {
	function read({ migrate = true } = {}) {
		const raw = storage.getItem(CUSTOM_WORDLISTS_STORAGE_KEY);
		if (raw !== null) {
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				throw new Error("保存されている自作リストが壊れています。ブラウザのデータは上書きしていません");
			}
			return validateState(parsed);
		}

		const empty = { version: SCHEMA_VERSION, lists: [] };
		if (!migrate) return empty;
		const legacy = storage.getItem(LEGACY_ORIGINAL_STORAGE_KEY);
		if (!legacy) return empty;
		const timestamp = now();
		const migrated = {
			version: SCHEMA_VERSION,
			lists: [{
				id: makeId(),
				name: "自作リスト",
				text: legacy,
				createdAt: timestamp,
				updatedAt: timestamp,
			}],
		};
		storage.setItem(CUSTOM_WORDLISTS_STORAGE_KEY, JSON.stringify(migrated));
		// 新形式の書き込みに成功してからだけ旧キーを消す。
		storage.removeItem(LEGACY_ORIGINAL_STORAGE_KEY);
		return migrated;
	}

	function write(state) {
		validateState(state);
		storage.setItem(CUSTOM_WORDLISTS_STORAGE_KEY, JSON.stringify(state));
	}

	return {
		list() {
			return clone(read().lists);
		},
		get(id) {
			const found = read().lists.find((list) => list.id === id);
			return found ? clone(found) : null;
		},
		create({ name, text }) {
			const state = clone(read());
			const timestamp = now();
			const list = {
				id: makeId(),
				name: String(name).trim(),
				text: String(text),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			if (!list.name) throw new Error("リスト名を入力してください");
			if (state.lists.some((item) => item.id === list.id)) {
				throw new Error("自作リストのIDが重複しました。もう一度保存してください");
			}
			state.lists.push(list);
			write(state);
			return clone(list);
		},
		update(id, { name, text }, { expectedUpdatedAt } = {}) {
			const state = clone(read());
			const index = state.lists.findIndex((list) => list.id === id);
			if (index < 0) throw new Error("編集する自作リストが見つかりません");
			if (expectedUpdatedAt !== undefined
				&& state.lists[index].updatedAt !== expectedUpdatedAt) {
				throw new Error("別のタブでこのリストが更新されました。いったん閉じて開き直してください");
			}
			const trimmedName = String(name).trim();
			if (!trimmedName) throw new Error("リスト名を入力してください");
			state.lists[index] = {
				...state.lists[index],
				name: trimmedName,
				text: String(text),
				updatedAt: now(),
			};
			write(state);
			return clone(state.lists[index]);
		},
		remove(id) {
			const state = clone(read());
			const index = state.lists.findIndex((list) => list.id === id);
			if (index < 0) return false;
			state.lists.splice(index, 1);
			write(state);
			return true;
		},
	};
}
