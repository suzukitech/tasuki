import { type Db, openDb, users } from "@tasuki/db";
import {
	type Actor,
	type Ctx,
	createIssue,
	createProject,
	setMember,
} from "./index";

/** Test fixture: in-memory db, five users, project WEB, a movable clock. */
export function setup() {
	const db: Db = openDb(":memory:");
	const clock = { t: new Date("2026-01-01T00:00:00Z") };
	const mk = (name: string, role: "admin" | "member" = "member") =>
		db
			.insert(users)
			.values({ email: `${name}@example.com`, name, passwordHash: "x", role })
			.returning()
			.get();
	const u = {
		admin: mk("admin", "admin"),
		mgr: mk("mgr"),
		mem: mk("mem"),
		mem2: mk("mem2"),
		view: mk("view"),
		out: mk("out"),
	};
	const ctx = (
		user: { id: string },
		auth: Actor["auth"] = "session",
		token?: Actor["token"],
	): Ctx => ({
		db,
		now: () => clock.t,
		actor: {
			userId: user.id,
			via: auth === "session" ? "web" : "mcp:test",
			auth,
			token:
				auth === "token"
					? (token ?? { scopes: ["read", "write"], projectIds: null })
					: undefined,
		},
	});
	const project = createProject(ctx(u.mgr), { key: "WEB", name: "Web" });
	setMember(ctx(u.mgr), "WEB", u.mem.id, "member");
	setMember(ctx(u.mgr), "WEB", u.mem2.id, "member");
	setMember(ctx(u.mgr), "WEB", u.view.id, "viewer");
	const issue = (input: Record<string, unknown> = {}, as = u.mem) =>
		createIssue(ctx(as), "WEB", { title: "Fix login", ...input });
	return { db, clock, u, ctx, project, issue };
}
