import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Ctx,
	getIssue,
	getProject,
	listIssueTypes,
	listProjects,
	listUsers,
	pageIssues,
	systemAdminId,
} from "@tasuki/core";
import { openDbReadonly } from "@tasuki/db";

type Issue = ReturnType<typeof getIssue>;

/**
 * A local admin tool: it needs filesystem access to the data dir, not a token. The actor is
 * the first system admin with a read-only token-style identity, so the core read functions
 * work and nothing can be written, approved or completed through this path.
 */
export function openForExport(data: string): Ctx {
	const file = join(data, "tasuki.db");
	if (!existsSync(file)) throw new Error(`データベースがありません: ${file}`);
	const db = openDbReadonly(file);
	const userId = systemAdminId(db);
	if (!userId)
		throw new Error(
			"システム管理者がいません（まだセットアップされていません）",
		);
	return {
		db,
		actor: {
			userId,
			via: "cli",
			auth: "token",
			token: { scopes: ["read"], projectIds: null },
		},
	};
}

const q = (s: string) => JSON.stringify(s);
const day = (d: Date | null | undefined) => (d ? d.toISOString() : "");

export function issueMarkdown(
	i: Issue,
	typeName: string,
	name: (id: string | null) => string,
) {
	const { issue: r } = i;
	const fm = [
		"---",
		`ref: ${i.ref}`,
		`title: ${q(r.title)}`,
		`status: ${q(i.statusName)}`,
		`type: ${q(typeName)}`,
		`assignee: ${q(name(r.assigneeId))}`,
		`reporter: ${q(name(r.reporterId))}`,
		`priority: ${r.priority ?? ""}`,
		`labels: [${i.labels.map(q).join(", ")}]`,
		`due: ${r.dueDate ?? ""}`,
		`created: ${day(r.createdAt)}`,
		`updated: ${day(r.updatedAt)}`,
		"---",
		"",
	];
	const out = [...fm, r.bodyMd.trim(), ""];
	if (i.criteria.length) {
		out.push("## 受け入れ条件", "");
		for (const c of i.criteria) {
			out.push(`- [${c.result === "met" ? "x" : " "}] ${c.text} (${c.result})`);
			if (c.evidenceMd)
				out.push(...c.evidenceMd.split("\n").map((l) => `  > ${l}`));
		}
		out.push("");
	}
	if (i.comments.length) {
		out.push("## コメント", "");
		for (const c of i.comments)
			out.push(
				`### ${name(c.authorId)} (${day(c.createdAt)})`,
				"",
				c.bodyMd.trim(),
				"",
			);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Every issue of the selected projects, newest page by page. */
function* allIssues(ctx: Ctx, keys: string[]) {
	for (const key of keys) {
		let cursor: number | undefined;
		do {
			const page = pageIssues(ctx, key, "", { limit: 200, cursor });
			for (const it of page.items) yield { key, issue: getIssue(ctx, it.ref) };
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
	}
}

export function exportData(o: {
	data: string;
	format: "md" | "json";
	out?: string;
	project?: string;
}): { files: number; target: string } {
	const ctx = openForExport(o.data);
	const names = new Map(listUsers(ctx).map((u) => [u.id, u.name]));
	const keys = o.project
		? [getProject(ctx, o.project).key]
		: listProjects(ctx).map((p) => p.key);
	const name = (id: string | null) => (id ? (names.get(id) ?? id) : "");
	if (o.format === "md") {
		const typeNames = new Map(listIssueTypes(ctx).map((t) => [t.id, t.name]));
		const typeOf = (id: string | null) => (id ? (typeNames.get(id) ?? "") : "");
		const dir = o.out ?? "./tasuki-export";
		let files = 0;
		for (const { key, issue } of allIssues(ctx, keys)) {
			const file = join(dir, key, `${issue.ref}.md`);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(
				file,
				issueMarkdown(issue, typeOf(issue.issue.typeId), name),
			);
			files++;
		}
		return { files, target: dir };
	}
	const projects = keys.map((key) => ({
		project: getProject(ctx, key),
		issues: [...allIssues(ctx, [key])].map((x) => x.issue),
	}));
	const json = JSON.stringify(
		{
			exportedAt: new Date().toISOString(),
			projects,
			users: Object.fromEntries(names),
		},
		null,
		2,
	);
	if (o.out) {
		mkdirSync(dirname(o.out), { recursive: true });
		writeFileSync(o.out, json);
	} else process.stdout.write(`${json}\n`);
	return {
		files: projects.reduce((n, p) => n + p.issues.length, 0),
		target: o.out ?? "stdout",
	};
}
