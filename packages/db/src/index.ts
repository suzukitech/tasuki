import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
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

export type Migration = {
	sql: string[];
	bps: boolean;
	folderMillis: number;
	hash: string;
};

const sha256 = (s: string) =>
	new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Same shape drizzle's readMigrationFiles returns, built from in-memory text (embedded binaries). */
export function embeddedMigrations(
	journal: { entries: { tag: string; when: number; breakpoints: boolean }[] },
	sqlByTag: Record<string, string>,
): Migration[] {
	return journal.entries.map((e) => {
		const q = sqlByTag[e.tag];
		if (q === undefined) throw new Error(`missing migration ${e.tag}`);
		return {
			sql: q.split("--> statement-breakpoint"),
			bps: e.breakpoints,
			folderMillis: e.when,
			hash: sha256(q),
		};
	});
}

export type OpenOpts = {
	/** Migrations to apply instead of the `drizzle/` folder next to this package. */
	migrations?: Migration[];
	/** Snapshot into this dir before pending migrations run on an already-migrated db. */
	backupDir?: string;
};

/** Online, WAL-safe snapshot (`VACUUM INTO`). Refuses to overwrite an existing file. */
export function snapshot(db: Db, file: string) {
	db.$client.run("VACUUM INTO ?", [file]);
}

/** An already-migrated db with migrations not yet applied (a fresh db is not "pending"). */
function hasPending(sqlite: Database, migrations: Migration[]) {
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
	const migrations =
		opts.migrations ??
		readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../drizzle` });
	if (opts.backupDir && hasPending(sqlite, migrations)) {
		mkdirSync(opts.backupDir, { recursive: true });
		snapshot(db, join(opts.backupDir, `tasuki-${stamp(new Date())}.db`));
	}
	// drizzle's own migrate() only reads a folder; the dialect call is what it runs after reading
	const internal = db as unknown as {
		dialect: { migrate(m: Migration[], session: unknown, cfg: object): void };
		session: unknown;
	};
	internal.dialect.migrate(migrations, internal.session, {});
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
