import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
	agentSessions,
	type Db,
	issues,
	openDb,
	searchIssueIds,
	users,
} from "../src/index";
import { seedSampleProject } from "../src/seed";

function setup() {
	const db = openDb(":memory:");
	const user = db
		.insert(users)
		.values({ email: "a@example.com", name: "A", passwordHash: "x" })
		.returning()
		.get();
	const project = seedSampleProject(db, user.id);
	return { db, user, project };
}

function addIssue(
	db: Db,
	projectId: string,
	number: number,
	title: string,
	body = "",
) {
	const base = db
		.select()
		.from(issues)
		.where(eq(issues.projectId, projectId))
		.get();
	if (!base) throw new Error("no base issue");
	return db
		.insert(issues)
		.values({
			projectId,
			number,
			title,
			bodyMd: body,
			statusId: base.statusId,
			rank: `z${number}`,
		})
		.returning()
		.get();
}

describe("db", () => {
	test("migrations apply and seed works", () => {
		const { db, project } = setup();
		expect(project.key).toBe("DEMO");
		expect(db.select().from(issues).all()).toHaveLength(3);
	});

	test("unique(project_id, number)", () => {
		const { db, project } = setup();
		expect(() => addIssue(db, project.id, 1, "dup")).toThrow();
	});

	test("foreign keys enforced", () => {
		const { db, project } = setup();
		expect(() =>
			db
				.insert(issues)
				.values({
					projectId: project.id,
					number: 99,
					title: "x",
					statusId: "nope",
					rank: "a",
				})
				.run(),
		).toThrow();
	});

	test("priority range check", () => {
		const { db, project } = setup();
		const i = addIssue(db, project.id, 10, "p");
		expect(() =>
			db.update(issues).set({ priority: 9 }).where(eq(issues.id, i.id)).run(),
		).toThrow();
	});
});

describe("search", () => {
	test("3+ char term uses FTS (Japanese)", () => {
		const { db, project } = setup();
		expect(searchIssueIds(db, project.id, "ログイン")).toHaveLength(1);
	});

	test("2 char term uses LIKE", () => {
		const { db, project } = setup();
		expect(searchIssueIds(db, project.id, "画面")).toHaveLength(1);
	});

	test("quotes and wildcards are safe and don't over-match", () => {
		const { db, project } = setup();
		addIssue(db, project.id, 10, 'say "hi" 100%', "a_b");
		expect(searchIssueIds(db, project.id, 'say "hi')).toHaveLength(1);
		expect(searchIssueIds(db, project.id, "%")).toHaveLength(1);
		expect(searchIssueIds(db, project.id, "_")).toHaveLength(1);
		expect(searchIssueIds(db, project.id, "\\")).toHaveLength(0);
		expect(searchIssueIds(db, project.id, '"')).toHaveLength(1);
	});

	test("triggers keep FTS in sync", () => {
		const { db, project } = setup();
		const i = addIssue(db, project.id, 10, "alpha beta");
		expect(searchIssueIds(db, project.id, "alpha")).toEqual([i.id]);
		db.update(issues)
			.set({ title: "gamma delta" })
			.where(eq(issues.id, i.id))
			.run();
		expect(searchIssueIds(db, project.id, "alpha")).toHaveLength(0);
		expect(searchIssueIds(db, project.id, "gamma")).toEqual([i.id]);
		db.delete(issues).where(eq(issues.id, i.id)).run();
		expect(searchIssueIds(db, project.id, "gamma")).toHaveLength(0);
	});
});

describe("review fixes", () => {
	test("FTS stays correct after delete + VACUUM", () => {
		const { db, project } = setup();
		const gone = addIssue(db, project.id, 10, "消えるチケット");
		const kept = addIssue(db, project.id, 11, "残るチケット本文");
		db.delete(issues).where(eq(issues.id, gone.id)).run();
		db.run(sql`VACUUM`);
		expect(searchIssueIds(db, project.id, "残るチケット")).toEqual([kept.id]);
		expect(searchIssueIds(db, project.id, "消えるチケット")).toEqual([]);
	});

	test("updated_at bumps on update", async () => {
		const { db, project } = setup();
		const issue = addIssue(db, project.id, 10, "a");
		await Bun.sleep(5);
		const after = db
			.update(issues)
			.set({ title: "b" })
			.where(eq(issues.id, issue.id))
			.returning()
			.get();
		expect(after.updatedAt.getTime()).toBeGreaterThan(
			issue.updatedAt.getTime(),
		);
	});

	test("deleting a parent orphans children instead of failing", () => {
		const { db, project } = setup();
		const parent = addIssue(db, project.id, 10, "親");
		const child = addIssue(db, project.id, 11, "子");
		db.update(issues)
			.set({ parentId: parent.id })
			.where(eq(issues.id, child.id))
			.run();
		db.delete(issues).where(eq(issues.id, parent.id)).run();
		expect(
			db.select().from(issues).where(eq(issues.id, child.id)).get()?.parentId,
		).toBeNull();
	});

	test("only one open agent session per issue", () => {
		const { db, project } = setup();
		const issue = addIssue(db, project.id, 10, "lock");
		const open = {
			issueId: issue.id,
			client: "claude-code",
			expiresAt: new Date(),
		};
		const first = db.insert(agentSessions).values(open).returning().get();
		expect(() => db.insert(agentSessions).values(open).run()).toThrow();
		db.update(agentSessions)
			.set({ endedAt: new Date() })
			.where(eq(agentSessions.id, first.id))
			.run();
		expect(() => db.insert(agentSessions).values(open).run()).not.toThrow();
	});
});

describe("migrations", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "tasuki-db-"));
	const journal = {
		entries: [
			{ tag: "0000_a", when: 1000, breakpoints: true },
			{ tag: "0001_b", when: 2000, breakpoints: true },
		],
	};
	const sqlByTag = {
		"0000_a": "CREATE TABLE a (x int);",
		"0001_b":
			"CREATE TABLE b (x int);--> statement-breakpoint\nCREATE TABLE c (x int);",
	};

	test("embedded migrations apply through the public migrate(); a missing file is an error", () => {
		const db = openDb(":memory:", { migrations: { journal, sql: sqlByTag } });
		expect(
			db.$client
				.query(
					"SELECT count(*) AS n FROM sqlite_master WHERE name IN ('a','b','c')",
				)
				.get(),
		).toEqual({ n: 3 });
		expect(() =>
			openDb(":memory:", { migrations: { journal, sql: {} } }),
		).toThrow("0000_a");
	});

	test("snapshot before pending migrations only on an already-migrated db", () => {
		const d = dir();
		const path = join(d, "t.db");
		const backups = join(d, "backups");
		const first = {
			journal: { entries: journal.entries.slice(0, 1) },
			sql: sqlByTag,
		};
		const all = { journal, sql: sqlByTag };
		// fresh db: nothing to protect
		openDb(path, {
			migrations: first,
			backupDir: backups,
		}).$client.close();
		expect(existsSync(backups)).toBe(false);
		// up to date: no backup
		openDb(path, {
			migrations: first,
			backupDir: backups,
		}).$client.close();
		expect(existsSync(backups)).toBe(false);
		// one pending migration: snapshot taken from the pre-migration state
		openDb(path, { migrations: all, backupDir: backups }).$client.close();
		const files = readdirSync(backups);
		expect(files).toHaveLength(1);
		const snap = new Database(join(backups, files[0] as string), {
			readonly: true,
		});
		const tables = snap
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.all()
			.map((t) => t.name);
		expect(tables).toContain("a");
		expect(tables).not.toContain("b");
		snap.close();
	});
});
