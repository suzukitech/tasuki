import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type EmbeddedMigrations, openDb } from "@tasuki/db";
import { createApp } from "./app";

export type ServeOpts = {
	/** Defaults come from the environment (TASUKI_*, PORT). */
	data?: string;
	port?: number;
	/** Compiled binary: embedded SPA files and migrations. Absent in the repo (read from disk). */
	embedded?: {
		webAssets: Record<string, string>;
		migrations: EmbeddedMigrations;
	};
};

export function startServer(o: ServeOpts = {}) {
	const data = o.data ?? process.env.TASUKI_DATA ?? "./tasuki-data";
	const dist = join(import.meta.dir, "../../web/dist");
	mkdirSync(data, { recursive: true });
	const db = openDb(join(data, "tasuki.db"), {
		migrations: o.embedded?.migrations,
		backupDir: join(data, "backups"),
	});
	// the app needs the bound port for its default baseUrl (--port / PORT=0), so bind first
	let app: ReturnType<typeof createApp>;
	const server = Bun.serve({
		port: o.port ?? Number(process.env.PORT ?? 3000),
		// SSE heartbeats arrive every 25s; Bun's default 10s idle timeout would drop them
		idleTimeout: 120,
		fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
	});
	app = createApp(db, {
		baseUrl: process.env.TASUKI_BASE_URL ?? `http://localhost:${server.port}`,
		trustProxy: process.env.TASUKI_TRUST_PROXY === "1",
		webDir: !o.embedded && existsSync(dist) ? dist : undefined,
		webAssets: o.embedded?.webAssets,
		dataDir: data,
		webhook: { allowPrivate: process.env.TASUKI_WEBHOOK_ALLOW_PRIVATE === "1" },
	});
	console.log(`tasuki listening on ${server.url} (data: ${data})`);
	return server;
}

if (import.meta.main) startServer();
