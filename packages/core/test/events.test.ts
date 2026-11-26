import { describe, expect, test } from "bun:test";
import {
	addComment,
	bulkUpdate,
	createIssue,
	deleteIssue,
	etagOf,
	type IssueEvent,
	pageIssues,
	parseEtag,
	updateIssue,
} from "../src/index";
import { setup } from "./fixture";

/** A ctx that records emitted events (and what the db held at that moment). */
function watched() {
	const s = setup();
	const events: IssueEvent[] = [];
	const seen: number[] = [];
	const ctx = (as = s.u.mem) => ({
		...s.ctx(as),
		emit: (e: IssueEvent) => {
			events.push(e);
			seen.push(pageIssues(s.ctx(s.u.mem), "WEB", "").items.length);
		},
	});
	return { ...s, events, seen, ctx };
}

describe("events", () => {
	test("create fires after commit with ref; DTOs carry ref", () => {
		const w = watched();
		const i = createIssue(w.ctx(), "WEB", { title: "a" });
		expect(i.ref).toBe("WEB-1");
		expect(w.events).toEqual([
			{ type: "issue.created", projectId: i.projectId, ref: "WEB-1" },
		]);
		expect(w.seen).toEqual([1]); // already committed when emitted
		const u = updateIssue(w.ctx(), i.ref, { title: "b" });
		expect(u.ref).toBe("WEB-1");
		addComment(w.ctx(), i.ref, "hi");
		deleteIssue(w.ctx(w.u.mgr), i.ref);
		expect(w.events.map((e) => e.type)).toEqual([
			"issue.created",
			"issue.updated",
			"issue.commented",
			"issue.deleted",
		]);
		const page = pageIssues(w.ctx(), "WEB", "");
		expect(page.items.every((x) => !("bodyMd" in x))).toBe(true);
	});

	test("no event when the operation rolls back", () => {
		const w = watched();
		const x = createIssue(w.ctx(), "WEB", { title: "a" });
		w.events.length = 0;
		// bad parent fails inside the transaction after other work may have run
		expect(() =>
			updateIssue(w.ctx(), x.ref, { title: "z", parentId: "nope" }),
		).toThrow();
		expect(() => createIssue(w.ctx(), "WEB", { title: "" })).toThrow();
		expect(w.events).toEqual([]);
	});

	test("bulk emits once per issue, after commit, none on failure", () => {
		const w = watched();
		const a = createIssue(w.ctx(), "WEB", { title: "a" });
		const b = createIssue(w.ctx(), "WEB", { title: "b" });
		w.events.length = 0;
		const ready = w.db.query.statuses
			.findFirst({ where: (t, { eq }) => eq(t.category, "ready") })
			.sync();
		bulkUpdate(w.ctx(), {
			refs: [a.ref, b.ref],
			labels: ["x"],
			statusId: ready?.id,
		});
		expect(w.events.map((e) => [e.type, e.ref])).toEqual([
			["issue.updated", "WEB-1"],
			["issue.updated", "WEB-2"],
		]);
		w.events.length = 0;
		expect(() =>
			bulkUpdate(w.ctx(), { refs: [a.ref, "WEB-99"], labels: ["y"] }),
		).toThrow();
		expect(w.events).toEqual([]);
	});

	test("etag helpers round-trip", () => {
		const t = etagOf({ updatedAt: new Date(1234) });
		expect(t).toBe('"1234"');
		expect(parseEtag(t)).toBe(1234);
		expect(parseEtag(`W/${t}`)).toBe(1234);
		expect(parseEtag(undefined)).toBeUndefined();
		expect(() => parseEtag("abc")).toThrow();
	});
});
