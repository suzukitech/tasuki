import { describe, expect, test } from "bun:test";
import { statuses } from "@tasuki/db";
import {
	moveIssue,
	parseFilter,
	searchIssues,
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

describe("parseFilter", () => {
	test("full syntax", () => {
		const ast = parseFilter(
			'status:open assignee:me label:bug priority:>=high due:<2026-12-31 "ログイン 画面" free 12:30',
		);
		expect(ast.conds).toEqual([
			{ key: "status", value: "open" },
			{ key: "assignee", value: "me" },
			{ key: "label", value: "bug" },
			{ key: "priority", op: ">=", value: 3 },
			{ key: "due", op: "<", value: "2026-12-31" },
		]);
		expect(ast.terms).toEqual(["ログイン 画面", "free", "12:30"]);
		expect(
			parseFilter("priority:2 due:2026-01-01 priority:<=urgent").conds,
		).toHaveLength(3);
		expect(parseFilter('"" ').terms).toEqual([]);
	});
	test("invalid", () => {
		for (const q of [
			"foo:bar",
			"status:",
			"priority:huge",
			"due:tomorrow",
			"priority:>9",
		])
			expect(codeOf(() => parseFilter(q))).toBe("invalid");
	});
});

describe("searchIssues", () => {
	function data() {
		const w = setup();
		const m = w.ctx(w.u.mem);
		w.issue({
			title: "ログイン画面を直す",
			labels: ["bug"],
			priority: 4,
			assigneeId: w.u.mem.id,
			dueDate: "2026-06-01",
		});
		w.issue({
			title: "検索",
			bodyMd: "全文検索を速くする",
			priority: 1,
			dueDate: "2027-01-01",
		});
		w.issue({
			title: "Dark mode",
			labels: ["Feature"],
			assigneeId: w.u.mem2.id,
		});
		const done = w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === "done")?.id as string;
		const ready = w.db
			.select()
			.from(statuses)
			.all()
			.find((s) => s.category === "ready")?.id as string;
		updateIssue(m, "WEB-3", { flow: "simple" });
		moveIssue(m, "WEB-3", { statusId: ready });
		moveIssue(m, "WEB-3", { statusId: done });
		const q = (s: string, c = m) =>
			searchIssues(c, "web", s).map((i) => i.number);
		return { ...w, q, m };
	}
	test("conditions", () => {
		const { q, m, ctx, u } = data();
		expect(q("")).toEqual([1, 2, 3]);
		expect(q("status:open")).toEqual([1, 2]);
		expect(q("status:done")).toEqual([3]);
		expect(q("status:draft")).toEqual([1, 2]);
		expect(q("status:下書き")).toEqual([1, 2]);
		expect(q("assignee:me")).toEqual([1]);
		expect(q("assignee:me", ctx(u.mem2))).toEqual([3]);
		expect(q("assignee:none")).toEqual([2]);
		expect(q("assignee:mem2")).toEqual([3]);
		expect(q("assignee:MEM")).toEqual([1]);
		expect(q("assignee:nobody")).toEqual([]);
		expect(q("label:bug")).toEqual([1]);
		expect(q("label:feature")).toEqual([3]);
		expect(q("priority:>=high")).toEqual([1]);
		expect(q("priority:<medium")).toEqual([2, 3]);
		expect(q("priority:none")).toEqual([3]);
		expect(q("due:<2026-12-31")).toEqual([1]);
		expect(q("due:>=2026-06-01")).toEqual([1, 2]);
		expect(q("status:open label:bug priority:urgent")).toEqual([1]);
		expect(m).toBeDefined();
	});
	test("text: 2-char (LIKE), 3+-char (FTS), multiple, body", () => {
		const { q } = data();
		expect(q("検索")).toEqual([2]); // 2 chars, in title and body
		expect(q("ログイン")).toEqual([1]); // 4 chars
		expect(q("ログイン画面")).toEqual([1]);
		expect(q('"全文検索"')).toEqual([2]);
		expect(q("dark")).toEqual([3]);
		expect(q("ログイン 検索")).toEqual([]);
		expect(q("status:open ログイン")).toEqual([1]);
	});
	test("permissions", () => {
		const { ctx, u } = data();
		expect(codeOf(() => searchIssues(ctx(u.out), "WEB", ""))).toBe("forbidden");
		expect(codeOf(() => searchIssues(ctx(u.mem), "WEB", "zzz:1"))).toBe(
			"invalid",
		);
	});
});
