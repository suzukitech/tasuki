import { describe, expect, test } from "bun:test";
import { setup } from "./fixture";
import {
	addComment,
	createIssue,
	createProject,
	deleteIssue,
	getIssue,
	getProject,
	projectRole,
	requireAdmin,
	TasukiError,
	updateIssue,
} from "./index";

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		if (e instanceof TasukiError) return `${e.code}:${e.status}`;
		throw e;
	}
	return "ok";
};

describe("projects", () => {
	test("create: key format, creator manager, defaults, duplicate", () => {
		const { ctx, u, db } = setup();
		expect(
			code(() => createProject(ctx(u.mem), { key: "bad", name: "x" })),
		).toBe("invalid:400");
		const p = createProject(ctx(u.mem), { key: "OPS", name: "Ops" });
		expect(projectRole(ctx(u.mem), p.id)).toBe("manager");
		expect(
			code(() => createProject(ctx(u.mem), { key: "OPS", name: "x" })),
		).toBe("conflict:409");
		expect(
			db.query.statuses
				.findMany({ where: (s, { eq }) => eq(s.projectId, p.id) })
				.sync(),
		).toHaveLength(6);
		expect(getProject(ctx(u.mem), "ops").key).toBe("OPS");
		expect(code(() => getProject(ctx(u.mem), "NOPE"))).toBe("not_found:404");
	});
	test("project-restricted or read-only tokens cannot create projects", () => {
		const { ctx, u } = setup();
		expect(
			code(() =>
				createProject(
					ctx(u.mem, "token", { scopes: ["write"], projectIds: ["x"] }),
					{ key: "OPS", name: "x" },
				),
			),
		).toBe("forbidden:403");
		expect(
			code(() =>
				createProject(
					ctx(u.mem, "token", { scopes: ["read"], projectIds: null }),
					{ key: "OPS", name: "x" },
				),
			),
		).toBe("forbidden:403");
		expect(
			code(() => createProject(ctx(u.mem, "token"), { key: "OPS", name: "x" })),
		).toBe("ok");
	});
});

describe("permission matrix", () => {
	test("roles", () => {
		const { ctx, u, issue, project } = setup();
		const i = issue();
		expect(projectRole(ctx(u.admin), project.id)).toBe("manager"); // admin bypass
		expect(projectRole(ctx(u.out), project.id)).toBeNull();
		// viewer: read + comment only
		expect(code(() => getIssue(ctx(u.view), "WEB-1"))).toBe("ok");
		expect(code(() => addComment(ctx(u.view), "WEB-1", "hi"))).toBe("ok");
		expect(code(() => updateIssue(ctx(u.view), "WEB-1", { title: "x" }))).toBe(
			"forbidden:403",
		);
		expect(code(() => createIssue(ctx(u.view), "WEB", { title: "x" }))).toBe(
			"forbidden:403",
		);
		// non member
		expect(code(() => getIssue(ctx(u.out), "WEB-1"))).toBe("forbidden:403");
		// delete: manager (and admin) only
		expect(code(() => deleteIssue(ctx(u.mem), "WEB-1"))).toBe("forbidden:403");
		expect(code(() => deleteIssue(ctx(u.admin), "WEB-1"))).toBe("ok");
		expect(code(() => getIssue(ctx(u.mgr), "WEB-1"))).toBe("not_found:404");
		expect(i.number).toBe(1);
	});
	test("requireAdmin", () => {
		const { ctx, u } = setup();
		expect(code(() => requireAdmin(ctx(u.admin)))).toBe("ok");
		expect(code(() => requireAdmin(ctx(u.mgr)))).toBe("forbidden:403");
	});
	test("tokens: scope, project restriction, role cap", () => {
		const { ctx, u, issue } = setup();
		issue();
		const ro = ctx(u.mem, "token", { scopes: ["read"], projectIds: null });
		expect(code(() => getIssue(ro, "WEB-1"))).toBe("ok");
		expect(code(() => updateIssue(ro, "WEB-1", { title: "x" }))).toBe(
			"forbidden:403",
		);
		expect(code(() => addComment(ro, "WEB-1", "x"))).toBe("forbidden:403");
		const other = ctx(u.mem, "token", {
			scopes: ["read", "write"],
			projectIds: ["some-other-project"],
		});
		expect(code(() => getIssue(other, "WEB-1"))).toBe("forbidden:403");
		const wo = ctx(u.mem, "token", { scopes: ["write"], projectIds: null });
		expect(code(() => getIssue(wo, "WEB-1"))).toBe("ok"); // write implies read
		// token of a viewer cannot exceed viewer
		const vt = ctx(u.view, "token");
		expect(code(() => updateIssue(vt, "WEB-1", { title: "x" }))).toBe(
			"forbidden:403",
		);
		// malformed token actor
		const bad = ctx(u.mem);
		bad.actor.auth = "token";
		bad.actor.token = undefined;
		expect(code(() => getIssue(bad, "WEB-1"))).toBe("forbidden:403");
	});
	test("unknown user has no role", () => {
		const { ctx, project } = setup();
		expect(projectRole(ctx({ id: "ghost" }), project.id)).toBeNull();
	});
});
