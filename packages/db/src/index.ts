import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export * from "./schema";
export * from "./seed";

export type Db = ReturnType<typeof openDb>;
/** A Db or a transaction handle of one: the common query API. */
export type Conn = BaseSQLiteDatabase<"sync", void, typeof schema>;

/** Escape LIKE wildcards (use with ESCAPE '\\'). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Migration files held in memory (compiled binary): the journal plus the SQL text by tag. */
export type EmbeddedMigrations = {
	journal: { entries: { tag: string; when: number; breakpoints: boolean }[] };
	sql: Record<string, string>;
};

export type OpenOpts = {
	/** Embedded migrations, written to a temp dir for drizzle's public migrate(). Default: the `drizzle/` folder next to this package. */
	migrations?: EmbeddedMigrations;
	/** Snapshot into this dir before pending migrations run on an already-migrated db. */
	backupDir?: string;
};

/** Online, WAL-safe snapshot (`VACUUM INTO`) of an open handle. Refuses to overwrite an existing file. */
export function snapshot(sqlite: Database, file: string) {
	sqlite.run("VACUUM INTO ?", [file]);
}

/** Run `fn` with a migrations folder: the repo's, or a temp copy of the embedded files (removed after). */
function withFolder<T>(
	m: EmbeddedMigrations | undefined,
	fn: (dir: string) => T,
) {
	if (!m) return fn(`${import.meta.dir}/../drizzle`);
	const dir = mkdtempSync(join(tmpdir(), "tasuki-migrations-"));
	try {
		mkdirSync(join(dir, "meta"));
		writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(m.journal));
		for (const e of m.journal.entries) {
			const q = m.sql[e.tag];
			if (q === undefined) throw new Error(`missing migration ${e.tag}`);
			writeFileSync(join(dir, `${e.tag}.sql`), q);
		}
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** An already-migrated db with migrations not yet applied (a fresh db is not "pending"). */
function hasPending(sqlite: Database, migrations: { folderMillis: number }[]) {
	const has = sqlite
		.query("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
		.get();
	if (!has) return false;
	const last = sqlite
		.query<{ t: number | null }, []>(
			"SELECT max(created_at) AS t FROM __drizzle_migrations",
		)
		.get()?.t;
	return migrations.some((m) => m.folderMillis > Number(last ?? 0));
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

/** Read-only handle for admin tools (export): never migrates, never writes. */
export function openDbReadonly(path: string) {
	const sqlite = new Database(path, { readonly: true });
	sqlite.run("PRAGMA busy_timeout=5000");
	return drizzle(sqlite, { schema });
}

export function openDb(path: string, opts: OpenOpts = {}) {
	const sqlite = new Database(path);
	if (path !== ":memory:") sqlite.run("PRAGMA journal_mode=WAL");
	sqlite.run("PRAGMA foreign_keys=ON");
	sqlite.run("PRAGMA recursive_triggers=ON"); // REPLACE must fire the FTS delete trigger
	sqlite.run("PRAGMA busy_timeout=5000");
	const db = drizzle(sqlite, { schema });
	withFolder(opts.migrations, (migrationsFolder) => {
		if (
			opts.backupDir &&
			hasPending(sqlite, readMigrationFiles({ migrationsFolder }))
		) {
			mkdirSync(opts.backupDir, { recursive: true });
			snapshot(sqlite, join(opts.backupDir, `tasuki-${stamp(new Date())}.db`));
		}
		migrate(db, { migrationsFolder });
	});
	return db;
}

/** SQL condition: issue text matches `term`. FTS5 trigram for >=3 chars, LIKE below. */
export function issueTextMatch(term: string): SQL {
	const { issues } = schema;
	const like = `%${escapeLike(term)}%`;
	return (
		[...term].length >= 3
			? sql`${issues.id} IN (SELECT issue_id FROM issues_fts WHERE issues_fts MATCH ${`"${term.replaceAll('"', '""')}"`})`
			: or(
					sql`${issues.title} LIKE ${like} ESCAPE '\\'`,
					sql`${issues.bodyMd} LIKE ${like} ESCAPE '\\'`,
				)
	) as SQL;
}

/** Issue ids in a project matching `term`. */
export function searchIssueIds(
	db: Conn,
	projectId: string,
	term: string,
): string[] {
	const { issues } = schema;
	return db
		.select({ id: issues.id })
		.from(issues)
		.where(and(eq(issues.projectId, projectId), issueTextMatch(term)))
		.all()
		.map((r) => r.id);
}
