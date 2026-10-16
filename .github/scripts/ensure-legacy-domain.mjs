import { pathToFileURL } from "node:url";

export const hostname = "legacy.soramimic.com";

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
	if (["blocked", "error", "deactivated"].includes(domain.status)) throw new Error(`Legacy domain is ${domain.status}`);
	console.log(`Legacy domain configured: https://${hostname}/ (${domain.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await ensureLegacyDomain({ account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
}
