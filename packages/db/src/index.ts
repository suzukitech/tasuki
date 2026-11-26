import { Database } from "bun:sqlite";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export * from "./schema";
export * from "./seed";

export type Db = ReturnType<typeof openDb>;
/** A Db or a transaction handle of one: the common query API. */
export type Conn = BaseSQLiteDatabase<"sync", void, typeof schema>;

/** Escape LIKE wildcards (use with ESCAPE '\\'). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export function openDb(path: string) {
	const sqlite = new Database(path);
	if (path !== ":memory:") sqlite.run("PRAGMA journal_mode=WAL");
	sqlite.run("PRAGMA foreign_keys=ON");
	sqlite.run("PRAGMA recursive_triggers=ON"); // REPLACE must fire the FTS delete trigger
	sqlite.run("PRAGMA busy_timeout=5000");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
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
