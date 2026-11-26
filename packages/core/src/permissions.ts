import { projectMembers, users } from "@tasuki/db";
import { and, eq } from "drizzle-orm";
import { type Ctx, fail } from "./ctx";

const RANK = { viewer: 0, member: 1, manager: 2 } as const;
export type Role = keyof typeof RANK;

/** The actor's role in a project. System admins are managers everywhere. */
const userOf = (ctx: Ctx) =>
	ctx.db.select().from(users).where(eq(users.id, ctx.actor.userId)).get();

export function projectRole(ctx: Ctx, projectId: string): Role | null {
	const user = userOf(ctx);
	if (!user) return null;
	if (user.role === "admin") return "manager";
	const m = ctx.db
		.select()
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.userId, user.id),
			),
		)
		.get();
	return m?.role ?? null;
}

/** Token scope + project restriction. Never grants more than the user's own role. */
export function requireScope(
	ctx: Ctx,
	kind: "read" | "write",
	projectId?: string,
) {
	if (ctx.actor.auth !== "token") return;
	const t = ctx.actor.token;
	if (!t) return fail("forbidden", "token actor without token info");
	if (
		!t.scopes.includes(kind) &&
		!(kind === "read" && t.scopes.includes("write"))
	)
		fail("forbidden", `token lacks '${kind}' scope`);
	if (projectId && t.projectIds && !t.projectIds.includes(projectId))
		fail("forbidden", "token cannot access this project");
}

/** `kind` defaults to read for viewer, write otherwise; comments are viewer+write. */
export function requireProjectRole(
	ctx: Ctx,
	projectId: string,
	min: Role,
	kind: "read" | "write" = min === "viewer" ? "read" : "write",
): Role {
	requireScope(ctx, kind, projectId);
	const role = projectRole(ctx, projectId);
	if (!role || RANK[role] < RANK[min])
		return fail("forbidden", `requires project role ${min}`);
	return role;
}

/** Human gate: only a browser login session may pass. */
export function requireSession(ctx: Ctx, what: string) {
	if (ctx.actor.auth !== "session")
		fail("gate", `${what} requires a human login session, not an access token`);
}

export function requireAdmin(ctx: Ctx) {
	if (userOf(ctx)?.role !== "admin") fail("forbidden", "system admin only");
}
