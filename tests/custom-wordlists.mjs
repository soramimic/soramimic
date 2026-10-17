import assert from "node:assert/strict";
import {
	createCustomWordlistRepository,
	CUSTOM_WORDLISTS_STORAGE_KEY,
	LEGACY_ORIGINAL_STORAGE_KEY,
	customWordlistId,
	customWordlistValue,
} from "../frontend/src/customWordlists.js";

class MemoryStorage {
	constructor(values = {}) {
		this.values = new Map(Object.entries(values));
	}
	getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
	setItem(key, value) { this.values.set(key, String(value)); }
	removeItem(key) { this.values.delete(key); }
}

function repository(storage = new MemoryStorage()) {
	let id = 0;
	let tick = 0;
	return createCustomWordlistRepository(storage, {
		makeId: () => `id-${++id}`,
		now: () => `2026-08-11T00:00:0${tick++}.000Z`,
	});
}

{
	const storage = new MemoryStorage();
	const repo = repository(storage);
	assert.deepEqual(repo.list(), []);
	const first = repo.create({ name: "  野鳥  ", text: "燕,ツバメ" });
	assert.equal(first.name, "野鳥");
	assert.equal(repo.get(first.id).text, "燕,ツバメ");
	const updated = repo.update(first.id, { name: "鳥", text: "雀,スズメ" });
	assert.equal(updated.createdAt, first.createdAt);
	assert.notEqual(updated.updatedAt, first.updatedAt);
	assert.equal(repo.list()[0].name, "鳥");
	assert.equal(repo.remove(first.id), true);
	assert.equal(repo.remove(first.id), false);
	assert.deepEqual(repo.list(), []);
}

// 編集開始後に別タブ相当の更新が入った場合、古い内容で上書きしない。
{
	const storage = new MemoryStorage();
	const repo = repository(storage);
	const first = repo.create({ name: "元", text: "元" });
	const newer = repo.update(first.id, { name: "別タブ", text: "新" });
	assert.throws(() => repo.update(first.id, { name: "古い画面", text: "旧" }, {
		expectedUpdatedAt: first.updatedAt,
	}), /別のタブ/);
	assert.deepEqual(repo.get(first.id), newer);
}

// 旧単一キーは新ストレージが無い初回だけ移行し、再読込で重複しない。
{
	const storage = new MemoryStorage({ [LEGACY_ORIGINAL_STORAGE_KEY]: "山田,ヤマダ" });
	const repo = repository(storage);
	assert.deepEqual(repo.list().map(({ name, text }) => ({ name, text })), [
		{ name: "自作リスト", text: "山田,ヤマダ" },
	]);
	assert.equal(storage.getItem(LEGACY_ORIGINAL_STORAGE_KEY), null);
	assert.equal(repo.list().length, 1);
}

// 新形式があるときは、残っている旧キーで上書き・追加しない。
{
	const state = { version: 1, lists: [] };
	const storage = new MemoryStorage({
		[CUSTOM_WORDLISTS_STORAGE_KEY]: JSON.stringify(state),
		[LEGACY_ORIGINAL_STORAGE_KEY]: "取り込まない",
	});
	assert.deepEqual(repository(storage).list(), []);
	assert.equal(storage.getItem(LEGACY_ORIGINAL_STORAGE_KEY), "取り込まない");
}

// 壊れた保存データは黙って初期化しない。
{
	const storage = new MemoryStorage({ [CUSTOM_WORDLISTS_STORAGE_KEY]: "{" });
	assert.throws(() => repository(storage).list(), /壊れています/);
	assert.equal(storage.getItem(CUSTOM_WORDLISTS_STORAGE_KEY), "{");
}

// setItem失敗時は既存の保存内容が変わらない。
{
	const storage = new MemoryStorage();
	const repo = repository(storage);
	repo.create({ name: "既存", text: "既存" });
	const before = storage.getItem(CUSTOM_WORDLISTS_STORAGE_KEY);
	storage.setItem = () => { throw new Error("quota"); };
	assert.throws(() => repo.create({ name: "追加", text: "追加" }), /quota/);
	assert.equal(storage.getItem(CUSTOM_WORDLISTS_STORAGE_KEY), before);
}

assert.equal(customWordlistValue("abc"), "CUSTOM:abc");
assert.equal(customWordlistId("CUSTOM:abc"), "abc");
assert.equal(customWordlistId("BASEBALL"), null);

console.log("[ok] custom wordlists tests passed");
