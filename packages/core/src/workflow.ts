import {
	acceptanceCriteria,
	activities,
	agentSessions,
	type Category,
	issues,
	planCriteria,
	plans,
	projects,
	questions,
	reports,
	statuses,
} from "@tasuki/db";
import {
	bulkInput,
	criteriaInput,
	type EventType,
	evidenceInput,
	noteInput,
	planInput,
	reportInput,
	reviewerOf,
} from "@tasuki/schema";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	atomic,
	type Ctx,
	fail,
	log,
	nowOf,
	parse,
	record,
	TasukiError,
} from "./ctx";
import {
	insertComment,
	type Loaded,
	loadIssue,
	loadIssueById,
	patchIssue,
	updateIssue,
} from "./issues";
import { notify } from "./notifications";
import {
	requireProjectRole,
	requireScope,
	requireSession,
} from "./permissions";
import { requireApprovedPlan, transition } from "./transitions";

const LOCK_MS = 30 * 60 * 1000;
const announce = (c: Ctx, l: Loaded, type: EventType) =>
	record(c, type, l.project.id, l.ref);
const reviewUrl = (ref: string, tab: string) => `/issues/${ref}?tab=${tab}`;

const hasOpenQuestion = (c: Ctx, issueId: string) =>
	!!c.db
		.select({ id: questions.id })
		.from(questions)
		.where(and(eq(questions.issueId, issueId), eq(questions.state, "open")))
		.limit(1)
		.get();

const hasPendingCriterion = (c: Ctx, issueId: string) =>
	!!c.db
		.select({ id: acceptanceCriteria.id })
		.from(acceptanceCriteria)
		.where(
			and(
				eq(acceptanceCriteria.issueId, issueId),
				eq(acceptanceCriteria.result, "pending"),
			),
		)
		.limit(1)
		.get();

const criteriaOf = (c: Ctx, issueId: string) =>
	c.db
		.select()
		.from(acceptanceCriteria)
		.where(eq(acceptanceCriteria.issueId, issueId))
		.orderBy(asc(acceptanceCriteria.position))
		.all();

const planIn = (c: Ctx, issueId: string, state: "proposed" | "approved") =>
	c.db
		.select()
		.from(plans)
		.where(and(eq(plans.issueId, issueId), eq(plans.state, state)))
		.orderBy(desc(plans.version))
		.get();

function endSessions(
	c: Ctx,
	issueId: string,
	outcome: string,
	extra?: SQL | undefined,
) {
	c.db
		.update(agentSessions)
		.set({ endedAt: nowOf(c), outcome })
		.where(
			and(
				eq(agentSessions.issueId, issueId),
				isNull(agentSessions.endedAt),
				extra,
			),
		)
		.run();
}

function requireState(l: Loaded, ...cats: Category[]) {
	if (!cats.includes(l.category))
		fail(
			"conflict",
			`issue is in '${l.category}', expected ${cats.join(" / ")}`,
		);
}

export function submitPlan(ctx: Ctx, ref: string, input: unknown) {
	const inp = parse(planInput, input);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		if (l.issue.flow !== "ai")
			fail("invalid", "simple-flow issues have no plan");
		if (hasOpenQuestion(c, l.issue.id))
			fail("gate", "answer open questions before submitting a plan");
		let crits = criteriaOf(c, l.issue.id);
		if (inp.criteria?.length && crits.length)
			fail("invalid", "criteria already exist: use updateCriteria");
		if (inp.criteria?.length) {
			crits = c.db
				.insert(acceptanceCriteria)
				.values(
					inp.criteria.map((x, position) => ({
						issueId: l.issue.id,
						text: x.text,
						position,
					})),
				)
				.returning()
				.all();
		}
		const mapped = new Map<string, string>();
		for (const m of inp.mapping) {
			const id = m.criterionId ?? crits[m.index ?? -1]?.id;
			if (!id || !crits.some((x) => x.id === id))
				return fail("invalid", "mapping refers to an unknown criterion");
			mapped.set(id, m.stepRef);
		}
		// older proposed/approved plans no longer apply
		c.db
			.update(plans)
			.set({ state: "superseded" })
			.where(
				and(
					eq(plans.issueId, l.issue.id),
					inArray(plans.state, ["proposed", "approved"]),
				),
			)
			.run();
		const last = c.db
			.select({ v: plans.version })
			.from(plans)
			.where(eq(plans.issueId, l.issue.id))
			.orderBy(desc(plans.version))
			.get();
		const plan = c.db
			.insert(plans)
			.values({
				issueId: l.issue.id,
				version: (last?.v ?? 0) + 1,
				understandingMd: inp.understandingMd,
				stepsMd: inp.stepsMd,
				risksMd: inp.risksMd,
				createdAt: nowOf(c),
			})
			.returning()
			.get();
		for (const [criterionId, stepRef] of mapped)
			c.db
				.insert(planCriteria)
				.values({ planId: plan.id, criterionId, stepRef })
				.run();
		transition(c, l, "plan_review", "submitPlan");
		log(c, l.issue.id, "plan_submitted", "plan", null, `v${plan.version}`);
		announce(c, l, "plan.submitted");
		notify(c, l, "plan_submitted", reviewerOf(l.issue));
		return { plan, reviewUrl: reviewUrl(l.ref, "plan") };
	});
}

function reviewPlan(ctx: Ctx, ref: string, approve: boolean, note?: string) {
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		transition(
			c,
			l,
			approve ? "in_progress" : "ready",
			approve ? "approvePlan" : "rejectPlan",
		);
		const plan = planIn(c, l.issue.id, "proposed");
		if (!plan) return fail("conflict", "no proposed plan");
		c.db
			.update(plans)
			.set({
				state: approve ? "approved" : "rejected",
				reviewedBy: c.actor.userId,
				reviewNote: note ?? null,
			})
			.where(eq(plans.id, plan.id))
			.run();
		log(
			c,
			l.issue.id,
			approve ? "plan_approved" : "plan_rejected",
			"plan",
			`v${plan.version}`,
			note,
		);
		announce(c, l, approve ? "plan.approved" : "plan.rejected");
		return {
			...plan,
			state: approve ? ("approved" as const) : ("rejected" as const),
		};
	});
}

/** HUMAN GATE (session only). */
export const approvePlan = (ctx: Ctx, ref: string, note?: string) =>
	reviewPlan(ctx, ref, true, note);
/** HUMAN GATE (session only). */
export const rejectPlan = (ctx: Ctx, ref: string, note: string) =>
	reviewPlan(ctx, ref, false, parse(noteInput, note));

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");

/** The issue's open, unexpired work lock (any holder), if any. */
const openSession = (c: Ctx, issueId: string) =>
	c.db
		.select()
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.issueId, issueId),
				isNull(agentSessions.endedAt),
				gt(agentSessions.expiresAt, nowOf(c)),
			),
		)
		.get();

/**
 * Take (or extend) the actor's work lock on `l`. Null when someone else holds it.
 * Does not touch the issue's status.
 */
function takeLock(c: Ctx, l: Loaded) {
	const now = nowOf(c);
	endSessions(c, l.issue.id, "expired", lte(agentSessions.expiresAt, now));
	const open = openSession(c, l.issue.id);
	if (open && open.userId !== c.actor.userId) return null;
	const expiresAt = new Date(now.getTime() + LOCK_MS);
	return open
		? c.db
				.update(agentSessions)
				.set({ expiresAt })
				.where(eq(agentSessions.id, open.id))
				.returning()
				.get()
		: c.db
				.insert(agentSessions)
				.values({
					issueId: l.issue.id,
					userId: c.actor.userId,
					client: c.actor.via,
					startedAt: now,
					expiresAt,
				})
				.returning()
				.get();
}

/**
 * The actor's next AI-flow task (assigned to them, ready / in_progress): highest
 * priority first, then oldest. Takes the work lock without changing the status.
 * Issues locked by someone else or outside the actor's reach are skipped.
 */
export function claimNext(ctx: Ctx) {
	requireScope(ctx, "write");
	return atomic(ctx, (c) => {
		const rows = c.db
			.select({ id: issues.id })
			.from(issues)
			.innerJoin(statuses, eq(statuses.id, issues.statusId))
			.where(
				and(
					eq(issues.assigneeId, c.actor.userId),
					eq(issues.flow, "ai"),
					inArray(statuses.category, ["ready", "in_progress"]),
				),
			)
			.orderBy(
				sql`coalesce(${issues.priority}, -1) desc`,
				asc(issues.createdAt),
				asc(issues.number),
			)
			.all();
		// a lock the actor already holds on an eligible issue wins over a new one
		const held = rows.find(
			(r) => openSession(c, r.id)?.userId === c.actor.userId,
		);
		for (const r of held ? [held, ...rows.filter((x) => x !== held)] : rows) {
			let l: Loaded;
			try {
				l = loadIssueById(c, r.id, "member");
			} catch (e) {
				if (e instanceof TasukiError && e.code === "forbidden") continue;
				throw e;
			}
			const session = takeLock(c, l);
			if (session) return { ref: l.ref, session };
		}
		return null;
	});
}

/** Answers to the actor's questions, plus the latest plan rejection / report return note. */
export function getAnswers(ctx: Ctx, ref: string) {
	const l = loadIssue(ctx, ref);
	const id = l.issue.id;
	const q = ctx.db.query;
	const mine = q.questions
		.findMany({
			where: and(
				eq(questions.issueId, id),
				eq(questions.askedBy, ctx.actor.userId),
			),
			orderBy: asc(questions.createdAt),
		})
		.sync();
	const plan = q.plans
		.findFirst({ where: eq(plans.issueId, id), orderBy: desc(plans.version) })
		.sync();
	const report = q.reports
		.findFirst({
			where: eq(reports.issueId, id),
			orderBy: desc(reports.createdAt),
		})
		.sync();
	const returned =
		report?.state === "returned"
			? q.activities
					.findFirst({
						where: and(
							eq(activities.issueId, id),
							eq(activities.action, "report_returned"),
						),
						orderBy: [desc(activities.createdAt), desc(activities.id)],
					})
					.sync()
			: undefined;
	return {
		ref: l.ref,
		questions: mine.map((x) => ({
			id: x.id,
			state: x.state,
			question: x.bodyMd,
			answer: x.answerMd,
		})),
		planRejection:
			plan?.state === "rejected"
				? { version: plan.version, note: plan.reviewNote }
				: null,
		reportReturn: returned ? { note: returned.after } : null,
	};
}

export function startImplementation(ctx: Ctx, ref: string) {
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		if (l.category !== "in_progress")
			transition(c, l, "in_progress", "startImplementation");
		else requireApprovedPlan(c, l); // e.g. flow switched simple -> ai mid-work
		const session = takeLock(c, l);
		if (!session)
			return fail("conflict", "another user is working on this issue");
		announce(c, l, "issue.started");
		const s = slug(l.issue.title);
		return { session, branch: s ? `${l.ref}-${s}` : l.ref };
	});
}

/** Extend the actor's work lock by 30 minutes. */
export function touchLock(ctx: Ctx, ref: string) {
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		const s = openSession(c, l.issue.id);
		if (!s || s.userId !== c.actor.userId)
			return fail("conflict", "no active work lock; call startImplementation");
		return c.db
			.update(agentSessions)
			.set({ expiresAt: new Date(nowOf(c).getTime() + LOCK_MS) })
			.where(eq(agentSessions.id, s.id))
			.returning()
			.get();
	});
}

/**
 * Keep the actor's own work lock on `ref` alive if they hold one. Null when there is
 * no lock, the ref is malformed / unknown, or the token cannot write; never throws
 * for those. A single UPDATE of the actor's own row, so no permission lookup is needed.
 */
export function extendLockIfHeld(ctx: Ctx, ref: string) {
	const m = /^([A-Za-z]{2,10})-(\d+)$/.exec(ref.trim());
	if (!m) return null;
	const project = ctx.db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.key, (m[1] ?? "").toUpperCase()))
		.get();
	if (!project) return null;
	// same access rule as every other write: write scope, token projectIds, member role
	try {
		requireProjectRole(ctx, project.id, "member");
	} catch (e) {
		if (e instanceof TasukiError) return null;
		throw e;
	}
	const now = nowOf(ctx);
	return (
		ctx.db
			.update(agentSessions)
			.set({ expiresAt: new Date(now.getTime() + LOCK_MS) })
			.where(
				and(
					eq(agentSessions.userId, ctx.actor.userId),
					isNull(agentSessions.endedAt),
					gt(agentSessions.expiresAt, now),
					inArray(
						agentSessions.issueId,
						ctx.db
							.select({ id: issues.id })
							.from(issues)
							.innerJoin(projects, eq(projects.id, issues.projectId))
							.where(
								and(
									eq(projects.key, (m[1] ?? "").toUpperCase()),
									eq(issues.number, Number(m[2])),
								),
							),
					),
				),
			)
			.returning()
			.get() ?? null
	);
}

/** The plan the AI should work from: the approved one, else the latest proposed. */
export function currentPlan<P extends { state: string }>(plans: P[]) {
	const rev = [...plans].reverse();
	return (
		rev.find((p) => p.state === "approved") ??
		rev.find((p) => p.state === "proposed")
	);
}

export function askQuestion(ctx: Ctx, ref: string, bodyMd: string) {
	const body = parse(noteInput, bodyMd);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		const q = c.db
			.insert(questions)
			.values({
				issueId: l.issue.id,
				askedBy: c.actor.userId,
				via: c.actor.via,
				bodyMd: body,
				createdAt: nowOf(c),
			})
			.returning()
			.get();
		log(c, l.issue.id, "question_asked");
		announce(c, l, "question.asked");
		notify(c, l, "question_asked", reviewerOf(l.issue));
		return q;
	});
}

/** HUMAN GATE (session only): answering is a human act. */
export function answerQuestion(ctx: Ctx, questionId: string, answerMd: string) {
	requireSession(ctx, "answering a question");
	const answer = parse(noteInput, answerMd);
	return atomic(ctx, (c) => {
		const q = c.db
			.select()
			.from(questions)
			.where(eq(questions.id, questionId))
			.get();
		if (!q) return fail("not_found", "question not found");
		const l = loadIssueById(c, q.issueId, "member");
		if (q.state !== "open") fail("conflict", "already answered");
		const done = c.db
			.update(questions)
			.set({
				answerMd: answer,
				answeredBy: c.actor.userId,
				answeredAt: nowOf(c),
				state: "answered",
			})
			.where(eq(questions.id, q.id))
			.returning()
			.get();
		log(c, q.issueId, "question_answered");
		announce(c, l, "question.answered");
		notify(c, l, "question_answered", l.issue.assigneeId ?? q.askedBy);
		return done;
	});
}

/** Replace the acceptance-criteria list. Changing it after approval revokes the approval. */
export function updateCriteria(ctx: Ctx, ref: string, criteria: unknown) {
	const next = parse(criteriaInput, criteria);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		const before = criteriaOf(c, l.issue.id);
		const keep = new Set(next.map((x) => x.id).filter(Boolean));
		let changed = false;
		for (const old of before) {
			if (!keep.has(old.id)) {
				c.db
					.delete(acceptanceCriteria)
					.where(eq(acceptanceCriteria.id, old.id))
					.run();
				changed = true;
			}
		}
		next.forEach((x, position) => {
			const old = before.find((o) => o.id === x.id);
			if (x.id && !old) fail("invalid", "unknown criterion id");
			if (old) {
				if (old.text !== x.text) {
					c.db
						.update(acceptanceCriteria)
						.set({
							text: x.text,
							position,
							result: "pending",
							evidenceMd: null,
							checkedBy: null,
						})
						.where(eq(acceptanceCriteria.id, old.id))
						.run();
					changed = true;
				} else if (old.position !== position) {
					c.db
						.update(acceptanceCriteria)
						.set({ position })
						.where(eq(acceptanceCriteria.id, old.id))
						.run();
				}
			} else {
				c.db
					.insert(acceptanceCriteria)
					.values({ issueId: l.issue.id, text: x.text, position })
					.run();
				changed = true;
			}
		});
		if (!changed) return criteriaOf(c, l.issue.id);
		announce(c, l, "criteria.updated");
		log(
			c,
			l.issue.id,
			"updated",
			"criteria",
			before.map((x) => x.text),
			next.map((x) => x.text),
		);
		// Criteria changed after approval: in ANY category the approval is void. While
		// working (in_progress / impl_review) the same plan goes back to `proposed` for
		// re-review; elsewhere it is superseded (a new plan must be submitted).
		const approved = planIn(c, l.issue.id, "approved");
		if (approved) {
			const working =
				l.category === "in_progress" || l.category === "impl_review";
			c.db
				.update(plans)
				.set(
					working
						? { state: "proposed", reviewedBy: null, reviewNote: null }
						: { state: "superseded" },
				)
				.where(eq(plans.id, approved.id))
				.run();
			endSessions(c, l.issue.id, "plan_revoked");
			if (l.category === "impl_review")
				c.db
					.update(reports)
					.set({ state: "returned" })
					.where(
						and(
							eq(reports.issueId, l.issue.id),
							eq(reports.state, "submitted"),
						),
					)
					.run();
			if (working) transition(c, l, "plan_review", "updateCriteria");
			else patchIssue(c, l.issue.id, {});
			log(
				c,
				l.issue.id,
				"plan_revoked",
				"plan",
				`v${approved.version}`,
				"criteria changed",
			);
		} else patchIssue(c, l.issue.id, {});
		return criteriaOf(c, l.issue.id);
	});
}

export function recordEvidence(
	ctx: Ctx,
	ref: string,
	criterionId: string,
	input: unknown,
) {
	const inp = parse(evidenceInput, input);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		requireState(l, "in_progress", "impl_review");
		const crit = c.db.query.acceptanceCriteria
			.findFirst({
				where: and(
					eq(acceptanceCriteria.id, criterionId),
					eq(acceptanceCriteria.issueId, l.issue.id),
				),
			})
			.sync();
		if (!crit) return fail("not_found", "criterion not found on this issue");
		const row = c.db
			.update(acceptanceCriteria)
			.set({
				result: inp.result,
				evidenceMd: inp.evidenceMd,
				checkedBy: c.actor.userId,
			})
			.where(eq(acceptanceCriteria.id, crit.id))
			.returning()
			.get();
		log(
			c,
			l.issue.id,
			"evidence",
			`criterion:${crit.id}`,
			crit.result,
			inp.result,
		);
		announce(c, l, "evidence.recorded");
		return row;
	});
}

export function submitReport(ctx: Ctx, ref: string, input: unknown) {
	const inp = parse(reportInput, input);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		if (hasOpenQuestion(c, l.issue.id))
			fail("gate", "answer open questions before reporting");
		if (hasPendingCriterion(c, l.issue.id))
			fail("gate", "record evidence for every acceptance criterion first");
		const report = c.db
			.insert(reports)
			.values({
				...inp,
				issueId: l.issue.id,
				planId: planIn(c, l.issue.id, "approved")?.id ?? null,
				createdAt: nowOf(c),
			})
			.returning()
			.get();
		endSessions(c, l.issue.id, "reported");
		transition(c, l, "impl_review", "submitReport");
		log(c, l.issue.id, "report_submitted");
		announce(c, l, "report.submitted");
		notify(c, l, "report_submitted", reviewerOf(l.issue));
		return { report, reviewUrl: reviewUrl(l.ref, "report") };
	});
}

/** Finish `l` (shared by completeIssue and a drag to a done status). */
function complete(
	c: Ctx,
	l: Loaded,
	op: "complete" | "move",
	opts: { target?: typeof statuses.$inferSelect; rank?: string } = {},
) {
	if (l.category === "done") fail("conflict", "already done");
	transition(c, l, "done", op, opts);
	if (l.issue.flow === "ai")
		c.db
			.update(reports)
			.set({ state: "accepted" })
			.where(
				and(eq(reports.issueId, l.issue.id), eq(reports.state, "submitted")),
			)
			.run();
	endSessions(c, l.issue.id, "completed");
	log(c, l.issue.id, "completed");
}

/**
 * HUMAN GATE (session only). AI flow: accept the report (impl_review -> done).
 * Simple flow: finish from any state.
 */
export function completeIssue(
	ctx: Ctx,
	ref: string,
	opts: { statusId?: string; rank?: string } = {},
) {
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		const target = opts.statusId ? statusIn(c, l, opts.statusId) : undefined;
		complete(c, l, "complete", { target, rank: opts.rank });
		announce(c, l, "issue.completed");
	});
}

/** HUMAN GATE (session only). */
export function returnReport(ctx: Ctx, ref: string, note: string) {
	const text = parse(noteInput, note);
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		transition(c, l, "in_progress", "returnReport");
		c.db
			.update(reports)
			.set({ state: "returned" })
			.where(
				and(eq(reports.issueId, l.issue.id), eq(reports.state, "submitted")),
			)
			.run();
		insertComment(c, l.issue.id, text);
		log(c, l.issue.id, "report_returned", undefined, undefined, text);
		announce(c, l, "report.returned");
	});
}

function statusIn(c: Ctx, l: Loaded, statusId: string) {
	const target = c.db.query.statuses
		.findFirst({ where: eq(statuses.id, statusId) })
		.sync();
	if (target?.projectId !== l.project.id)
		return fail("invalid", "unknown status");
	return target;
}

/** Drag-and-drop style move. Gated transitions must go through their workflow function. */
export function moveIssue(
	ctx: Ctx,
	ref: string,
	input: { statusId: string; rank?: string },
) {
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		const target = statusIn(c, l, input.statusId);
		const opts = { target, rank: input.rank };
		announce(c, l, "issue.moved");
		if (target.category === "done" && l.category !== "done") {
			announce(c, l, "issue.completed");
			return complete(c, l, "move", opts);
		}
		transition(c, l, target.category, "move", opts);
		if (l.category === "in_progress" && target.category !== l.category)
			endSessions(c, l.issue.id, "moved");
	});
}

/** assignee / status / labels for many issues, all or nothing. One `issue.updated` per issue. */
export function bulkUpdate(ctx: Ctx, input: unknown) {
	const { refs, statusId, ...fields } = parse(bulkInput, input);
	return atomic(ctx, (c) => {
		const edit = Object.fromEntries(
			Object.entries(fields).filter(([, v]) => v !== undefined),
		);
		for (const ref of refs) loadIssue(c, ref, "member"); // authorize all first
		if (!Object.keys(edit).length && !statusId)
			fail("invalid", "nothing to update");
		const inner: Ctx = { ...c, pending: [] }; // swallow the per-op events
		for (const ref of refs) {
			if (Object.keys(edit).length) updateIssue(inner, ref, edit);
			if (statusId) moveIssue(inner, ref, { statusId });
		}
		// user-scoped and webhook events pass through; the rest collapse to one update per issue
		const pass = ["notification.created", "issue.assigned", "issue.completed"];
		for (const e of inner.pending ?? [])
			if (pass.includes(e.type))
				record(c, e.type, e.projectId, e.ref, e.userId);
		for (const e of new Map(
			(inner.pending ?? []).map((e) => [e.ref, e]),
		).values())
			record(c, "issue.updated", e.projectId, e.ref);
		return refs;
	});
}
