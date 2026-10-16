import { pathToFileURL } from "node:url";

export const hostname = "legacy.soramimic.com";
const target = "soramimic-legacy.pages.dev";

export async function ensureLegacyDomain({ account, token, request = fetch }) {
	if (!account || !token) throw new Error("Cloudflare deployment credentials are required");
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const api = async (path, options = {}) => {
		const response = await request(`https://api.cloudflare.com/client/v4${path}`, { ...options, headers });
		const data = await response.json();
		if (!response.ok || !data.success) {
			throw new Error(`Cloudflare ${options.method || "GET"} failed (HTTP ${response.status}; codes ${(data.errors || []).map(error => error.code).join(",")})`);
		}
		return data.result;
	};
	const project = `/accounts/${encodeURIComponent(account)}/pages/projects/soramimic-legacy`;
	const domains = await api(`${project}/domains`);
	let domain = domains.find(domain => domain.name === hostname);
	if (!domain) domain = await api(`${project}/domains`, { method: "POST", body: JSON.stringify({ name: hostname }) });
	let zone = domain.zone_tag;
	if (!zone) {
		const zones = await api(`/zones?name=soramimic.com&account.id=${encodeURIComponent(account)}`);
		if (zones.length !== 1) throw new Error("Expected the existing soramimic.com Cloudflare zone");
		zone = zones[0].id;
	}
	const recordsPath = `/zones/${encodeURIComponent(zone)}/dns_records`;
	const records = await api(`${recordsPath}?name=${hostname}`);
	if (records.some(record => record.type !== "CNAME" || record.content.replace(/\.$/, "") !== target)) {
		throw new Error("Legacy hostname has conflicting DNS records; no DNS records were changed");
	}
	if (records.length === 0) {
		await api(recordsPath, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 }) });
	}
	console.log(`Legacy domain configured: https://${hostname}/ (${domain.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await ensureLegacyDomain({ account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
}
