import { describe, expect, test } from "bun:test";
import { agentSessions, plans, statuses } from "@tasuki/db";
import { eq } from "drizzle-orm";
import {
	answerQuestion,
	approvePlan,
	askQuestion,
	completeIssue,
	createIssue,
	getIssue,
	moveIssue,
	recordEvidence,
	rejectPlan,
	returnReport,
	startImplementation,
	submitPlan,
	submitReport,
	type TasukiError,
	touchLock,
	updateCriteria,
	updateIssue,
} from "../src/index";
import { TRANSITIONS } from "../src/transitions";
import { setup } from "./fixture";

const codeOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return (e as TasukiError).code;
	}
};

const PLAN = {
	understandingMd: "You want login fixed",
	stepsMd: "1. fix\n2. test",
	criteria: [{ text: "login works" }, { text: "test added" }],
	mapping: [
		{ index: 0, stepRef: "1" },
		{ index: 1, stepRef: "2" },
	],
};
const REPORT = { summaryMd: "done", decisionsMd: "chose X over Y" };

function world() {
	const w = setup();
	const { ctx, u, issue } = w;
	const tok = ctx(u.mem, "token"); // the AI, acting as mem
	const human = ctx(u.mem); // the human at the browser (also approver by default)
	issue({ assigneeId: u.mem.id });
	const ref = "WEB-1";
	const statusId = (cat: string) =>
		w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === cat && s.projectId === w.project.id)
			?.id as string;
	const cat = () => getIssue(human, ref).category;
	const toReady = () => moveIssue(human, ref, { statusId: statusId("ready") });
	const toPlanReview = () => {
		toReady();
		return submitPlan(tok, ref, PLAN);
	};
	const toInProgress = () => {
		toPlanReview();
		approvePlan(human, ref);
	};
	const allMet = () => {
		for (const c of getIssue(human, ref).criteria)
			recordEvidence(tok, ref, c.id, { result: "met", evidenceMd: "ok" });
	};
	const toImplReview = () => {
		toInProgress();
		allMet();
		submitReport(tok, ref, REPORT);
	};
	return {
		...w,
		tok,
		human,
		ref,
		statusId,
		cat,
		toReady,
		toPlanReview,
		toInProgress,
		allMet,
		toImplReview,
	};
}

describe("happy path", () => {
	test("draft -> ready -> plan_review -> in_progress -> impl_review -> done", () => {
		const w = world();
		expect(w.cat()).toBe("draft");
		w.toReady();
		expect(w.cat()).toBe("ready");
		const { plan, reviewUrl } = submitPlan(w.tok, w.ref, PLAN);
		expect(plan.version).toBe(1);
		expect(reviewUrl).toBe("/issues/WEB-1?tab=plan");
		expect(w.cat()).toBe("plan_review");
		expect(getIssue(w.human, w.ref).criteria).toHaveLength(2);
		approvePlan(w.human, w.ref, "lgtm");
		expect(w.cat()).toBe("in_progress");
		const { branch } = startImplementation(w.tok, w.ref);
		expect(branch).toBe("WEB-1-fix-login");
		w.allMet();
		const r = submitReport(w.tok, w.ref, REPORT);
		expect(r.reviewUrl).toBe("/issues/WEB-1?tab=report");
		expect(w.cat()).toBe("impl_review");
		expect(r.report.planId).toBe(plan.id);
		completeIssue(w.human, w.ref);
		const done = getIssue(w.human, w.ref);
		expect(done.category).toBe("done");
		expect(done.issue.closedAt).not.toBeNull();
		expect(done.reports[0]?.state).toBe("accepted");
		// every transition left an activity trail with via
		const acts = done.activities;
		expect(
			acts.some((a) => a.action === "plan_approved" && a.via === "web"),
		).toBe(true);
		expect(
			acts.some((a) => a.action === "plan_submitted" && a.via === "mcp:test"),
		).toBe(true);
		expect(
			acts.filter((a) => a.field === "status").length,
		).toBeGreaterThanOrEqual(5);
		const open = w.db
			.select()
			.from(agentSessions)
			.all()
			.filter((s) => !s.endedAt);
		expect(open).toHaveLength(0);
	});
	test("simple flow: no plan; done needs a human", () => {
		const w = setup();
		const human = w.ctx(w.u.mem);
		const tok = w.ctx(w.u.mem, "token");
		w.issue({ flow: "simple" });
		const all = w.db.select().from(statuses).all();
		const sid = (c: string) => all.find((s) => s.category === c)?.id as string;
		expect(codeOf(() => submitPlan(human, "WEB-1", PLAN))).toBe("invalid");
		expect(
			codeOf(() => moveIssue(human, "WEB-1", { statusId: sid("plan_review") })),
		).toBe("invalid");
		moveIssue(tok, "WEB-1", { statusId: sid("in_progress") });
		expect(getIssue(human, "WEB-1").category).toBe("in_progress");
		expect(
			codeOf(() => moveIssue(tok, "WEB-1", { statusId: sid("done") })),
		).toBe("gate");
		expect(
			codeOf(() => completeIssue(w.ctx(w.u.admin, "token"), "WEB-1")),
		).toBe("gate");
		moveIssue(human, "WEB-1", { statusId: sid("done") });
		expect(getIssue(human, "WEB-1").category).toBe("done");
		expect(codeOf(() => completeIssue(human, "WEB-1"))).toBe("conflict");
		// reopen
		moveIssue(human, "WEB-1", { statusId: sid("in_progress") });
		expect(getIssue(human, "WEB-1").issue.closedAt).toBeNull();
		expect(startImplementation(human, "WEB-1").branch).toBe("WEB-1-fix-login");
	});
});

describe("human gates reject tokens (even admin)", () => {
	test("plan and question gates", () => {
		const w = world();
		const adminTok = w.ctx(w.u.admin, "token");
		const mgrTok = w.ctx(w.u.mgr, "token");
		w.toPlanReview();
		for (const t of [w.tok, adminTok, mgrTok]) {
			expect(codeOf(() => approvePlan(t, w.ref))).toBe("gate");
			expect(codeOf(() => rejectPlan(t, w.ref, "no"))).toBe("gate");
		}
		const q = askQuestion(w.tok, w.ref, "which db?");
		expect(codeOf(() => answerQuestion(adminTok, q.id, "sqlite"))).toBe("gate");
		expect(w.cat()).toBe("plan_review");
	});
	test("report gates", () => {
		const w = world();
		w.toImplReview();
		for (const t of [w.tok, w.ctx(w.u.admin, "token")]) {
			expect(codeOf(() => completeIssue(t, w.ref))).toBe("gate");
			expect(codeOf(() => returnReport(t, w.ref, "redo"))).toBe("gate");
			expect(codeOf(() => completeIssue(t, w.ref))).toBe("gate");
			expect(
				codeOf(() => moveIssue(t, w.ref, { statusId: w.statusId("done") })),
			).toBe("gate");
		}
		expect(w.cat()).toBe("impl_review");
	});
	test("only approver or manager may approve; admin session may", () => {
		const w = world();
		w.toPlanReview();
		expect(codeOf(() => approvePlan(w.ctx(w.u.mem2), w.ref))).toBe("forbidden");
		expect(codeOf(() => approvePlan(w.ctx(w.u.view), w.ref))).toBe("forbidden");
		approvePlan(w.ctx(w.u.admin), w.ref);
		expect(w.cat()).toBe("in_progress");
	});
});

describe("plan", () => {
	test("submit only from ready; version increments and supersedes", () => {
		const w = world();
		expect(codeOf(() => submitPlan(w.tok, w.ref, PLAN))).toBe("conflict"); // draft
		w.toPlanReview();
		expect(codeOf(() => submitPlan(w.tok, w.ref, PLAN))).toBe("conflict"); // plan_review
		rejectPlan(w.human, w.ref, "missing tests");
		expect(w.cat()).toBe("ready");
		const first = getIssue(w.human, w.ref).criteria[0]?.id;
		const v2 = submitPlan(w.tok, w.ref, {
			...PLAN,
			criteria: undefined,
			mapping: [{ criterionId: first, stepRef: "1" }],
		});
		expect(v2.plan.version).toBe(2);
		const states = w.db
			.select()
			.from(plans)
			.all()
			.map((p) => `${p.version}:${p.state}`)
			.sort();
		expect(states).toEqual(["1:rejected", "2:proposed"]);
		expect(getIssue(w.human, w.ref).plans[0]?.reviewNote).toBe("missing tests");
		expect(getIssue(w.human, w.ref).criteria).toHaveLength(2); // not duplicated
	});
	test("validation", () => {
		const w = world();
		w.toPlanReview();
		expect(codeOf(() => rejectPlan(w.human, w.ref, " "))).toBe("invalid");
		rejectPlan(w.human, w.ref, "why");
		const bad = (p: object) =>
			codeOf(() => submitPlan(w.tok, w.ref, { ...PLAN, ...p }));
		expect(bad({ mapping: [{ index: 9, stepRef: "x" }] })).toBe("invalid");
		expect(bad({ mapping: [{ criterionId: "zzz", stepRef: "x" }] })).toBe(
			"invalid",
		);
		expect(bad({ mapping: [{ stepRef: "x" }] })).toBe("invalid");
		expect(bad({ understandingMd: "" })).toBe("invalid");
		expect(codeOf(() => approvePlan(w.human, w.ref))).toBe("conflict"); // back in ready
	});
	test("viewer cannot submit", () => {
		const w = world();
		w.toReady();
		expect(
			codeOf(() => submitPlan(w.ctx(w.u.view, "token"), w.ref, PLAN)),
		).toBe("forbidden");
	});
	test("a new plan supersedes an earlier approved one", () => {
		const w = world();
		w.toInProgress();
		moveIssue(w.human, w.ref, { statusId: w.statusId("ready") });
		submitPlan(w.tok, w.ref, { ...PLAN, criteria: undefined, mapping: [] });
		expect(
			w.db
				.select()
				.from(plans)
				.all()
				.map((p) => p.state)
				.sort(),
		).toEqual(["proposed", "superseded"]);
		expect(codeOf(() => startImplementation(w.tok, w.ref))).toBe("gate");
	});
});

describe("startImplementation / lock", () => {
	test("needs approved plan unless skip_plan_review", () => {
		const w = world();
		w.toReady();
		expect(codeOf(() => startImplementation(w.tok, w.ref))).toBe("gate");
		updateIssue(w.human, w.ref, { skipPlanReview: true });
		expect(startImplementation(w.tok, w.ref).branch).toBe("WEB-1-fix-login");
		expect(w.cat()).toBe("in_progress");
	});
	test("draft state conflicts even when skipping plan review", () => {
		const w = world();
		updateIssue(w.human, w.ref, { skipPlanReview: true });
		expect(codeOf(() => startImplementation(w.tok, w.ref))).toBe("conflict");
	});
	test("branch slug: non-ascii title falls back to key-number; long titles trimmed", () => {
		const w = setup();
		w.issue({ title: "ログインを直す", skipPlanReview: true });
		w.issue({
			title:
				"  Hello, World!! a very long title that goes on and on forever and ever ",
			skipPlanReview: true,
		});
		const ready = w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === "ready")?.id as string;
		for (const r of ["WEB-1", "WEB-2"])
			moveIssue(w.ctx(w.u.mem), r, { statusId: ready });
		expect(startImplementation(w.ctx(w.u.mem), "WEB-1").branch).toBe("WEB-1");
		const b = startImplementation(w.ctx(w.u.mem), "WEB-2").branch;
		expect(b.startsWith("WEB-2-hello-world-a-very-long")).toBe(true);
		expect(b.endsWith("-")).toBe(false);
	});
	test("lock: conflict between users, re-entry, touch, expiry takeover", () => {
		const w = world();
		w.toInProgress();
		const mem2 = w.ctx(w.u.mem2, "token");
		const s1 = startImplementation(w.tok, w.ref).session;
		expect(codeOf(() => startImplementation(mem2, w.ref))).toBe("conflict");
		expect(startImplementation(w.tok, w.ref).session.id).toBe(s1.id);
		w.clock.t = new Date(w.clock.t.getTime() + 20 * 60_000);
		expect(touchLock(w.tok, w.ref).expiresAt.getTime()).toBe(
			w.clock.t.getTime() + 30 * 60_000,
		);
		expect(codeOf(() => touchLock(mem2, w.ref))).toBe("conflict");
		w.clock.t = new Date(w.clock.t.getTime() + 31 * 60_000);
		expect(codeOf(() => touchLock(w.tok, w.ref))).toBe("conflict"); // expired
		const s2 = startImplementation(mem2, w.ref).session;
		expect(s2.userId).toBe(w.u.mem2.id);
		const rows = w.db
			.select()
			.from(agentSessions)
			.where(eq(agentSessions.issueId, s1.issueId))
			.all();
		expect(rows.find((r) => r.id === s1.id)?.outcome).toBe("expired");
	});
});

describe("questions", () => {
	test("open question blocks plan and report; answering unblocks", () => {
		const w = world();
		w.toReady();
		const q = askQuestion(w.tok, w.ref, "which db?");
		expect(codeOf(() => submitPlan(w.tok, w.ref, PLAN))).toBe("gate");
		expect(codeOf(() => answerQuestion(w.ctx(w.u.out), q.id, "x"))).toBe(
			"forbidden",
		);
		expect(codeOf(() => answerQuestion(w.human, "nope", "x"))).toBe(
			"not_found",
		);
		expect(answerQuestion(w.human, q.id, "sqlite").state).toBe("answered");
		expect(codeOf(() => answerQuestion(w.human, q.id, "again"))).toBe(
			"conflict",
		);
		submitPlan(w.tok, w.ref, PLAN);
		approvePlan(w.human, w.ref);
		w.allMet();
		askQuestion(w.tok, w.ref, "one more");
		expect(codeOf(() => submitReport(w.tok, w.ref, REPORT))).toBe("gate");
	});
});

describe("criteria", () => {
	test("changing criteria after approval revokes approval and returns to plan_review", () => {
		const w = world();
		w.toInProgress();
		startImplementation(w.tok, w.ref);
		const [c1, c2] = getIssue(w.human, w.ref).criteria;
		const keep1 = { id: c1?.id, text: c1?.text as string };
		const keep2 = { id: c2?.id, text: c2?.text as string };
		recordEvidence(w.tok, w.ref, c1?.id as string, {
			result: "met",
			evidenceMd: "ok",
		});
		updateCriteria(w.human, w.ref, [keep1, keep2]); // no-op
		expect(w.cat()).toBe("in_progress");
		updateCriteria(w.human, w.ref, [keep2, keep1]); // reorder only
		expect(w.cat()).toBe("in_progress");
		updateCriteria(w.human, w.ref, [
			{ id: c1?.id, text: "login works for SSO" },
			keep2,
			{ text: "new one" },
		]);
		const g = getIssue(w.human, w.ref);
		expect(g.category).toBe("plan_review");
		expect(g.plans[0]).toMatchObject({
			state: "rejected",
			reviewNote: "criteria changed",
		});
		expect(g.criteria.find((c) => c.id === c1?.id)?.result).toBe("pending");
		expect(g.criteria).toHaveLength(3);
		expect(g.activities.some((a) => a.action === "plan_revoked")).toBe(true);
		expect(
			w.db
				.select()
				.from(agentSessions)
				.all()
				.every((s) => s.endedAt),
		).toBe(true);
		updateCriteria(w.human, w.ref, [keep2]); // removal
		expect(getIssue(w.human, w.ref).criteria).toHaveLength(1);
		expect(
			codeOf(() =>
				updateCriteria(w.human, w.ref, [{ id: "bogus", text: "x" }]),
			),
		).toBe("invalid");
	});
	test("editing criteria during plan_review keeps state", () => {
		const w = world();
		w.toPlanReview();
		updateCriteria(w.human, w.ref, [{ text: "only this" }]);
		expect(w.cat()).toBe("plan_review");
		expect(getIssue(w.human, w.ref).criteria).toHaveLength(1);
	});
	test("evidence: state, ownership, result validation", () => {
		const w = world();
		w.toPlanReview();
		const c = getIssue(w.human, w.ref).criteria[0]?.id as string;
		expect(
			codeOf(() => recordEvidence(w.tok, w.ref, c, { result: "met" })),
		).toBe("conflict");
		approvePlan(w.human, w.ref);
		expect(
			codeOf(() => recordEvidence(w.tok, w.ref, "nope", { result: "met" })),
		).toBe("not_found");
		expect(
			codeOf(() => recordEvidence(w.tok, w.ref, c, { result: "pending" })),
		).toBe("invalid");
		const r = recordEvidence(w.tok, w.ref, c, {
			result: "unsure",
			evidenceMd: "flaky",
		});
		expect(r).toMatchObject({ result: "unsure", checkedBy: w.u.mem.id });
	});
});

describe("report", () => {
	test("rejected with pending criteria, empty/oversize fields; wrong state", () => {
		const w = world();
		expect(codeOf(() => submitReport(w.tok, w.ref, REPORT))).toBe("conflict");
		w.toInProgress();
		expect(codeOf(() => submitReport(w.tok, w.ref, REPORT))).toBe("gate"); // pending
		w.allMet();
		const bad = (p: object) => codeOf(() => submitReport(w.tok, w.ref, p));
		expect(bad({ ...REPORT, decisionsMd: "" })).toBe("invalid");
		expect(bad({ ...REPORT, decisionsMd: "   " })).toBe("invalid");
		expect(bad({ summaryMd: "x" })).toBe("invalid");
		expect(bad({ ...REPORT, summaryMd: "あ".repeat(601) })).toBe("invalid");
		expect(bad({ ...REPORT, testsMd: "a".repeat(4001) })).toBe("invalid");
		submitReport(w.tok, w.ref, {
			...REPORT,
			summaryMd: "あ".repeat(600),
			prUrl: "https://x/pr/1",
			branch: "b",
		});
		expect(w.cat()).toBe("impl_review");
	});
	test("return sends back with the reason as a comment; resubmit and accept", () => {
		const w = world();
		w.toImplReview();
		expect(codeOf(() => returnReport(w.human, w.ref, ""))).toBe("invalid");
		expect(codeOf(() => returnReport(w.ctx(w.u.mem2), w.ref, "no"))).toBe(
			"forbidden",
		);
		returnReport(w.human, w.ref, "fix the edge case");
		const g = getIssue(w.human, w.ref);
		expect(g.category).toBe("in_progress");
		expect(g.reports[0]?.state).toBe("returned");
		expect(g.comments.map((c) => c.bodyMd)).toContain("fix the edge case");
		submitReport(w.tok, w.ref, REPORT);
		completeIssue(w.human, w.ref);
		expect(w.cat()).toBe("done");
	});
	test("ai flow cannot be completed from in_progress", () => {
		const w = world();
		w.toInProgress();
		expect(codeOf(() => completeIssue(w.human, w.ref))).toBe("conflict");
		expect(
			codeOf(() => moveIssue(w.human, w.ref, { statusId: w.statusId("done") })),
		).toBe("conflict");
	});
});

describe("moveIssue cannot bypass gates", () => {
	test("no approved plan", () => {
		const w = world();
		const mv = (t: ReturnType<typeof w.ctx>, cat: string) =>
			codeOf(() => moveIssue(t, w.ref, { statusId: w.statusId(cat) }));
		w.toReady();
		expect(mv(w.tok, "in_progress")).toBe("gate");
		expect(mv(w.human, "in_progress")).toBe("gate");
		expect(mv(w.tok, "plan_review")).toBe("invalid");
		expect(mv(w.tok, "impl_review")).toBe("invalid");
		expect(mv(w.tok, "done")).toBe("conflict"); // ready -> done has no entry in the ai flow
		submitPlan(w.tok, w.ref, PLAN);
		expect(mv(w.tok, "in_progress")).toBe("gate"); // plan_review -> in_progress: use approvePlan
		expect(mv(w.human, "in_progress")).toBe("gate");
		expect(mv(w.tok, "ready")).toBe("gate");
		expect(w.cat()).toBe("plan_review");
	});
	test("with approved plan the token may move around; leaving in_progress ends the lock", () => {
		const w = world();
		w.toInProgress();
		startImplementation(w.tok, w.ref);
		const mv = (cat: string) =>
			codeOf(() => moveIssue(w.tok, w.ref, { statusId: w.statusId(cat) }));
		expect(mv("ready")).toBeUndefined();
		expect(
			w.db
				.select()
				.from(agentSessions)
				.all()
				.every((s) => s.endedAt),
		).toBe(true);
		expect(mv("in_progress")).toBeUndefined();
		w.allMet();
		submitReport(w.tok, w.ref, REPORT);
		expect(mv("in_progress")).toBe("gate");
		expect(
			codeOf(() =>
				moveIssue(w.human, w.ref, { statusId: w.statusId("ready") }),
			),
		).toBe("gate");
	});
	test("skip_plan_review allows the move; reorder in place; bad status; viewer", () => {
		const w = world();
		updateIssue(w.human, w.ref, { skipPlanReview: true });
		w.toReady();
		moveIssue(w.tok, w.ref, { statusId: w.statusId("in_progress") });
		expect(w.cat()).toBe("in_progress");
		moveIssue(w.tok, w.ref, {
			statusId: w.statusId("in_progress"),
			rank: "a0",
		});
		expect(getIssue(w.human, w.ref).issue.rank).toBe("a0");
		expect(codeOf(() => moveIssue(w.tok, w.ref, { statusId: "nope" }))).toBe(
			"invalid",
		);
		expect(
			codeOf(() =>
				moveIssue(w.ctx(w.u.view), w.ref, { statusId: w.statusId("draft") }),
			),
		).toBe("forbidden");
	});
});

describe("tokens cannot change who/what gates an issue", () => {
	test("create: flow, skipPlanReview, approver need a session", () => {
		const { ctx, u } = setup();
		const tok = ctx(u.mem, "token");
		const create = (input: Record<string, unknown>) => () =>
			createIssue(tok, "WEB", { title: "t", ...input });
		expect(codeOf(create({ flow: "simple" }))).toBe("gate");
		expect(codeOf(create({ skipPlanReview: true }))).toBe("gate");
		expect(codeOf(create({ approverId: u.mem2.id }))).toBe("gate");
		expect(codeOf(create({ approverId: u.mem.id }))).toBeUndefined();
		expect(
			codeOf(() =>
				createIssue(ctx(u.mem), "WEB", { title: "t", skipPlanReview: true }),
			),
		).toBeUndefined();
	});

	test("update: approver change needs a session", () => {
		const { ctx, u, issue } = setup();
		issue({}, u.mgr);
		expect(
			codeOf(() =>
				updateIssue(ctx(u.mem, "token"), "WEB-1", { approverId: u.mem.id }),
			),
		).toBe("gate");
		expect(
			codeOf(() => updateIssue(ctx(u.mgr), "WEB-1", { approverId: u.mem.id })),
		).toBeUndefined();
	});
});

describe("transition table", () => {
	const CATS = [
		"draft",
		"ready",
		"plan_review",
		"in_progress",
		"impl_review",
		"done",
	] as const;
	const reach = (w: ReturnType<typeof world>, cat: (typeof CATS)[number]) => {
		if (cat === "ready") w.toReady();
		if (cat === "plan_review") w.toPlanReview();
		if (cat === "in_progress") w.toInProgress();
		if (cat === "impl_review" || cat === "done") w.toImplReview();
		if (cat === "done") completeIssue(w.human, w.ref);
	};
	const allowsMove = (flow: "ai" | "simple", from: string, to: string) =>
		[
			(
				TRANSITIONS[flow] as Record<
					string,
					Record<string, { op: string | string[] }>
				>
			)[from]?.[to]?.op,
		]
			.flat()
			.includes("move");

	test("ai flow: move succeeds exactly where the table says op 'move'", () => {
		for (const from of CATS)
			for (const to of CATS) {
				if (from === to) continue;
				const w = world();
				reach(w, from);
				expect(w.cat()).toBe(from);
				const code = codeOf(() =>
					moveIssue(w.human, w.ref, { statusId: w.statusId(to) }),
				);
				if (allowsMove("ai", from, to)) {
					// ready -> in_progress additionally needs an approved plan or skip
					if (!(from === "ready" && to === "in_progress"))
						expect([from, to, code]).toEqual([from, to, undefined]);
				} else
					expect([from, to, code === undefined]).toEqual([from, to, false]);
			}
	});
	test("moveIssue cannot complete an ai issue from any state", () => {
		for (const from of ["ready", "plan_review", "impl_review"] as const) {
			const w = world();
			reach(w, from);
			expect(
				codeOf(() =>
					moveIssue(w.human, w.ref, { statusId: w.statusId("done") }),
				),
			).toBeDefined();
			expect(w.cat()).toBe(from);
		}
	});
	test("simple flow: token cannot complete", () => {
		const w = setup();
		w.issue({ flow: "simple" });
		const done = w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === "done")?.id as string;
		const tok = w.ctx(w.u.mem, "token");
		expect(codeOf(() => completeIssue(tok, "WEB-1"))).toBe("gate");
		expect(codeOf(() => moveIssue(tok, "WEB-1", { statusId: done }))).toBe(
			"gate",
		);
	});
});
