import assert from "node:assert/strict";
import { ensureLegacyDomain, hostname } from "../.github/scripts/ensure-legacy-domain.mjs";

const domain = { name: hostname, zone_tag: "zone", status: "active" };
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
	assert(writes.every(write => write.url.endsWith("/pages/projects/soramimic-legacy/domains")));
}
await check([{ result: [] }, { result: domain }], [{ name: hostname }]);
await check([{ result: [domain] }], []);
await check([{ result: [{ ...domain, zone_tag: undefined }] }], []);
await check([{ result: [{ ...domain, status: "blocked" }] }], [], /blocked/);
await check([{ error: 403 }], [], /HTTP 403/);
await check([{ result: [] }, { error: 403 }], [{ name: hostname }], /HTTP 403/);
await assert.rejects(ensureLegacyDomain({}), /credentials/);
console.log("Legacy domain creation, reuse, blocked status and permission failures passed");
