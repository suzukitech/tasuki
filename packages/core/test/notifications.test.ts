import { describe, expect, test } from "bun:test";
import { projectMembers, statuses } from "@tasuki/db";
import {
	answerQuestion,
	approvePlan,
	askQuestion,
	bulkUpdate,
	createIssue,
	getIssue,
	type IssueEvent,
	listNotifications,
	markNotificationsRead,
	moveIssue,
	recordEvidence,
	setMember,
	startImplementation,
	submitPlan,
	submitReport,
	updateIssue,
} from "../src/index";
import { setup } from "./fixture";

const PLAN = {
	understandingMd: "u",
	stepsMd: "s",
	criteria: [{ text: "c" }],
	mapping: [{ index: 0, stepRef: "1" }],
};

function world() {
	const w = setup();
	const events: IssueEvent[] = [];
	const ctx = (
		user: { id: string },
		auth: "session" | "token" = "session",
		token?: { scopes: ("read" | "write")[]; projectIds: string[] | null },
	) => ({
		...w.ctx(user, auth, token),
		emit: (e: IssueEvent) => events.push(e),
	});
	// mgr is requester + approver; mem is the assignee (and the AI's owner)
	const i = createIssue(ctx(w.u.mgr), "WEB", {
		title: "Fix login",
		assigneeId: w.u.mem.id,
	});
	const kinds = (u: { id: string }) =>
		listNotifications(ctx(u)).items.map((n) => n.kind);
	return { ...w, ctx, events, ref: i.ref, kinds };
}

describe("notifications", () => {
	test("turn changes notify the right person, never the actor", () => {
		const w = world();
		expect(w.kinds(w.u.mem)).toEqual(["assigned"]);
		expect(w.kinds(w.u.mgr)).toEqual([]);
		const sid = (c: string) =>
			w.db
				.select()
				.from(statuses)
				.all()
				.find((s) => s.category === c && s.projectId === w.project.id)
				?.id as string;
		moveIssue(w.ctx(w.u.mem), w.ref, { statusId: sid("ready") });
		submitPlan(w.ctx(w.u.mem, "token"), w.ref, PLAN);
		expect(w.kinds(w.u.mgr)).toEqual(["plan_submitted"]);
		approvePlan(w.ctx(w.u.mgr), w.ref);
		askQuestion(w.ctx(w.u.mem, "token"), w.ref, "which db?");
		expect(w.kinds(w.u.mgr)).toContain("question_asked");
		const q = w.db.query.questions.findFirst().sync();
		answerQuestion(w.ctx(w.u.mgr), q?.id as string, "sqlite");
		expect(w.kinds(w.u.mem)).toContain("question_answered");
		expect(w.kinds(w.u.mem)).not.toContain("plan_submitted");
	});

	test("report submitted notifies the reviewer", () => {
		const w = world();
		const sid = w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === "ready" && s.projectId === w.project.id)
			?.id as string;
		moveIssue(w.ctx(w.u.mem), w.ref, { statusId: sid });
		const tok = w.ctx(w.u.mem, "token");
		submitPlan(tok, w.ref, PLAN);
		approvePlan(w.ctx(w.u.mgr), w.ref);
		startImplementation(tok, w.ref);
		const c = getIssue(tok, w.ref).criteria[0];
		recordEvidence(tok, w.ref, c?.id as string, { result: "met" });
		submitReport(tok, w.ref, { summaryMd: "ok", decisionsMd: "d" });
		expect(w.kinds(w.u.mgr)).toEqual(["report_submitted", "plan_submitted"]);
	});

	test("assigning yourself notifies nobody; reassigning and bulk notify the new assignee", () => {
		const w = world();
		createIssue(w.ctx(w.u.mem), "WEB", {
			title: "mine",
			assigneeId: w.u.mem.id,
		});
		expect(w.kinds(w.u.mem)).toEqual(["assigned"]); // only the first issue's
		updateIssue(w.ctx(w.u.mgr), w.ref, { assigneeId: w.u.mem2.id });
		expect(w.kinds(w.u.mem2)).toEqual(["assigned"]);
		w.events.length = 0;
		bulkUpdate(w.ctx(w.u.mgr), { refs: [w.ref], assigneeId: w.u.mem.id });
		expect(w.kinds(w.u.mem)).toHaveLength(2);
		expect(w.events.map((e) => e.type).sort()).toEqual([
			"issue.assigned",
			"issue.updated",
			"notification.created",
		]);
	});

	test("events are user-scoped and fire after commit", () => {
		const w = world();
		const e = w.events.find((x) => x.type === "notification.created");
		expect(e?.userId).toBe(w.u.mem.id);
		expect(w.events.some((x) => x.type === "issue.assigned")).toBe(true);
	});

	test("list: unread first; mark read by ids or all; only your own", () => {
		const w = world();
		createIssue(w.ctx(w.u.mgr), "WEB", { title: "2", assigneeId: w.u.mem.id });
		w.clock.t = new Date("2026-01-02T00:00:00Z");
		const first = listNotifications(w.ctx(w.u.mem));
		expect(first.unread).toBe(2);
		markNotificationsRead(w.ctx(w.u.mem), { ids: [first.items[1]?.id] });
		// someone else cannot mark mine
		markNotificationsRead(w.ctx(w.u.mgr), { all: true });
		const after = listNotifications(w.ctx(w.u.mem));
		expect(after.unread).toBe(1);
		expect(after.items.map((n) => !!n.readAt)).toEqual([false, true]);
		expect(after.items[0]?.title).toBe("2");
		markNotificationsRead(w.ctx(w.u.mem), { all: true });
		expect(listNotifications(w.ctx(w.u.mem)).unread).toBe(0);
		expect(() => markNotificationsRead(w.ctx(w.u.mem), { ids: [] })).toThrow();
		expect(listNotifications(w.ctx(w.u.mem), 1).items).toHaveLength(1);
	});

	test("items for a project you lost access to are hidden; tokens need scope", () => {
		const w = world();
		w.db.delete(projectMembers).run();
		expect(listNotifications(w.ctx(w.u.mem)).items).toEqual([]);
		expect(listNotifications(w.ctx(w.u.mem)).unread).toBe(0);
		setMember(w.ctx(w.u.admin), "WEB", w.u.mem.id, "member");
		expect(listNotifications(w.ctx(w.u.mem)).items).toHaveLength(1);
		expect(listNotifications(w.ctx(w.u.mem)).unread).toBe(1);
		const readOnly = w.ctx(w.u.mem, "token", {
			scopes: ["read"],
			projectIds: null,
		});
		expect(listNotifications(readOnly).items).toHaveLength(1);
		expect(() => markNotificationsRead(readOnly, { all: true })).toThrow();
	});
});
