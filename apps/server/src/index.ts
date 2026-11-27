import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@tasuki/db";
import { createApp } from "./app";

const data = process.env.TASUKI_DATA ?? "./tasuki-data";
const baseUrl = process.env.TASUKI_BASE_URL ?? "http://localhost:3000";
const webDir = () => {
	const d = join(import.meta.dir, "../../web/dist");
	return existsSync(d) ? d : undefined;
};
mkdirSync(data, { recursive: true });
const app = createApp(openDb(join(data, "tasuki.db")), {
	baseUrl,
	trustProxy: process.env.TASUKI_TRUST_PROXY === "1",
	webDir: webDir(),
	dataDir: data,
	webhook: { allowPrivate: process.env.TASUKI_WEBHOOK_ALLOW_PRIVATE === "1" },
});

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	// SSE heartbeats arrive every 25s; Bun's default 10s idle timeout would drop them
	idleTimeout: 120,
	fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
});
console.log(`tasuki listening on ${server.url} (data: ${data})`);
