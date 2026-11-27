import { describe, expect, test } from "bun:test";
import { isIssueRef, isProjectKey } from "@tasuki/schema/pure";
import { colId, colOfOver, columnsOf, planDrop } from "../src/lib/board";
import { filterCommands, issueRefOf } from "../src/lib/palette";
import { expiryIso, tokenView } from "../src/lib/settings";
import type { IssueRow, Status } from "../src/lib/types";

const st = (id: string, position: number): Status => ({
	id,
	name: id,
	category: "draft",
	position,
});
const row = (
	id: string,
	statusId: string,
	rank: string,
	number = 1,
): IssueRow => ({
	id,
	ref: `WEB-${number}`,
	number,
	rank,
	title: id,
	statusId,
	priority: null,
	assigneeId: null,
	reporterId: null,
	approverId: null,
	dueDate: null,
	flow: "simple",
	updatedAt: "2026-01-01T00:00:00.000Z",
	labels: [],
	openQuestions: 0,
});
const cols = columnsOf(
	[st("b", 1), st("a", 0), st("c", 2)],
	[
		row("x", "a", "a2", 1),
		row("y", "a", "a1", 2),
		row("z", "a", "a3", 3),
		row("w", "b", "a5", 4),
	],
);

describe("board columns", () => {
	test("status order by position, cards by rank, empty column kept", () => {
		expect(cols.map(([s]) => s.id)).toEqual(["a", "b", "c"]);
		expect(cols[0]?.[1].map((r) => r.id)).toEqual(["y", "x", "z"]);
		expect(cols[2]?.[1]).toEqual([]);
	});
	test("colOfOver finds the column of a card or of a column id", () => {
		expect(colOfOver(cols, "w")?.[0].id).toBe("b");
		expect(colOfOver(cols, colId("c"))?.[0].id).toBe("c");
		expect(colOfOver(cols, "nope")).toBeUndefined();
	});
	test("ranks are compared as plain strings, not by locale", () => {
		const c = columnsOf(
			[st("a", 0)],
			[row("u", "a", "a0", 1), row("v", "a", "Zz", 2)],
		);
		expect(c[0]?.[1].map((r) => r.id)).toEqual(["v", "u"]);
	});
});

describe("planDrop", () => {
	test("down within a column lands after the card dropped on", () => {
		const r = planDrop(cols, "y", "x"); // y,x,z -> x,y,z
		expect(r?.statusId).toBe("a");
		expect(r?.rank && r.rank > "a2" && r.rank < "a3").toBe(true);
	});
	test("up within a column lands before", () => {
		const r = planDrop(cols, "z", "y");
		expect(r?.rank && r.rank < "a1").toBe(true);
	});
	test("dropping on itself changes nothing", () => {
		expect(planDrop(cols, "x", "x")).toBeNull();
	});
	test("onto another column's card goes before it; onto a column goes last", () => {
		const before = planDrop(cols, "x", "w");
		expect(before?.statusId).toBe("b");
		expect(before?.rank && before.rank < "a5").toBe(true);
		const last = planDrop(cols, "x", colId("b"));
		expect(last?.rank && last.rank > "a5").toBe(true);
		const empty = planDrop(cols, "x", colId("c"));
		expect(empty?.statusId).toBe("c");
		expect(empty?.rank).toBeTruthy();
	});
	test("unknown ids and equal neighbour ranks degrade safely", () => {
		expect(planDrop(cols, "nope", "x")).toBeNull();
		expect(planDrop(cols, "x", "nope")).toBeNull();
		const dup = columnsOf(
			[st("a", 0)],
			[row("p", "a", "a1", 1), row("q", "a", "a1", 2), row("r", "a", "a0", 3)],
		);
		expect(planDrop(dup, "r", "p")).toEqual({ statusId: "a", appended: true });
	});
});

describe("command palette", () => {
	const cmds = [
		{ label: "WEB Web　ボード", keywords: "board kanban" },
		{ label: "レビューキュー", keywords: "review inbox" },
		{ label: "設定", keywords: "settings token" },
	];
	test("all words must match; label hits come before keyword hits", () => {
		expect(filterCommands(cmds, "").length).toBe(3);
		expect(filterCommands(cmds, "ボード").map((c) => c.label)).toEqual([
			"WEB Web　ボード",
		]);
		expect(filterCommands(cmds, "token")[0]?.label).toBe("設定");
		expect(filterCommands(cmds, "web board").length).toBe(1);
		expect(filterCommands(cmds, "ＷＥＢ").length).toBe(1);
		expect(filterCommands(cmds, "zzz")).toEqual([]);
	});
	test("a ref is recognised in any width and case", () => {
		expect(issueRefOf("web-12")).toBe("WEB-12");
		expect(issueRefOf("ＷＥＢ－１２")).toBe("WEB-12");
		expect(issueRefOf("WEB-012")).toBe("WEB-12");
		expect(issueRefOf("fix web-12")).toBeNull();
		expect(issueRefOf("W-1")).toBeNull();
		expect(issueRefOf("WEB-0")).toBeNull();
	});
});

describe("settings helpers", () => {
	const base = {
		id: "1",
		name: "n",
		scopes: '["read","write"]',
		projectIds: null,
		lastUsedAt: null,
		expiresAt: null,
		revokedAt: null,
		createdAt: "x",
	};
	test("token state and scope", () => {
		const now = new Date("2026-06-01T00:00:00Z");
		expect(tokenView(base, now)).toEqual({
			write: true,
			projectIds: null,
			state: "active",
		});
		expect(tokenView({ ...base, scopes: '["read"]' }, now).write).toBe(false);
		expect(
			tokenView({ ...base, projectIds: '["p1"]' }, now).projectIds,
		).toEqual(["p1"]);
		expect(
			tokenView({ ...base, expiresAt: "2026-05-01T00:00:00Z" }, now).state,
		).toBe("expired");
		expect(
			tokenView(
				{
					...base,
					revokedAt: "2026-05-01T00:00:00Z",
					expiresAt: "2026-05-01T00:00:00Z",
				},
				now,
			).state,
		).toBe("revoked");
		expect(tokenView({ ...base, scopes: "{bad" }, now).write).toBe(false);
	});
	test("expiry is the end of the chosen day, or null", () => {
		expect(expiryIso("")).toBeNull();
		expect(new Date(expiryIso("2030-01-02") ?? "").getFullYear()).toBe(2030);
	});
});

describe("url-derived ids", () => {
	test("only well-formed refs and keys pass", () => {
		expect(isIssueRef("WEB-12")).toBe(true);
		for (const bad of [
			"../projects/X",
			"WEB-0",
			"WEB-12/move",
			"web-1",
			"WEB-1?x=1",
			"WEB-01",
			"",
			undefined,
			5,
		])
			expect(isIssueRef(bad)).toBe(false);
		expect(isProjectKey("WEB")).toBe(true);
		expect(isProjectKey("W")).toBe(false);
		expect(isProjectKey("../x")).toBe(false);
	});
});
