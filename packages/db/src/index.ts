import { Database } from "bun:sqlite";
import { and, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export * from "./schema";
export * from "./seed";

export type Db = ReturnType<typeof openDb>;

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

/** Issue ids in a project matching `term`. FTS5 trigram for >=3 chars, LIKE below. */
export function searchIssueIds(
	db: Db,
	projectId: string,
	term: string,
): string[] {
	const { issues } = schema;
	const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
	const match =
		[...term].length >= 3
			? sql`${issues.id} IN (SELECT issue_id FROM issues_fts WHERE issues_fts MATCH ${`"${term.replaceAll('"', '""')}"`})`
			: or(
					sql`${issues.title} LIKE ${like} ESCAPE '\\'`,
					sql`${issues.bodyMd} LIKE ${like} ESCAPE '\\'`,
				);
	return db
		.select({ id: issues.id })
		.from(issues)
		.where(and(eq(issues.projectId, projectId), match))
		.all()
		.map((r) => r.id);
}
