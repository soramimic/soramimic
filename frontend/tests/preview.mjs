import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

// Use the production build and let the OS choose a free port for each test.
export async function startPreview({ host = "localhost", port = 0 } = {}) {
	await access(new URL("../dist/index.html", import.meta.url));
	const server = await preview({
		root: fileURLToPath(new URL("..", import.meta.url)),
		preview: { host, port, strictPort: true, open: false },
	});
	const url = new URL(server.resolvedUrls.local[0]);
	// Keep the requested origin when Vite substitutes a loopback IP.
	if (host === "localhost") url.hostname = host;
	return {
		url: url.origin,
		close: () => server.close(),
	};
}
