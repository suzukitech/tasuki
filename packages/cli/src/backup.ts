import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { snapshot } from "@tasuki/db";

/** Online, WAL-safe snapshot of `<data>/tasuki.db`. Safe while the server runs. Returns the file written. */
export function backup(data: string, out?: string, now = new Date()): string {
	const src = join(data, "tasuki.db");
	if (!existsSync(src)) throw new Error(`データベースがありません: ${src}`);
	const file =
		out ??
		join(
			data,
			"backups",
			`tasuki-${now.toISOString().replace(/[:.]/g, "-")}.db`,
		);
	mkdirSync(dirname(file), { recursive: true });
	const db = new Database(src, { readonly: true });
	try {
		db.run("PRAGMA busy_timeout=5000");
		snapshot(db, file);
	} finally {
		db.close();
	}
	return file;
}
