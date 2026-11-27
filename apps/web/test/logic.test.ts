import { describe, expect, test } from "bun:test";
import { t } from "../src/i18n";
import { ApiError, api } from "../src/lib/api";
import { mapPages, projectOf } from "../src/lib/cache";
import { criteriaBody, critsOf, shown } from "../src/lib/draft";
import { etagOf, writeError } from "../src/lib/etag";
import {
	activityText,
	hueOf,
	initialOf,
	relativeDue,
	relativeTime,
	splitSteps,
	stepRefs,
	viaLabel,
} from "../src/lib/format";
import { keyAction, shouldHandleKey } from "../src/lib/keys";
import { PRIORITY_KEYS } from "../src/lib/priority";
import { buildCreate, previewQuick } from "../src/lib/quick";
import { turnOf } from "../src/lib/turn";
import type { IssueRow, Page, Status } from "../src/lib/types";

const body = { tagName: "BODY" };
const ev = (key: string, o: object = {}) => ({ key, target: body, ...o });

describe("keyboard guard", () => {
	test("fires on plain keys outside inputs", () => {
		expect(shouldHandleKey(ev("c"))).toBe(true);
		expect(keyAction(ev("c"))).toBe("create");
		expect(keyAction(ev("C"))).toBe("create");
		expect(keyAction(ev("j"))).toBe("next");
		expect(keyAction(ev("k"))).toBe("prev");
		expect(keyAction(ev("Enter"))).toBe("open");
		expect(keyAction(ev("Escape"))).toBe("close");
		expect(keyAction(ev("/"))).toBe("search");
		expect(keyAction(ev("x"))).toBeNull();
	});
	test("silent while typing, composing, with modifiers, or in contenteditable", () => {
		for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"])
			expect(keyAction({ key: "c", target: { tagName } })).toBeNull();
		expect(keyAction(ev("c", { isComposing: true }))).toBeNull();
		expect(keyAction(ev("c", { metaKey: true }))).toBeNull();
		expect(keyAction(ev("c", { ctrlKey: true }))).toBeNull();
		expect(
			keyAction({
				key: "c",
				target: { tagName: "DIV", isContentEditable: true },
			}),
		).toBeNull();
	});
	test("Enter on a focused button is left to the button", () => {
		expect(
			keyAction({ key: "Enter", target: { tagName: "BUTTON" } }),
		).toBeNull();
		expect(keyAction({ key: "j", target: { tagName: "BUTTON" } })).toBe("next");
	});
	test("keys inside an open menu never reach the page shortcuts", () => {
		const inMenu = {
			tagName: "DIV",
			closest: (sel: string) => (sel.includes("[role=listbox]") ? {} : null),
		};
		expect(keyAction({ key: "Enter", target: inMenu })).toBeNull();
		expect(keyAction({ key: "j", target: inMenu })).toBeNull();
		expect(shouldHandleKey({ key: "c", target: inMenu })).toBe(false);
		expect(
			shouldHandleKey({
				key: "c",
				target: { tagName: "DIV", closest: () => null },
			}),
		).toBe(true);
	});
	test("null target is fine", () => {
		expect(keyAction({ key: "c", target: null })).toBe("create");
	});
});

describe("turn badge", () => {
	const statuses: Status[] = [
		{ id: "s1", name: "計画確認", category: "plan_review", position: 0 },
		{ id: "s2", name: "作業中", category: "in_progress", position: 1 },
		{ id: "s3", name: "完了", category: "done", position: 2 },
	];
	const row = (statusId: string, o: Partial<IssueRow> = {}): IssueRow => ({
		id: "i",
		ref: "WEB-1",
		number: 1,
		title: "x",
		statusId,
		priority: null,
		assigneeId: null,
		reporterId: "r",
		approverId: "a",
		dueDate: null,
		flow: "ai",
		updatedAt: "2026-01-01T00:00:00.000Z",
		labels: [],
		openQuestions: 0,
		...o,
	});
	test("open question: reviewer's turn, never AI", () => {
		const q = { assigneeId: "x", openQuestions: 1 };
		expect(turnOf(row("s2", q), statuses, "a")).toBe("you");
		expect(turnOf(row("s2", q), statuses, "x")).toBe("others");
	});
	test("approver, AI, others, done, unknown", () => {
		expect(turnOf(row("s1"), statuses, "a")).toBe("you");
		expect(turnOf(row("s1"), statuses, "z")).toBe("others");
		expect(turnOf(row("s2", { assigneeId: "x" }), statuses, "a")).toBe("ai");
		expect(turnOf(row("s3"), statuses, "a")).toBeNull();
		expect(turnOf(row("nope"), statuses, "a")).toBeNull();
	});
});

describe("quick create", () => {
	const members = [
		{ id: "u1", name: "Taro", role: "member" as const },
		{ id: "u2", name: "花子", role: "member" as const },
	];
	test("parses @user #label !priority, half and full width", () => {
		expect(buildCreate("fix login @taro #bug !high", true, members)).toEqual({
			title: "fix login",
			flow: "ai",
			labels: ["bug"],
			priority: 3,
			assigneeId: "u1",
		});
		expect(
			buildCreate("修正　＠花子　＃バグ　！urgent", false, members),
		).toEqual({
			title: "修正",
			flow: "simple",
			labels: ["バグ"],
			priority: 4,
			assigneeId: "u2",
		});
	});
	test("unknown assignee stays in the title; empty title is null", () => {
		expect(buildCreate("x @nobody", true, members)?.title).toBe("x @nobody");
		expect(buildCreate("@taro #a", true, members)).toBeNull();
		expect(buildCreate("   ", true, members)).toBeNull();
	});
});

describe("ETag / 412 handling", () => {
	test("etag is the quoted ms of updatedAt, matching the server", () => {
		expect(etagOf("2026-01-01T00:00:00.000Z")).toBe(
			`"${Date.UTC(2026, 0, 1)}"`,
		);
	});
	test("412 means conflict + refetch toast", () => {
		const w = writeError(new ApiError(412, "precondition", "stale"));
		expect(w).toEqual({ conflict: true, key: "toast.conflict" });
		expect(t(w.key)).toBe(
			"他の人が先に更新しました。最新の内容を読み込みました",
		);
	});
	test("other failures", () => {
		expect(writeError(new ApiError(403, "forbidden", "no")).key).toBe(
			"toast.forbidden",
		);
		expect(writeError(new ApiError(409, "gate", "no")).key).toBe("toast.gate");
		expect(writeError(new ApiError(409, "conflict", "bad state"))).toEqual({
			conflict: false,
			key: "toast.failed",
			detail: "bad state",
		});
		expect(writeError(new TypeError("fetch failed")).key).toBe("toast.network");
	});
	test("t fills placeholders", () => {
		expect(t("plan.version", { n: 2 })).toBe("第2版");
	});
});

describe("api()", () => {
	const real = globalThis.fetch;
	const mock = (res: Response, seen: RequestInit[] = []) => {
		globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
			seen.push(init);
			return res;
		}) as unknown as typeof fetch;
		return seen;
	};
	test("sends JSON with If-Match and returns the body; 204 is undefined", async () => {
		const seen = mock(Response.json({ ok: 1 }));
		expect(await api("PATCH", "/x", { a: 1 }, { "if-match": '"1"' })).toEqual({
			ok: 1,
		});
		const h = seen[0]?.headers as Record<string, string>;
		expect(h["content-type"]).toBe("application/json");
		expect(h["if-match"]).toBe('"1"');
		mock(new Response(null, { status: 204 }));
		expect(await api("POST", "/y")).toBeUndefined();
		globalThis.fetch = real;
	});
	test("problem+json becomes ApiError", async () => {
		mock(
			Response.json({ code: "precondition", detail: "stale" }, { status: 412 }),
		);
		const e = await api<never>("PATCH", "/x", {}).catch((x: ApiError) => x);
		expect(e).toBeInstanceOf(ApiError);
		expect([e.status, e.code, e.message]).toEqual([
			412,
			"precondition",
			"stale",
		]);
		mock(new Response("boom", { status: 500, statusText: "Oops" }));
		expect((await api<never>("GET", "/z").catch((x: ApiError) => x)).code).toBe(
			"error",
		);
		globalThis.fetch = real;
	});
});

describe("optimistic list edit", () => {
	const row = (ref: string, priority: number | null = null) =>
		({ ref, priority }) as IssueRow;
	const page = (...refs: string[]): Page => ({
		items: refs.map((r) => row(r)),
		nextCursor: null,
	});
	test("patches the matching row in infinite data", () => {
		const d = { pages: [page("W-1", "W-2")], pageParams: [undefined] };
		const out = mapPages(d, "W-2", { priority: 3 });
		expect(out.pages[0]?.items.map((i) => i.priority)).toEqual([null, 3]);
		expect(d.pages[0]?.items[1]?.priority).toBeNull(); // input untouched
	});
	test("a plain Page (review queue) or undefined passes through unchanged", () => {
		const plain = page("W-1");
		expect(mapPages(plain, "W-1", { priority: 3 })).toBe(plain);
		expect(mapPages(undefined, "W-1", { priority: 3 })).toBeUndefined();
	});
	test("project key comes from the ref", () => {
		expect(projectOf("WEB-12")).toBe("WEB");
		expect(projectOf("AB-1")).toBe("AB");
	});
});

describe("drafts", () => {
	test("an untouched field follows the server, an edited one keeps the draft", () => {
		expect(shown(undefined, "server")).toBe("server");
		expect(shown("typed", "server")).toBe("typed");
		expect(shown("", "server")).toBe(""); // cleared on purpose is still a draft
	});
	test("criteria: a refetched list carries ids, so the next save keeps them", () => {
		const server = [
			{ id: "c1", text: "a" },
			{ id: "c2", text: "b" },
		];
		const next = [...critsOf(server), { id: undefined, text: "  new " }];
		expect(criteriaBody(next)).toEqual([
			{ id: "c1", text: "a" },
			{ id: "c2", text: "b" },
			{ text: "new" },
		]);
		expect(criteriaBody([{ id: undefined, text: "  " }])).toEqual([]);
	});
});

test("priority options derive from PRIORITIES, in value order", () => {
	expect(PRIORITY_KEYS).toEqual([
		"priority.none",
		"priority.low",
		"priority.medium",
		"priority.high",
		"priority.urgent",
	]);
	for (const k of PRIORITY_KEYS) expect(t(k)).not.toBe(k);
});

describe("display helpers", () => {
	const now = new Date(2026, 10, 27, 15);
	test("relative due dates", () => {
		expect(relativeDue("2026-11-27", now)).toEqual({
			text: "今日",
			late: false,
		});
		expect(relativeDue("2026-11-28", now).text).toBe("明日");
		expect(relativeDue("2026-11-30", now).text).toBe("3日後");
		expect(relativeDue("2026-11-25", now)).toEqual({
			text: "2日超過",
			late: true,
		});
		expect(relativeDue("2026-12-31", now).text).toBe("12月31日");
	});
	test("relative time", () => {
		expect(relativeTime(now, now)).toBe("たった今");
		expect(relativeTime(new Date(now.getTime() - 5 * 60_000), now)).toBe(
			"5分前",
		);
		expect(relativeTime(new Date(now.getTime() - 3 * 3600_000), now)).toBe(
			"3時間前",
		);
		expect(relativeTime(new Date(now.getTime() - 2 * 86400_000), now)).toBe(
			"2日前",
		);
	});
	test("avatar helpers are stable", () => {
		expect(hueOf("abc")).toBe(hueOf("abc"));
		expect(hueOf("abc")).toBeLessThan(360);
		expect(initialOf("鈴木 康")).toBe("鈴");
		expect(initialOf("ada")).toBe("A");
	});
	test("steps and step chips", () => {
		expect(splitSteps("1. a\n2) b")).toEqual([
			{ n: "1", text: "a" },
			{ n: "2", text: "b" },
		]);
		expect(splitSteps("just text")).toBeNull();
		expect(stepRefs("1, 2、4")).toEqual(["1", "2", "4"]);
		expect(stepRefs(null)).toEqual([]);
	});
	test("quick-create preview matches what Enter sets", () => {
		const members = [{ id: "u1", name: "Taro", role: "member" as const }];
		const p = previewQuick("x @tar #a !urgent", members);
		expect(p.assignee?.id).toBe("u1");
		expect(p.labels).toEqual(["a"]);
		expect(p.priority).toBe(4);
		expect(previewQuick("x @nobody", members).assignee).toBeUndefined();
	});
});

describe("history text", () => {
	const ctx = {
		members: [
			{ id: "u1", name: "Taro", role: "member" as const },
			{ id: "u2", name: "Hanako", role: "member" as const },
		],
		statuses: [
			{
				id: "s1",
				name: "作業中",
				category: "in_progress" as const,
				position: 0,
			},
		],
	};
	const a = (field: string, before: string | null, after: string | null) =>
		activityText({ action: "updated", field, before, after }, ctx);
	test("ids become names / labels", () => {
		expect(a("assigneeId", "u1", "u2")).toBe(
			"担当を「Taro」から「Hanako」に変更",
		);
		expect(a("assigneeId", null, "u2")).toBe("担当を「Hanako」に設定");
		expect(a("assigneeId", "u1", null)).toBe(
			"担当を「Taro」から「未割り当て」に変更",
		);
		expect(a("approverId", "zzz", "u1")).toBe(
			"承認者を「不明なユーザー」から「Taro」に変更",
		);
		expect(a("statusId", null, "s1")).toBe("状態を「作業中」に設定");
		expect(a("priority", "1", "4")).toBe("優先度を「低」から「緊急」に変更");
		expect(a("flow", "simple", "ai")).toBe(
			"進め方を「人がやる」から「AIに任せる」に変更",
		);
		expect(a("title", "a", "b")).toBe("タイトルを「a」から「b」に変更");
	});
	test("plain actions and long values", () => {
		expect(
			activityText(
				{ action: "completed", field: null, before: null, after: null },
				ctx,
			),
		).toBe("完了にした");
		expect(a("bodyMd", "x", "y".repeat(50))).toBe("本文を更新");
	});
	test("via label", () => {
		expect(viaLabel("mcp:claude-code")).toBe("Claude Code経由");
		expect(viaLabel("mcp:cursor")).toBe("cursor経由");
		expect(viaLabel("cli")).toBe("CLI経由");
		expect(viaLabel("weird")).toBe("weird");
	});
});
