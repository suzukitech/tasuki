import {
	acceptanceCriteria,
	activities,
	comments,
	type Issue,
	issueLabels,
	issues,
	issueTypes,
	labels,
	plans,
	projectMembers,
	projects,
	questions,
	reports,
	type STATUS_CATEGORIES,
	statuses,
	users,
} from "@tasuki/db";
import {
	createIssueInput,
	noteInput,
	PRIORITIES,
	updateIssueInput,
} from "@tasuki/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { atomic, type Ctx, fail, log, nowOf, parse } from "./ctx";
import { projectRole, type Role, requireSession } from "./permissions";
import { getProject } from "./projects";

export type Category = (typeof STATUS_CATEGORIES)[number];

export const refOf = (key: string, number: number) => `${key}-${number}`;

/** Load an issue by "KEY-12" ref and check the actor's role in its project. */
export function loadIssue(
	ctx: Ctx,
	ref: string,
	min: Role = "viewer",
	kind?: "read" | "write",
) {
	const m = /^([A-Za-z]{2,10})-(\d+)$/.exec(ref.trim());
	if (!m) return fail("invalid", `bad issue ref: ${ref}`);
	const project = getProject(ctx, m[1] as string, min, kind);
	const role = projectRole(ctx, project.id) as Role;
	const row = ctx.db
		.select({ issue: issues, category: statuses.category })
		.from(issues)
		.innerJoin(statuses, eq(statuses.id, issues.statusId))
		.where(
			and(eq(issues.projectId, project.id), eq(issues.number, Number(m[2]))),
		)
		.get();
	if (!row) return fail("not_found", `issue ${ref} not found`);
	return { ...row, project, role, ref: refOf(project.key, row.issue.number) };
}
export function refById(ctx: Ctx, issueId: string) {
	const r = ctx.db
		.select({ key: projects.key, number: issues.number })
		.from(issues)
		.innerJoin(projects, eq(projects.id, issues.projectId))
		.where(eq(issues.id, issueId))
		.get();
	return r ? refOf(r.key, r.number) : fail("not_found", "issue not found");
}
export type Loaded = ReturnType<typeof loadIssue>;

export function statusFor(ctx: Ctx, projectId: string, category: Category) {
	const s = ctx.db
		.select()
		.from(statuses)
		.where(
			and(eq(statuses.projectId, projectId), eq(statuses.category, category)),
		)
		.orderBy(asc(statuses.position))
		.get();
	return s ?? fail("invalid", `project has no '${category}' status`);
}

function endRank(ctx: Ctx, statusId: string) {
	const last = ctx.db
		.select({ rank: issues.rank })
		.from(issues)
		.where(eq(issues.statusId, statusId))
		.orderBy(desc(issues.rank))
		.get();
	return generateKeyBetween(last?.rank ?? null, null);
}

export function patchIssue(
	ctx: Ctx,
	id: string,
	set: Partial<typeof issues.$inferInsert>,
) {
	return ctx.db
		.update(issues)
		.set({ ...set, updatedAt: nowOf(ctx) })
		.where(eq(issues.id, id))
		.returning()
		.get();
}

/** Move an issue to a status of `category` (or an explicit status), logging the change. */
export function setCategory(
	ctx: Ctx,
	l: Loaded,
	category: Category,
	opts: { statusId?: string; rank?: string } = {},
) {
	const target = opts.statusId
		? ctx.db.select().from(statuses).where(eq(statuses.id, opts.statusId)).get()
		: statusFor(ctx, l.project.id, category);
	if (!target || target.projectId !== l.project.id)
		fail("invalid", "unknown status");
	const prev = ctx.db
		.select()
		.from(statuses)
		.where(eq(statuses.id, l.issue.statusId))
		.get();
	const next = target as NonNullable<typeof target>;
	patchIssue(ctx, l.issue.id, {
		statusId: next.id,
		rank: opts.rank ?? endRank(ctx, next.id),
		closedAt: next.category === "done" ? nowOf(ctx) : null,
	});
	if (prev?.id !== next.id)
		log(ctx, l.issue.id, "updated", "status", prev?.name, next.name);
}

function checkRefs(ctx: Ctx, projectId: string, p: Partial<Issue>) {
	for (const uid of [p.assigneeId, p.approverId]) {
		if (!uid) continue;
		const u = ctx.db.select().from(users).where(eq(users.id, uid)).get();
		const m = ctx.db
			.select()
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, projectId),
					eq(projectMembers.userId, uid),
				),
			)
			.get();
		if (!u || (!m && u.role !== "admin"))
			fail("invalid", "assignee/approver must be a project member");
	}
	if (p.typeId) {
		const t = ctx.db
			.select()
			.from(issueTypes)
			.where(eq(issueTypes.id, p.typeId))
			.get();
		if (t?.projectId !== projectId) fail("invalid", "unknown issue type");
	}
	if (p.parentId) {
		const t = ctx.db
			.select()
			.from(issues)
			.where(eq(issues.id, p.parentId))
			.get();
		if (t?.projectId !== projectId) fail("invalid", "unknown parent issue");
	}
}

function labelNames(ctx: Ctx, issueId: string) {
	return ctx.db
		.select({ name: labels.name })
		.from(issueLabels)
		.innerJoin(labels, eq(labels.id, issueLabels.labelId))
		.where(eq(issueLabels.issueId, issueId))
		.all()
		.map((r) => r.name)
		.sort();
}

function setLabels(
	ctx: Ctx,
	projectId: string,
	issueId: string,
	names: string[],
) {
	ctx.db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run();
	for (const name of new Map(names.map((n) => [n.toLowerCase(), n])).values()) {
		const existing = ctx.db
			.select()
			.from(labels)
			.where(
				and(
					eq(labels.projectId, projectId),
					sql`lower(${labels.name}) = ${name.toLowerCase()}`,
				),
			)
			.get();
		const label =
			existing ??
			ctx.db.insert(labels).values({ projectId, name }).returning().get();
		ctx.db.insert(issueLabels).values({ issueId, labelId: label.id }).run();
	}
}

export function createIssue(ctx: Ctx, projectKey: string, input: unknown) {
	const inp = parse(createIssueInput, input);
	const project = getProject(ctx, projectKey, "member");
	return atomic(ctx, (c) => {
		checkRefs(c, project.id, inp as Partial<Issue>);
		const { n } = c.db
			.update(projects)
			.set({ nextNumber: sql`${projects.nextNumber} + 1` })
			.where(eq(projects.id, project.id))
			.returning({ n: projects.nextNumber })
			.get() as { n: number };
		const status = statusFor(
			c,
			project.id,
			inp.flow === "simple" ? "ready" : "draft",
		);
		const { labels: names, ...fields } = inp;
		const now = nowOf(c);
		const issue = c.db
			.insert(issues)
			.values({
				...fields,
				bodyMd: fields.bodyMd ?? undefined,
				projectId: project.id,
				number: n - 1,
				statusId: status.id,
				rank: endRank(c, status.id),
				reporterId: c.actor.userId,
				approverId: inp.approverId ?? c.actor.userId,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();
		setLabels(c, project.id, issue.id, names);
		log(c, issue.id, "created");
		return issue;
	});
}

/** Issue with everything the UI / AI needs to read it. */
export function getIssue(ctx: Ctx, ref: string) {
	const l = loadIssue(ctx, ref);
	const id = l.issue.id;
	const by = <T extends { issueId: unknown }>(t: T) =>
		eq(t.issueId as never, id);
	return {
		...l,
		labels: labelNames(ctx, id),
		criteria: ctx.db
			.select()
			.from(acceptanceCriteria)
			.where(by(acceptanceCriteria))
			.orderBy(asc(acceptanceCriteria.position))
			.all(),
		plans: ctx.db
			.select()
			.from(plans)
			.where(by(plans))
			.orderBy(asc(plans.version))
			.all(),
		reports: ctx.db
			.select()
			.from(reports)
			.where(by(reports))
			.orderBy(asc(reports.createdAt))
			.all(),
		questions: ctx.db
			.select()
			.from(questions)
			.where(by(questions))
			.orderBy(asc(questions.createdAt))
			.all(),
		comments: ctx.db
			.select()
			.from(comments)
			.where(by(comments))
			.orderBy(asc(comments.createdAt))
			.all(),
		activities: ctx.db
			.select()
			.from(activities)
			.where(by(activities))
			.orderBy(asc(activities.createdAt))
			.all(),
	};
}

const PATCHABLE = [
	"title",
	"bodyMd",
	"typeId",
	"priority",
	"assigneeId",
	"approverId",
	"parentId",
	"dueDate",
	"estimate",
	"flow",
	"skipPlanReview",
] as const;

/** Edit fields. `ifMatch` = the updatedAt (ms) the caller last saw. */
export function updateIssue(
	ctx: Ctx,
	ref: string,
	patch: unknown,
	opts: { ifMatch?: number } = {},
) {
	const inp = parse(updateIssueInput, patch);
	return atomic(ctx, (c) => {
		const { issue, project } = loadIssue(c, ref, "member");
		if (
			opts.ifMatch !== undefined &&
			opts.ifMatch !== issue.updatedAt.getTime()
		)
			fail("conflict", "issue was changed by someone else");
		// flow / skip_plan_review decide which gates apply: a token must not flip them
		if (
			(inp.flow !== undefined && inp.flow !== issue.flow) ||
			(inp.skipPlanReview !== undefined &&
				inp.skipPlanReview !== issue.skipPlanReview)
		)
			requireSession(c, "changing flow / skipPlanReview");
		checkRefs(c, project.id, inp as Partial<Issue>);
		const set: Record<string, unknown> = {};
		for (const f of PATCHABLE) {
			const v = inp[f];
			if (v !== undefined && v !== issue[f]) {
				set[f] = v;
				log(c, issue.id, "updated", f, issue[f], v);
			}
		}
		if (inp.labels) {
			const before = labelNames(c, issue.id);
			setLabels(c, project.id, issue.id, inp.labels);
			const after = labelNames(c, issue.id);
			if (before.join() !== after.join()) {
				log(c, issue.id, "updated", "labels", before, after);
				set.updatedAt = nowOf(c);
			}
		}
		return Object.keys(set).length ? patchIssue(c, issue.id, set) : issue;
	});
}

export function deleteIssue(ctx: Ctx, ref: string) {
	const { issue } = loadIssue(ctx, ref, "manager");
	ctx.db.delete(issues).where(eq(issues.id, issue.id)).run();
}

export function addComment(ctx: Ctx, ref: string, bodyMd: string) {
	const body = parse(noteInput, bodyMd);
	return atomic(ctx, (c) => {
		const { issue } = loadIssue(c, ref, "viewer", "write");
		const row = c.db
			.insert(comments)
			.values({
				issueId: issue.id,
				authorId: c.actor.userId,
				bodyMd: body,
				via: c.actor.via,
				createdAt: nowOf(c),
			})
			.returning()
			.get();
		log(c, issue.id, "commented");
		return row;
	});
}

/** "fix login @taro #bug !high" → title + assignee/labels/priority. Accepts full-width ＠＃！. */
export function parseQuickTitle(text: string) {
	const out: {
		title: string;
		assignee?: string;
		labels: string[];
		priority?: number;
	} = {
		title: "",
		labels: [],
	};
	const words: string[] = [];
	for (const w of text.trim().split(/\s+/)) {
		const body = w.slice(1);
		const p = body.toLowerCase();
		if (!body) words.push(w);
		else if (/^[@＠]/.test(w)) out.assignee = body;
		else if (/^[#＃]/.test(w)) out.labels.push(body);
		else if (/^[!！]/.test(w) && p in PRIORITIES)
			out.priority = PRIORITIES[p as keyof typeof PRIORITIES];
		else words.push(w);
	}
	out.title = words.join(" ");
	return out;
}
