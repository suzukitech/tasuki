import {
	acceptanceCriteria,
	activities,
	type Category,
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
	statuses,
	users,
} from "@tasuki/db";
import {
	createIssueInput,
	noteInput,
	PRIORITIES,
	updateIssueInput,
} from "@tasuki/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { atomic, type Ctx, fail, log, logAll, nowOf, parse } from "./ctx";
import { type Role, requireProjectRole, requireSession } from "./permissions";
import { getProject } from "./projects";

export const refOf = (key: string, number: number) => `${key}-${number}`;

const issueRow = {
	issue: issues,
	category: statuses.category,
	statusName: statuses.name,
};

function loaded(
	project: typeof projects.$inferSelect,
	role: Role,
	row: { issue: Issue; category: Category; statusName: string },
) {
	return {
		...row,
		project: { ...project, role },
		ref: refOf(project.key, row.issue.number),
	};
}

/** Load an issue by "KEY-12" ref and check the actor's role in its project. */
export function loadIssue(
	ctx: Ctx,
	ref: string,
	min: Role = "viewer",
	kind?: "read" | "write",
) {
	const m = /^([A-Za-z]{2,10})-(\d+)$/.exec(ref.trim());
	if (!m) return fail("invalid", `bad issue ref: ${ref}`);
	const { role, ...project } = getProject(ctx, m[1] ?? "", min, kind);
	const row = ctx.db
		.select(issueRow)
		.from(issues)
		.innerJoin(statuses, eq(statuses.id, issues.statusId))
		.where(
			and(eq(issues.projectId, project.id), eq(issues.number, Number(m[2]))),
		)
		.get();
	if (!row) return fail("not_found", `issue ${ref} not found`);
	return loaded(project, role, row);
}

/** Same as loadIssue, by issue id. */
export function loadIssueById(ctx: Ctx, id: string, min: Role = "viewer") {
	const row = ctx.db
		.select({ ...issueRow, project: projects })
		.from(issues)
		.innerJoin(statuses, eq(statuses.id, issues.statusId))
		.innerJoin(projects, eq(projects.id, issues.projectId))
		.where(eq(issues.id, id))
		.get();
	if (!row) return fail("not_found", "issue not found");
	const role = requireProjectRole(ctx, row.project.id, min);
	return loaded(row.project, role, row);
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

export function endRank(ctx: Ctx, statusId: string) {
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

type Refs = Partial<
	Pick<Issue, "assigneeId" | "approverId" | "typeId" | "parentId">
>;

/** Validate ref fields that are set and differ from `current` (all of them on create). */
function checkRefs(ctx: Ctx, projectId: string, p: Refs, current?: Refs) {
	const changed = (f: keyof Refs) => (p[f] !== current?.[f] ? p[f] : null);
	for (const uid of [changed("assigneeId"), changed("approverId")]) {
		if (!uid) continue;
		const u = ctx.db.query.users.findFirst({ where: eq(users.id, uid) }).sync();
		const m = ctx.db.query.projectMembers
			.findFirst({
				where: and(
					eq(projectMembers.projectId, projectId),
					eq(projectMembers.userId, uid),
				),
			})
			.sync();
		if (!u || (!m && u.role !== "admin"))
			fail("invalid", "assignee/approver must be a project member");
	}
	const typeId = changed("typeId");
	if (
		typeId &&
		ctx.db.query.issueTypes
			.findFirst({ where: eq(issueTypes.id, typeId) })
			.sync()?.projectId !== projectId
	)
		fail("invalid", "unknown issue type");
	const parentId = changed("parentId");
	if (
		parentId &&
		ctx.db.query.issues.findFirst({ where: eq(issues.id, parentId) }).sync()
			?.projectId !== projectId
	)
		fail("invalid", "unknown parent issue");
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

/** Replace the issue's labels (creating missing ones). Returns false if nothing changed. */
function setLabels(
	ctx: Ctx,
	projectId: string,
	issueId: string,
	names: string[],
) {
	const want = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
	const existing = want.length
		? ctx.db
				.select()
				.from(labels)
				.where(
					and(
						eq(labels.projectId, projectId),
						inArray(
							sql`lower(${labels.name})`,
							want.map((n) => n.toLowerCase()),
						),
					),
				)
				.all()
		: [];
	const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
	const ids = want.map(
		(name) =>
			byName.get(name.toLowerCase()) ??
			ctx.db.insert(labels).values({ projectId, name }).returning().get().id,
	);
	const cur = ctx.db
		.select({ id: issueLabels.labelId })
		.from(issueLabels)
		.where(eq(issueLabels.issueId, issueId))
		.all();
	if (cur.length === ids.length && cur.every((r) => ids.includes(r.id)))
		return false;
	ctx.db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run();
	if (ids.length)
		ctx.db
			.insert(issueLabels)
			.values(ids.map((labelId) => ({ issueId, labelId })))
			.run();
	return true;
}

export function createIssue(ctx: Ctx, projectKey: string, input: unknown) {
	const inp = parse(createIssueInput, input);
	const project = getProject(ctx, projectKey, "member");
	return atomic(ctx, (c) => {
		guardGateFields(c, inp, {
			flow: "ai",
			skipPlanReview: false,
			approverId: c.actor.userId,
		});
		checkRefs(c, project.id, inp);
		const n = c.db
			.update(projects)
			.set({ nextNumber: sql`${projects.nextNumber} + 1` })
			.where(eq(projects.id, project.id))
			.returning({ n: projects.nextNumber })
			.get()?.n;
		if (!n) return fail("not_found", "project not found");
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
	const q = ctx.db.query;
	return {
		...l,
		labels: labelNames(ctx, id),
		criteria: q.acceptanceCriteria
			.findMany({
				where: eq(acceptanceCriteria.issueId, id),
				orderBy: asc(acceptanceCriteria.position),
			})
			.sync(),
		plans: q.plans
			.findMany({
				where: eq(plans.issueId, id),
				orderBy: asc(plans.version),
			})
			.sync(),
		reports: q.reports
			.findMany({
				where: eq(reports.issueId, id),
				orderBy: asc(reports.createdAt),
			})
			.sync(),
		questions: q.questions
			.findMany({
				where: eq(questions.issueId, id),
				orderBy: asc(questions.createdAt),
			})
			.sync(),
		comments: q.comments
			.findMany({
				where: eq(comments.issueId, id),
				orderBy: asc(comments.createdAt),
			})
			.sync(),
		activities: q.activities
			.findMany({
				where: eq(activities.issueId, id),
				orderBy: asc(activities.createdAt),
			})
			.sync(),
	};
}

/**
 * flow / skip_plan_review decide which gates apply, and approver_id decides who
 * passes them: a token (= an AI) must not change any of them, on create or update.
 */
function guardGateFields(
	c: Ctx,
	inp: { flow?: string; skipPlanReview?: boolean; approverId?: string | null },
	current: Pick<Issue, "flow" | "skipPlanReview" | "approverId">,
) {
	const changed = (["flow", "skipPlanReview", "approverId"] as const).some(
		(f) => inp[f] !== undefined && inp[f] !== current[f],
	);
	if (changed) requireSession(c, "changing flow / skipPlanReview / approver");
}

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
		guardGateFields(c, inp, issue);
		checkRefs(c, project.id, inp, issue);
		const set: Record<string, unknown> = {};
		const acts: Parameters<typeof logAll>[2] = [];
		for (const [f, v] of Object.entries(inp)) {
			if (f === "labels" || v === undefined) continue;
			const cur = issue[f as keyof Issue];
			if (v !== cur) {
				set[f] = v;
				acts.push({ action: "updated", field: f, before: cur, after: v });
			}
		}
		if (inp.labels) {
			const before = labelNames(c, issue.id);
			if (setLabels(c, project.id, issue.id, inp.labels)) {
				acts.push({
					action: "updated",
					field: "labels",
					before,
					after: labelNames(c, issue.id),
				});
				set.updatedAt = nowOf(c);
			}
		}
		logAll(c, issue.id, acts);
		return Object.keys(set).length ? patchIssue(c, issue.id, set) : issue;
	});
}

export function deleteIssue(ctx: Ctx, ref: string) {
	const { issue } = loadIssue(ctx, ref, "manager");
	ctx.db.delete(issues).where(eq(issues.id, issue.id)).run();
}

export function insertComment(c: Ctx, issueId: string, bodyMd: string) {
	return c.db
		.insert(comments)
		.values({
			issueId,
			authorId: c.actor.userId,
			bodyMd,
			via: c.actor.via,
			createdAt: nowOf(c),
		})
		.returning()
		.get();
}

export function addComment(ctx: Ctx, ref: string, bodyMd: string) {
	const body = parse(noteInput, bodyMd);
	return atomic(ctx, (c) => {
		const { issue } = loadIssue(c, ref, "viewer", "write");
		const row = insertComment(c, issue.id, body);
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
