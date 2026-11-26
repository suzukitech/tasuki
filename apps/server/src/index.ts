import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@tasuki/db";
import { createApp } from "./app";

const data = process.env.TASUKI_DATA ?? "./tasuki-data";
const baseUrl = (
	process.env.TASUKI_BASE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
mkdirSync(data, { recursive: true });
const app = createApp(openDb(join(data, "tasuki.db")), { baseUrl });

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	// SSE heartbeats arrive every 25s; Bun's default 10s idle timeout would drop them
	idleTimeout: 120,
	fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
});
console.log(`tasuki listening on ${server.url} (data: ${data})`);
