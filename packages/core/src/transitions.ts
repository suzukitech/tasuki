import { type Category, plans, type statuses } from "@tasuki/db";
import { and, eq } from "drizzle-orm";
import { type Ctx, fail, log, nowOf } from "./ctx";
import { endRank, type Loaded, patchIssue, statusFor } from "./issues";
import { requireSession } from "./permissions";

type Op =
	| "move"
	| "submitPlan"
	| "approvePlan"
	| "rejectPlan"
	| "startImplementation"
	| "updateCriteria"
	| "submitReport"
	| "returnReport"
	| "complete";
type Entry = { op: Op | Op[]; session?: true; approver?: true };
type Flow = Loaded["issue"]["flow"];

/**
 * The only place that says which status-category changes exist, who may perform
 * them and which human gates apply. flow -> from -> to.
 * ready -> in_progress additionally needs an approved plan (or skipPlanReview) in the ai flow.
 */
export const TRANSITIONS: Record<
	Flow,
	Partial<Record<Category, Partial<Record<Category, Entry>>>>
> = {
	ai: {
		draft: { ready: { op: "move" } },
		ready: {
			draft: { op: "move" },
			plan_review: { op: "submitPlan" },
			in_progress: { op: ["move", "startImplementation"] },
		},
		plan_review: {
			in_progress: { op: "approvePlan", session: true, approver: true },
			ready: { op: "rejectPlan", session: true, approver: true },
		},
		in_progress: {
			ready: { op: "move" },
			plan_review: { op: "updateCriteria" },
			impl_review: { op: "submitReport" },
		},
		impl_review: {
			in_progress: { op: "returnReport", session: true, approver: true },
			plan_review: { op: "updateCriteria" },
			done: { op: "complete", session: true, approver: true },
		},
		done: { ready: { op: "move", session: true } },
	},
	simple: {
		draft: { ready: { op: "move" } }, // flow switched while still a draft
		ready: {
			in_progress: { op: ["move", "startImplementation"] },
			done: { op: ["complete", "move"], session: true },
		},
		in_progress: {
			ready: { op: "move" },
			done: { op: ["complete", "move"], session: true },
		},
		done: {
			ready: { op: "move", session: true },
			in_progress: { op: "move", session: true },
		},
	},
};

const REVIEW: Category[] = ["plan_review", "impl_review"];

/** Approver, project manager or system admin (the latter two are `manager`). */
function requireApprover(c: Ctx, l: Loaded) {
	if (l.project.role !== "manager" && l.issue.approverId !== c.actor.userId)
		fail("forbidden", "approver or project manager only");
}

const hasApprovedPlan = (c: Ctx, issueId: string) =>
	!!c.db
		.select({ id: plans.id })
		.from(plans)
		.where(and(eq(plans.issueId, issueId), eq(plans.state, "approved")))
		.limit(1)
		.get();

/**
 * Change an issue's status category as `op`, enforcing the table, session and approver
 * requirements. A same-category call (rank reorder / status change) is always allowed.
 */
export function transition(
	c: Ctx,
	l: Loaded,
	to: Category,
	op: Op,
	opts: { target?: typeof statuses.$inferSelect; rank?: string } = {},
) {
	const from = l.category;
	if (from === to && op !== "move")
		fail("conflict", `issue is already in '${to}'`);
	if (from !== to) {
		const e = TRANSITIONS[l.issue.flow][from]?.[to];
		if (!e || ![e.op].flat().includes(op)) {
			if (REVIEW.includes(from))
				fail(
					"gate",
					"use approve/reject (plan) or accept/return (report) to leave a review state",
				);
			if (REVIEW.includes(to) && op === "move")
				fail(
					"invalid",
					"use submitPlan / submitReport to enter a review state",
				);
			fail("conflict", `cannot go from '${from}' to '${to}' (${op})`);
		}
		if (e?.session) requireSession(c, `${op} (${from} -> ${to})`);
		if (e?.approver) requireApprover(c, l);
		if (
			from === "ready" &&
			to === "in_progress" &&
			l.issue.flow === "ai" &&
			!l.issue.skipPlanReview &&
			!hasApprovedPlan(c, l.issue.id)
		)
			fail("gate", "no approved plan: submit a plan and get it approved first");
	}
	const target = opts.target ?? statusFor(c, l.project.id, to);
	patchIssue(c, l.issue.id, {
		statusId: target.id,
		rank: opts.rank ?? endRank(c, target.id),
		closedAt: to === "done" ? nowOf(c) : null,
	});
	if (l.issue.statusId !== target.id)
		log(c, l.issue.id, "updated", "status", l.statusName, target.name);
}
