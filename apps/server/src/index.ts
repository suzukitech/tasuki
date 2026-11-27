import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Migration, openDb } from "@tasuki/db";
import { createApp } from "./app";

export type ServeOpts = {
	/** Defaults come from the environment (TASUKI_*, PORT). */
	data?: string;
	port?: number;
	/** Compiled binary: embedded SPA files and migrations. Absent in the repo (read from disk). */
	embedded?: { webAssets: Record<string, string>; migrations: Migration[] };
};

export function startServer(o: ServeOpts = {}) {
	const data = o.data ?? process.env.TASUKI_DATA ?? "./tasuki-data";
	const baseUrl = process.env.TASUKI_BASE_URL ?? "http://localhost:3000";
	const dist = join(import.meta.dir, "../../web/dist");
	mkdirSync(data, { recursive: true });
	const db = openDb(join(data, "tasuki.db"), {
		migrations: o.embedded?.migrations,
		backupDir: join(data, "backups"),
	});
	const app = createApp(db, {
		baseUrl,
		trustProxy: process.env.TASUKI_TRUST_PROXY === "1",
		webDir: !o.embedded && existsSync(dist) ? dist : undefined,
		webAssets: o.embedded?.webAssets,
		dataDir: data,
		webhook: { allowPrivate: process.env.TASUKI_WEBHOOK_ALLOW_PRIVATE === "1" },
	});
	const server = Bun.serve({
		port: o.port ?? Number(process.env.PORT ?? 3000),
		// SSE heartbeats arrive every 25s; Bun's default 10s idle timeout would drop them
		idleTimeout: 120,
		fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
	});
	console.log(`tasuki listening on ${server.url} (data: ${data})`);
	return server;
}

if (import.meta.main) startServer();
