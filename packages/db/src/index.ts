import { Database } from "bun:sqlite";
import { and, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = ReturnType<typeof openDb>;

export function openDb(path = ":memory:") {
	const sqlite = new Database(path);
	if (path !== ":memory:") sqlite.run("PRAGMA journal_mode=WAL");
	sqlite.run("PRAGMA foreign_keys=ON");
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
	if ([...term].length >= 3) {
		const phrase = `"${term.replaceAll('"', '""')}"`;
		return db
			.select({ id: issues.id })
			.from(issues)
			.where(
				and(
					eq(issues.projectId, projectId),
					sql`${issues}.rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ${phrase})`,
				),
			)
			.all()
			.map((r) => r.id);
	}
	const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
	return db
		.select({ id: issues.id })
		.from(issues)
		.where(
			and(
				eq(issues.projectId, projectId),
				or(
					sql`${issues.title} LIKE ${pattern} ESCAPE '\\'`,
					sql`${issues.bodyMd} LIKE ${pattern} ESCAPE '\\'`,
				),
			),
		)
		.all()
		.map((r) => r.id);
}
export * from "./seed";
