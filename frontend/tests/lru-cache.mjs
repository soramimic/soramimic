import assert from "node:assert/strict";
import { createLruCache } from "../src/lib/lruCache.js";

assert.throws(() => createLruCache(0), /positive integer/);

const cache = createLruCache(2);
const first = { id: "first" };
const second = { id: "second" };
const third = { id: "third" };

cache.set("first", first);
cache.set("second", second);
assert.equal(cache.size, 2);
assert.equal(cache.get("first"), first, "既存値を取得できない");

// firstを直前にgetしたので、次の追加では古いsecondが追い出される。
cache.set("third", third);
assert.equal(cache.size, 2, "上限を超えてDBが残っている");
assert.equal(cache.has("second"), false, "最近使っていないDBが残っている");
assert.equal(cache.get("first"), first, "最近使ったDBが追い出された");
assert.equal(cache.get("third"), third, "追加したDBが見つからない");

// 同じキーの更新は件数を増やさず、LRU順だけを最新にする。
const replacement = { id: "replacement" };
cache.set("first", replacement);
assert.equal(cache.size, 2);
assert.equal(cache.get("first"), replacement);

// 同じキーの構築要求が重なってもfactoryは1回だけ実行する。
const asyncCache = createLruCache(2);
let builds = 0;
let release;
const firstBuild = asyncCache.getOrCreate("db", () => {
	builds += 1;
	return new Promise((resolve) => { release = resolve; });
});
const duplicateBuild = asyncCache.getOrCreate("db", () => {
	builds += 1;
	return "duplicate";
});
assert.equal(firstBuild, duplicateBuild, "構築中のPromiseを再利用していない");
assert.equal(builds, 0, "factoryはマイクロタスクより前に実行しない");
await Promise.resolve();
assert.equal(builds, 1, "同一DBを並行構築した");
release("built");
assert.equal(await firstBuild, "built");

// 失敗は固定化せず、次の要求で再構築できる。
await assert.rejects(asyncCache.getOrCreate("failed", () => Promise.reject(new Error("boom"))), /boom/);
assert.equal(asyncCache.has("failed"), false, "失敗したPromiseがキャッシュに残っている");
assert.equal(await asyncCache.getOrCreate("failed", () => "retried"), "retried");

console.log("[ok] LRU cache test passed");
