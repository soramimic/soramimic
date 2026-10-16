import assert from "node:assert/strict";
import { ensureLegacyDomain, hostname } from "../.github/scripts/ensure-legacy-domain.mjs";

const domain = { name: hostname, zone_tag: "zone", status: "active" };
const record = { type: "CNAME", name: hostname, content: "soramimic-legacy.pages.dev" };
async function check(responses, expectedWrites, failure) {
	const writes = [];
	const request = async (url, options) => {
		assert(url.startsWith("https://api.cloudflare.com/client/v4/"));
		if (options.method === "POST") writes.push({ url, body: JSON.parse(options.body) });
		assert(responses.length, "unexpected API call");
		const next = responses.shift();
		return { ok: !next.error, status: next.error || 200, json: async () => ({ success: !next.error, result: next.result, errors: [{ code: 10000 }] }) };
	};
	const operation = ensureLegacyDomain({ account: "account", token: "test", request });
	if (failure) await assert.rejects(operation, failure);
	else await operation;
	assert.equal(responses.length, 0);
	assert.deepEqual(writes.map(write => write.body), expectedWrites);
	assert(writes.every(write => write.url.endsWith("/pages/projects/soramimic-legacy/domains") || write.url.endsWith("/zones/zone/dns_records")));
}
await check([{ result: [] }, { result: domain }, { result: [] }, { result: record }], [
	{ name: hostname }, { ...record, proxied: true, ttl: 1 },
]);
await check([{ result: [domain] }, { result: [record] }], []);
await check([{ result: [domain] }, { result: [{ ...record, content: "other.example" }] }], [], /conflicting DNS/);
await check([{ result: [domain] }, { result: [{ type: "A", content: "192.0.2.1" }] }], [], /conflicting DNS/);
await check([{ result: [domain] }, { error: 403 }], [], /HTTP 403/);
await check([{ error: 403 }], [], /HTTP 403/);
await assert.rejects(ensureLegacyDomain({}), /credentials/);
console.log("Legacy domain creation, reuse, conflict protection and permission failures passed");
