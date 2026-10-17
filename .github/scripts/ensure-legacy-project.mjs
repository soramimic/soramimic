const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!account || !token) throw new Error("Cloudflare deployment credentials are required");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const project = "soramimic-legacy";
const existing = await fetch(`${endpoint}/${project}`, { headers });
if (existing.ok) {
	const data = await existing.json();
	if (!data.success || data.result.production_branch !== "legacy") {
		throw new Error("Legacy project must use the legacy production branch");
	}
	console.log("Legacy Pages project verified");
} else if (existing.status === 404) {
	const response = await fetch(endpoint, {
		method: "POST", headers,
		body: JSON.stringify({ name: project, production_branch: "legacy" }),
	});
	const data = await response.json();
	if (!response.ok || !data.success) throw new Error(`Could not create legacy Pages project (HTTP ${response.status})`);
	console.log("Legacy Pages project created");
} else {
	throw new Error(`Could not inspect legacy Pages project (HTTP ${existing.status})`);
}
