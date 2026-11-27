import { describe, expect, test } from "bun:test";
import { activities, issues } from "@tasuki/db";
import { parseQuickTitle, reviewerOf, whoseTurn } from "@tasuki/schema";
import { eq } from "drizzle-orm";
import {
	addComment,
	createIssue,
	createProject,
	getIssue,
	loadIssue,
	type TasukiError,
	updateIssue,
} from "../src/index";
import { setup } from "./fixture";

const codeOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return (e as TasukiError).code;
	}
};

describe("createIssue", () => {
	test("numbers are sequential per project; ref is case-insensitive", () => {
		const { ctx, u, issue } = setup();
		const other = createProject(ctx(u.mem), { key: "OPS", name: "Ops" });
		expect([issue().number, issue().number, issue().number]).toEqual([1, 2, 3]);
		expect(createIssue(ctx(u.mem), "ops", { title: "a" }).number).toBe(1);
		expect(other.key).toBe("OPS");
		expect(loadIssue(ctx(u.mem), "web-2").issue.number).toBe(2);
		expect(codeOf(() => loadIssue(ctx(u.mem), "WEB2"))).toBe("invalid");
		expect(codeOf(() => loadIssue(ctx(u.mem), "WEB-99"))).toBe("not_found");
	});
	test("defaults: title only, draft for ai / ready for simple, reporter, approver", () => {
		const { ctx, u, issue } = setup();
		const a = issue();
		expect(a.reporterId).toBe(u.mem.id);
		expect(a.approverId).toBe(u.mem.id);
		expect(a.flow).toBe("ai");
		expect(getIssue(ctx(u.mem), "WEB-1").category).toBe("draft");
		const s = issue({ flow: "simple", approverId: u.mgr.id });
		expect(s.approverId).toBe(u.mgr.id);
		expect(getIssue(ctx(u.mem), "WEB-2").category).toBe("ready");
	});
	test("ranks increase within a status; labels deduped case-insensitively", () => {
		const { ctx, u, issue } = setup();
		const a = issue({ labels: ["bug", "Bug"] });
		const b = issue();
		expect(b.rank > a.rank).toBe(true);
		expect(getIssue(ctx(u.mem), "WEB-1").labels).toHaveLength(1);
	});
	test("validation", () => {
		const { ctx, u, issue } = setup();
		expect(codeOf(() => issue({ title: "  " }))).toBe("invalid");
		expect(codeOf(() => issue({ priority: 9 }))).toBe("invalid");
		expect(codeOf(() => issue({ assigneeId: u.out.id }))).toBe("invalid");
		expect(codeOf(() => issue({ typeId: "nope" }))).toBe("invalid");
		expect(codeOf(() => issue({ parentId: "nope" }))).toBe("invalid");
		expect(codeOf(() => createIssue(ctx(u.mem), "NOPE", { title: "x" }))).toBe(
			"not_found",
		);
		const p = issue();
		expect(issue({ parentId: p.id, assigneeId: u.admin.id }).parentId).toBe(
			p.id,
		);
	});
	test("activity row written with actor and via", () => {
		const { db, u, issue } = setup();
		const i = issue();
		const rows = db
			.select()
			.from(activities)
			.where(eq(activities.issueId, i.id))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "created",
			actorId: u.mem.id,
			via: "web",
		});
	});
});

describe("updateIssue", () => {
	test("logs one activity per changed field with via; no-op logs nothing", () => {
		const { db, ctx, u, issue } = setup();
		const i = issue();
		const t = ctx(u.mem, "token");
		const r = updateIssue(t, "WEB-1", {
			title: "New",
			priority: 3,
			labels: ["x", "y"],
			dueDate: "2026-12-01",
		});
		expect(r.title).toBe("New");
		const rows = db
			.select()
			.from(activities)
			.where(eq(activities.issueId, i.id))
			.all()
			.filter((a) => a.action === "updated");
		expect(rows.map((x) => x.field).sort()).toEqual([
			"dueDate",
			"labels",
			"priority",
			"title",
		]);
		expect(rows.every((x) => x.via === "mcp:test")).toBe(true);
		expect(rows.find((x) => x.field === "title")).toMatchObject({
			before: "Fix login",
			after: "New",
		});
		const before = db.select().from(activities).all().length;
		updateIssue(t, "WEB-1", { title: "New", labels: ["y", "x"] });
		expect(db.select().from(activities).all().length).toBe(before);
		updateIssue(t, "WEB-1", { priority: null, labels: [] });
		expect(getIssue(t, "WEB-1").issue.priority).toBeNull();
	});
	test("ifMatch conflict", () => {
		const { ctx, u, clock, issue } = setup();
		const i = issue();
		clock.t = new Date(clock.t.getTime() + 1000);
		const a = updateIssue(
			ctx(u.mem),
			"WEB-1",
			{ title: "A" },
			{ ifMatch: i.updatedAt.getTime() },
		);
		expect(
			codeOf(() =>
				updateIssue(
					ctx(u.mem2),
					"WEB-1",
					{ title: "B" },
					{ ifMatch: i.updatedAt.getTime() },
				),
			),
		).toBe("precondition");
		clock.t = new Date(clock.t.getTime() + 1000);
		expect(
			updateIssue(
				ctx(u.mem2),
				"WEB-1",
				{ title: "B" },
				{ ifMatch: a.updatedAt.getTime() },
			).title,
		).toBe("B");
	});
	test("tokens cannot flip flow / skipPlanReview; sessions can", () => {
		const { ctx, u, issue } = setup();
		issue();
		expect(
			codeOf(() =>
				updateIssue(ctx(u.mem, "token"), "WEB-1", { skipPlanReview: true }),
			),
		).toBe("gate");
		expect(
			codeOf(() =>
				updateIssue(ctx(u.mem, "token"), "WEB-1", { flow: "simple" }),
			),
		).toBe("gate");
		expect(
			updateIssue(ctx(u.mem, "token"), "WEB-1", {
				flow: "ai",
				skipPlanReview: false,
			}).flow,
		).toBe("ai");
		expect(
			updateIssue(ctx(u.mem), "WEB-1", { skipPlanReview: true }).skipPlanReview,
		).toBe(true);
	});
});

describe("comments / getIssue / misc", () => {
	test("comment by viewer; getIssue aggregates", () => {
		const { ctx, u, issue, db } = setup();
		const i = issue();
		addComment(ctx(u.view), "WEB-1", "looks good");
		const g = getIssue(ctx(u.view), "WEB-1");
		expect(g.comments).toHaveLength(1);
		expect(g.comments[0]).toMatchObject({ authorId: u.view.id, via: "web" });
		expect(g.activities.map((a) => a.action)).toEqual(["created", "commented"]);
		expect(codeOf(() => addComment(ctx(u.view), "WEB-1", " "))).toBe("invalid");
		expect(
			db.select().from(issues).where(eq(issues.id, i.id)).get(),
		).toBeDefined();
	});
	test("whoseTurn", () => {
		const base = { reporterId: "r", assigneeId: null, approverId: "a" };
		expect(whoseTurn({ ...base, category: "draft" }, "r")).toBe("you");
		expect(whoseTurn({ ...base, category: "draft" }, "z")).toBe("others");
		expect(whoseTurn({ ...base, category: "ready" }, "z")).toBe("others");
		expect(
			whoseTurn({ ...base, assigneeId: "x", category: "ready" }, "z"),
		).toBe("ai");
		expect(
			whoseTurn({ ...base, assigneeId: "x", category: "in_progress" }, "x"),
		).toBe("ai");
		expect(whoseTurn({ ...base, category: "plan_review" }, "a")).toBe("you");
		expect(
			whoseTurn({ ...base, approverId: null, category: "impl_review" }, "r"),
		).toBe("you");
		expect(whoseTurn({ ...base, category: "done" }, "a")).toBeNull();
	});
});

test("reviewerOf: approver, else the requester", () => {
	expect(reviewerOf({ approverId: "a", reporterId: "r" })).toBe("a");
	expect(reviewerOf({ approverId: null, reporterId: "r" })).toBe("r");
});

describe("parseQuickTitle", () => {
	test("half and full width symbols", () => {
		expect(parseQuickTitle("ログイン修正 @taro #bug !high")).toEqual({
			title: "ログイン修正",
			assignee: "taro",
			labels: ["bug"],
			priority: 3,
		});
		expect(parseQuickTitle("ログイン修正　＠花子　＃バグ　！urgent")).toEqual({
			title: "ログイン修正",
			assignee: "花子",
			labels: ["バグ"],
			priority: 4,
		});
		expect(parseQuickTitle("a@b.com !wat # ! x")).toEqual({
			title: "a@b.com !wat # ! x",
			labels: [],
		});
		expect(parseQuickTitle("x !LOW #a #b")).toEqual({
			title: "x",
			labels: ["a", "b"],
			priority: 1,
		});
	});
});

describe("ref checks", () => {
	test("parent cycles and viewer approver are rejected", () => {
		const w = setup();
		const m = w.ctx(w.u.mem);
		const a = w.issue({}, w.u.mem);
		const b = w.issue({ parentId: a.id }, w.u.mem);
		expect(codeOf(() => updateIssue(m, "WEB-1", { parentId: a.id }))).toBe(
			"invalid",
		);
		expect(codeOf(() => updateIssue(m, "WEB-1", { parentId: b.id }))).toBe(
			"invalid",
		);
		expect(
			codeOf(() =>
				updateIssue(w.ctx(w.u.mgr), "WEB-1", { approverId: w.u.view.id }),
			),
		).toBe("invalid");
		expect(codeOf(() => w.issue({ approverId: w.u.view.id }, w.u.mem))).toBe(
			"invalid",
		);
	});
});
