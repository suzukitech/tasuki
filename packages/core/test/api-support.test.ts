import { describe, expect, test } from "bun:test";
import { openDb } from "@tasuki/db";
import {
	addComment,
	bulkUpdate,
	createApiToken,
	createSession,
	destroySession,
	getMe,
	listActivities,
	listApiTokens,
	listComments,
	listProjects,
	needsSetup,
	pageIssues,
	projectDetail,
	resolveSession,
	revokeApiToken,
	setupFirstAdmin,
	type TasukiError,
	updateProject,
} from "../src/index";
import { setup } from "./fixture";

const codeOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return (e as TasukiError).code;
	}
};

describe("support for the REST layer", () => {
	test("listProjects respects membership and token restriction", () => {
		const { ctx, u, project } = setup();
		expect(listProjects(ctx(u.mem)).map((p) => p.key)).toEqual(["WEB"]);
		expect(listProjects(ctx(u.out))).toEqual([]);
		expect(listProjects(ctx(u.admin)).map((p) => p.role)).toEqual(["manager"]);
		const other = { scopes: ["read" as const], projectIds: ["nope"] };
		expect(listProjects(ctx(u.mem, "token", other))).toEqual([]);
		expect(
			listProjects(ctx(u.mem, "token", { ...other, projectIds: [project.id] })),
		).toHaveLength(1);
		expect(projectDetail(ctx(u.mem), "WEB").statuses.length).toBeGreaterThan(0);
	});

	test("updateProject: manager only", () => {
		const { ctx, u } = setup();
		expect(updateProject(ctx(u.mgr), "WEB", { name: "New" }).name).toBe("New");
		expect(codeOf(() => updateProject(ctx(u.mem), "WEB", { name: "x" }))).toBe(
			"forbidden",
		);
		expect(codeOf(() => updateProject(ctx(u.mgr), "WEB", { name: "" }))).toBe(
			"invalid",
		);
	});

	test("updateProject keeps description when only the name is patched", () => {
		const { ctx, u } = setup();
		updateProject(ctx(u.mgr), "WEB", { description: "keep me" });
		const p = updateProject(ctx(u.mgr), "WEB", { name: "Only name" });
		expect(p.name).toBe("Only name");
		expect(p.description).toBe("keep me");
	});

	test("bulkUpdate: nothing to update is invalid; every ref is authorized first", () => {
		const { ctx, u, issue } = setup();
		issue();
		expect(codeOf(() => bulkUpdate(ctx(u.mem), { refs: ["WEB-1"] }))).toBe(
			"invalid",
		);
		expect(codeOf(() => bulkUpdate(ctx(u.out), { refs: ["WEB-1"] }))).not.toBe(
			"invalid",
		);
		expect(
			codeOf(() => bulkUpdate(ctx(u.out), { refs: ["WEB-1"], labels: ["x"] })),
		).toBeDefined();
	});

	test("tokens: list without secrets, revoke, session-only", async () => {
		const { ctx, u } = setup();
		const { id } = createApiToken(ctx(u.mem), { name: "a", scopes: ["read"] });
		const rows = listApiTokens(ctx(u.mem));
		expect(rows.map((r) => r.id)).toEqual([id]);
		expect(rows[0]).not.toHaveProperty("tokenHash");
		expect(codeOf(() => revokeApiToken(ctx(u.mem2), id))).toBe("not_found");
		expect(codeOf(() => revokeApiToken(ctx(u.mem, "token"), id))).toBe("gate");
		revokeApiToken(ctx(u.mem), id);
		expect(listApiTokens(ctx(u.mem))[0]?.revokedAt).toBeTruthy();
		expect(codeOf(() => listApiTokens(ctx(u.mem, "token")))).toBe("gate");
	});

	test("sessions, setup status, me", async () => {
		const db = openDb(":memory:");
		expect(needsSetup(db)).toBe(true);
		const admin = await setupFirstAdmin(db, {
			email: "a@example.com",
			name: "A",
			password: "password123",
		});
		expect(needsSetup(db)).toBe(false);
		const tok = createSession(db, admin.id);
		expect(resolveSession(db, tok)).not.toBeNull();
		destroySession(db, tok);
		expect(resolveSession(db, tok)).toBeNull();
		const actor = { userId: admin.id, via: "web", auth: "session" as const };
		expect(getMe({ db, actor })).toMatchObject({
			email: "a@example.com",
			role: "admin",
		});
		expect(codeOf(() => getMe({ db, actor: { ...actor, userId: "x" } }))).toBe(
			"not_found",
		);
	});

	test("comments, activities, paging", () => {
		const { ctx, u, issue } = setup();
		for (let n = 0; n < 4; n++) issue({ title: `t${n}` });
		addComment(ctx(u.view), "WEB-1", "hello");
		expect(listComments(ctx(u.mem), "WEB-1")).toHaveLength(1);
		expect(listActivities(ctx(u.mem), "WEB-1").map((a) => a.action)).toEqual([
			"created",
			"commented",
		]);
		const p = pageIssues(ctx(u.mem), "WEB", "", { limit: 3 });
		expect(p.items.map((i) => i.number)).toEqual([4, 3, 2]);
		expect(p.nextCursor).toBe(2);
		expect(
			pageIssues(ctx(u.mem), "WEB", "", { cursor: 2, limit: 0 }).items,
		).toHaveLength(1);
		expect(
			pageIssues(ctx(u.mem), "WEB", "", { cursor: 2 }).nextCursor,
		).toBeNull();
	});

	test("bulkUpdate rolls back everything on one failure", () => {
		const { ctx, u, issue } = setup();
		issue();
		issue();
		const r = bulkUpdate(ctx(u.mem), {
			refs: ["WEB-1", "WEB-2"],
			assigneeId: u.mem2.id,
			labels: ["x"],
		});
		expect(r).toEqual(["WEB-1", "WEB-2"]);
		expect(
			codeOf(() =>
				bulkUpdate(ctx(u.mem), {
					refs: ["WEB-1", "WEB-2"],
					assigneeId: u.out.id,
				}),
			),
		).toBe("invalid");
		expect(
			codeOf(() =>
				bulkUpdate(ctx(u.mem), { refs: ["WEB-1", "WEB-9"], labels: ["y"] }),
			),
		).toBe("not_found");
	});
});
