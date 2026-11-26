import {
	issueLabels,
	issues,
	labels,
	STATUS_CATEGORIES,
	searchIssueIds,
	statuses,
	users,
} from "@tasuki/db";
import { DATE_RE, PRIORITIES } from "@tasuki/schema";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { type Ctx, fail } from "./ctx";
import { getProject } from "./projects";

type Op = ">=" | "<=" | ">" | "<" | "=";
export type Cond =
	| { key: "status" | "assignee" | "label"; value: string }
	| { key: "priority"; op: Op; value: number }
	| { key: "due"; op: Op; value: string };
export type FilterAst = { conds: Cond[]; terms: string[] };

const op = (v: string): [Op, string] => {
	const m = /^(>=|<=|>|<|=)?(.*)$/.exec(v) as RegExpExecArray;
	return [(m[1] ?? "=") as Op, m[2] as string];
};

/** `status:open assignee:me priority:>=high due:<2026-12-31 label:bug "free text" word` */
export function parseFilter(q: string): FilterAst {
	const ast: FilterAst = { conds: [], terms: [] };
	for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
		if (m[1] !== undefined) {
			if (m[1].trim()) ast.terms.push(m[1].trim());
			continue;
		}
		const tok = m[2] as string;
		const kv = /^([A-Za-z]+):(.*)$/.exec(tok);
		if (!kv) {
			ast.terms.push(tok);
			continue;
		}
		const key = (kv[1] as string).toLowerCase();
		const raw = kv[2] as string;
		if (!raw) fail("invalid", `empty value for '${key}'`);
		if (key === "status" || key === "assignee" || key === "label") {
			ast.conds.push({ key, value: raw });
		} else if (key === "priority") {
			const [o, v] = op(raw);
			const name = v.toLowerCase();
			if (name in PRIORITIES)
				ast.conds.push({
					key,
					op: o,
					value: PRIORITIES[name as keyof typeof PRIORITIES],
				});
			else if (/^[0-4]$/.test(v))
				ast.conds.push({ key, op: o, value: Number(v) });
			else fail("invalid", `bad priority '${v}'`);
		} else if (key === "due") {
			const [o, v] = op(raw);
			if (!DATE_RE.test(v)) fail("invalid", `bad date '${v}'`);
			ast.conds.push({ key, op: o, value: v });
		} else fail("invalid", `unknown filter key '${key}'`);
	}
	return ast;
}

const like = (s: string) => `${s.replace(/[\\%_]/g, "\\$&")}`;

function condSql(ctx: Ctx, projectId: string, c: Cond): SQL {
	const { db } = ctx;
	switch (c.key) {
		case "status": {
			const v = c.value.toLowerCase();
			const inStatus = (w: SQL | undefined) =>
				inArray(
					issues.statusId,
					db
						.select({ id: statuses.id })
						.from(statuses)
						.where(and(eq(statuses.projectId, projectId), w)),
				);
			if (v === "open") return inStatus(ne(statuses.category, "done"));
			const cat = STATUS_CATEGORIES.find((x) => x === v);
			return inStatus(
				cat ? eq(statuses.category, cat) : eq(statuses.name, c.value),
			);
		}
		case "assignee": {
			const v = c.value.toLowerCase();
			if (v === "me") return eq(issues.assigneeId, ctx.actor.userId);
			if (v === "none") return isNull(issues.assigneeId);
			return inArray(
				issues.assigneeId,
				db
					.select({ id: users.id })
					.from(users)
					.where(
						or(
							sql`lower(${users.email}) LIKE ${`${like(v)}@%`} ESCAPE '\\'`,
							sql`lower(${users.name}) = ${v}`,
						),
					),
			);
		}
		case "label":
			return inArray(
				issues.id,
				db
					.select({ id: issueLabels.issueId })
					.from(issueLabels)
					.innerJoin(labels, eq(labels.id, issueLabels.labelId))
					.where(
						and(
							eq(labels.projectId, projectId),
							sql`lower(${labels.name}) = ${c.value.toLowerCase()}`,
						),
					),
			);
		case "priority":
			// an unset priority counts as 'none'
			return sql`coalesce(${issues.priority}, 0) ${sql.raw(c.op)} ${c.value}`;
		case "due":
			return sql`${issues.dueDate} ${sql.raw(c.op)} ${c.value}`;
	}
}

function buildIssueWhere(ctx: Ctx, projectId: string, ast: FilterAst) {
	return and(
		eq(issues.projectId, projectId),
		...ast.conds.map((c) => condSql(ctx, projectId, c)),
		...ast.terms.map((t) =>
			inArray(issues.id, searchIssueIds(ctx.db, projectId, t)),
		),
	) as SQL;
}

export function searchIssues(
	ctx: Ctx,
	projectKey: string,
	q: string,
	limit = 200,
) {
	const project = getProject(ctx, projectKey);
	return ctx.db
		.select()
		.from(issues)
		.where(buildIssueWhere(ctx, project.id, parseFilter(q)))
		.orderBy(issues.number)
		.limit(limit)
		.all();
}
