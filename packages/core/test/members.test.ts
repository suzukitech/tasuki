import { describe, expect, test } from "bun:test";
import {
	addMember,
	changeMemberRole,
	type IssueEvent,
	projectDetail,
	removeMember,
	renameStatus,
	TasukiError,
} from "../src/index";
import { setup } from "./fixture";

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		if (e instanceof TasukiError) return `${e.code}:${e.status}`;
		throw e;
	}
	return "ok";
};

describe("members", () => {
	test("add by email, change role, remove", () => {
		const { ctx, u } = setup();
		expect(
			code(() =>
				addMember(ctx(u.mgr), "WEB", { email: u.out.email, role: "viewer" }),
			),
		).toBe("ok");
		const m = () => projectDetail(ctx(u.mgr), "WEB").members;
		expect(m().find((x) => x.id === u.out.id)?.role).toBe("viewer");
		changeMemberRole(ctx(u.mgr), "WEB", u.out.id, { role: "member" });
		expect(m().find((x) => x.id === u.out.id)?.role).toBe("member");
		removeMember(ctx(u.mgr), "WEB", u.out.id);
		expect(m().some((x) => x.id === u.out.id)).toBe(false);
		expect(
			code(() =>
				addMember(ctx(u.mgr), "WEB", {
					email: "no@example.com",
					role: "member",
				}),
			),
		).toBe("not_found:404");
		expect(
			code(() =>
				changeMemberRole(ctx(u.mgr), "WEB", u.out.id, { role: "member" }),
			),
		).toBe("not_found:404");
		expect(code(() => removeMember(ctx(u.mgr), "WEB", u.out.id))).toBe(
			"not_found:404",
		);
	});

	test("manager only; sessions only; last manager is protected", () => {
		const { ctx, u } = setup();
		expect(code(() => removeMember(ctx(u.mem), "WEB", u.mem2.id))).toBe(
			"forbidden:403",
		);
		expect(
			code(() => removeMember(ctx(u.mgr, "token"), "WEB", u.mem2.id)),
		).toBe("gate:409");
		expect(
			code(() =>
				changeMemberRole(ctx(u.mgr), "WEB", u.mgr.id, { role: "member" }),
			),
		).toBe("conflict:409");
		expect(code(() => removeMember(ctx(u.mgr), "WEB", u.mgr.id))).toBe(
			"conflict:409",
		);
		expect(
			code(() =>
				addMember(ctx(u.mgr), "WEB", { email: u.mgr.email, role: "viewer" }),
			),
		).toBe("conflict:409");
		// a second manager makes the first removable
		changeMemberRole(ctx(u.mgr), "WEB", u.mem.id, { role: "manager" });
		expect(code(() => removeMember(ctx(u.mgr), "WEB", u.mgr.id))).toBe("ok");
		expect(
			code(() =>
				changeMemberRole(ctx(u.mem), "WEB", u.mem.id, { role: "bogus" }),
			),
		).toBe("invalid:400");
	});
});

describe("renameStatus events", () => {
	test("emits project.updated for the project, after commit", () => {
		const { ctx, u } = setup();
		const events: IssueEvent[] = [];
		const c = { ...ctx(u.mgr), emit: (e: IssueEvent) => events.push(e) };
		const st = projectDetail(c, "WEB").statuses[0];
		if (!st) throw new Error("no status");
		renameStatus(c, "WEB", st.id, { name: "Inbox" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "project.updated", ref: "WEB" });
		expect(code(() => renameStatus(c, "WEB", "nope", { name: "x" }))).toBe(
			"not_found:404",
		);
		expect(events).toHaveLength(1);
	});
});

describe("renameStatus", () => {
	test("renames only the name, in this project, for managers over a session", () => {
		const { ctx, u } = setup();
		const st = projectDetail(ctx(u.mgr), "WEB").statuses[0];
		if (!st) throw new Error("no status");
		const r = renameStatus(ctx(u.mgr), "WEB", st.id, { name: "  Inbox " });
		expect(r).toMatchObject({
			name: "Inbox",
			category: st.category,
			position: st.position,
		});
		expect(
			code(() => renameStatus(ctx(u.mem), "WEB", st.id, { name: "x" })),
		).toBe("forbidden:403");
		expect(
			code(() =>
				renameStatus(ctx(u.mgr, "token"), "WEB", st.id, { name: "x" }),
			),
		).toBe("gate:409");
		expect(
			code(() => renameStatus(ctx(u.mgr), "WEB", st.id, { name: " " })),
		).toBe("invalid:400");
		expect(
			code(() => renameStatus(ctx(u.mgr), "WEB", "nope", { name: "x" })),
		).toBe("not_found:404");
	});
});
