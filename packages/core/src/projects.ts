import {
	createDefaultIssueTypes,
	createDefaultStatuses,
	issueTypes,
	projectMembers,
	projects,
	statuses,
	users,
} from "@tasuki/db";
import {
	addMemberInput,
	createProjectInput,
	memberRoleInput,
	statusRenameInput,
	updateProjectInput,
} from "@tasuki/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { atomic, type Ctx, fail, parse, record } from "./ctx";
import {
	type Role,
	requireProjectRole,
	requireScope,
	requireSession,
} from "./permissions";

export function createProject(ctx: Ctx, input: unknown) {
	const inp = parse(createProjectInput, input);
	requireScope(ctx, "write");
	if (ctx.actor.token?.projectIds)
		fail("forbidden", "project-restricted token cannot create projects");
	return atomic(ctx, (c) => {
		if (c.db.select().from(projects).where(eq(projects.key, inp.key)).get())
			fail("conflict", `project key ${inp.key} already exists`);
		const project = c.db.insert(projects).values(inp).returning().get();
		c.db
			.insert(projectMembers)
			.values({
				projectId: project.id,
				userId: c.actor.userId,
				role: "manager",
			})
			.run();
		createDefaultStatuses(c.db, project.id);
		createDefaultIssueTypes(c.db, project.id);
		return project;
	});
}

/** Look up a project by key (case-insensitive) and check the actor's role. */
export function getProject(
	ctx: Ctx,
	key: string,
	min: Role = "viewer",
	kind?: "read" | "write",
) {
	const project = ctx.db
		.select()
		.from(projects)
		.where(eq(projects.key, key.toUpperCase()))
		.get();
	if (!project) return fail("not_found", `project ${key} not found`);
	const role = requireProjectRole(ctx, project.id, min, kind);
	return { ...project, role };
}

/** Add or change a member's role (manager only). */
export function setMember(
	ctx: Ctx,
	projectKey: string,
	userId: string,
	role: Role,
) {
	const project = getProject(ctx, projectKey, "manager");
	upsertMember(ctx, project.id, userId, role);
}

function upsertMember(ctx: Ctx, projectId: string, userId: string, role: Role) {
	ctx.db
		.insert(projectMembers)
		.values({ projectId, userId, role })
		.onConflictDoUpdate({
			target: [projectMembers.projectId, projectMembers.userId],
			set: { role },
		})
		.run();
}

const memberWhere = (projectId: string, userId: string) =>
	and(
		eq(projectMembers.projectId, projectId),
		eq(projectMembers.userId, userId),
	);
const memberOf = (ctx: Ctx, projectId: string, userId: string) =>
	ctx.db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(memberWhere(projectId, userId))
		.get();

const managerCount = (ctx: Ctx, projectId: string) =>
	ctx.db
		.select({ n: sql<number>`count(*)` })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.role, "manager"),
			),
		)
		.get()?.n ?? 0;

/** Add an existing user (by email) or change their role. Manager + session only. */
export function addMember(ctx: Ctx, key: string, input: unknown) {
	requireSession(ctx, "changing project members");
	const inp = parse(addMemberInput, input);
	const project = getProject(ctx, key, "manager");
	const user = ctx.db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, inp.email))
		.get();
	if (!user) return fail("not_found", "no user with that email");
	return atomic(ctx, (c) => {
		guardLastManager(c, project.id, user.id, inp.role);
		upsertMember(c, project.id, user.id, inp.role);
		return { userId: user.id, role: inp.role };
	});
}

/** Refuse a change that would leave the project without a manager (`to` null = removal). */
function guardLastManager(
	ctx: Ctx,
	projectId: string,
	userId: string,
	to: Role | null,
) {
	if (
		memberOf(ctx, projectId, userId)?.role === "manager" &&
		to !== "manager" &&
		managerCount(ctx, projectId) <= 1
	)
		fail("conflict", "a project needs at least one manager");
}

/** Change a member's role. Manager + session only; the last manager cannot be demoted. */
export function changeMemberRole(
	ctx: Ctx,
	key: string,
	userId: string,
	input: unknown,
) {
	requireSession(ctx, "changing project members");
	const { role } = parse(memberRoleInput, input);
	const project = getProject(ctx, key, "manager");
	return atomic(ctx, (c) => {
		const cur = memberOf(c, project.id, userId);
		if (!cur) return fail("not_found", "not a member of this project");
		guardLastManager(c, project.id, userId, role);
		c.db
			.update(projectMembers)
			.set({ role })
			.where(memberWhere(project.id, userId))
			.run();
		return { userId, role };
	});
}

/** Remove a member. Manager + session only; the last manager cannot be removed. */
export function removeMember(ctx: Ctx, key: string, userId: string) {
	requireSession(ctx, "changing project members");
	const project = getProject(ctx, key, "manager");
	atomic(ctx, (c) => {
		const cur = memberOf(c, project.id, userId);
		if (!cur) return fail("not_found", "not a member of this project");
		guardLastManager(c, project.id, userId, null);
		c.db.delete(projectMembers).where(memberWhere(project.id, userId)).run();
	});
}

/** Rename a status (name only: category and order drive the workflow). Manager + session only. */
export function renameStatus(
	ctx: Ctx,
	key: string,
	statusId: string,
	input: unknown,
) {
	requireSession(ctx, "renaming a status");
	const { name } = parse(statusRenameInput, input);
	const project = getProject(ctx, key, "manager");
	return atomic(ctx, (c) => {
		const row =
			c.db
				.update(statuses)
				.set({ name })
				.where(
					and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)),
				)
				.returning()
				.get() ?? fail("not_found", "status not found");
		record(c, "project.updated", project.id, project.key);
		return row;
	});
}

/** Projects the actor can read (token project restriction applies). One query. */
export function listProjects(ctx: Ctx) {
	requireScope(ctx, "read");
	const only = ctx.actor.token?.projectIds;
	// system admins are managers everywhere; others need a membership row
	const role = sql<Role | null>`case when ${users.role} = 'admin' then 'manager' else ${projectMembers.role} end`;
	return ctx.db
		.select({ project: projects, role })
		.from(users)
		.innerJoin(projects, only ? inArray(projects.id, only) : sql`true`)
		.leftJoin(
			projectMembers,
			and(
				eq(projectMembers.projectId, projects.id),
				eq(projectMembers.userId, users.id),
			),
		)
		.where(and(eq(users.id, ctx.actor.userId), sql`${role} is not null`))
		.all()
		.map((r) => ({ ...r.project, role: r.role as Role }));
}

export function updateProject(ctx: Ctx, key: string, patch: unknown) {
	const inp = parse(updateProjectInput, patch);
	const p = getProject(ctx, key, "manager");
	return Object.keys(inp).length
		? ctx.db
				.update(projects)
				.set(inp)
				.where(eq(projects.id, p.id))
				.returning()
				.get()
		: p;
}

/** Project plus the statuses and issue types a UI needs to render and move issues. */
export function projectDetail(ctx: Ctx, key: string) {
	const p = getProject(ctx, key);
	return {
		...p,
		statuses: ctx.db
			.select()
			.from(statuses)
			.where(eq(statuses.projectId, p.id))
			.orderBy(asc(statuses.position))
			.all(),
		// people the UI can offer as assignee / approver
		members: ctx.db
			.select({ id: users.id, name: users.name, role: projectMembers.role })
			.from(projectMembers)
			.innerJoin(users, eq(users.id, projectMembers.userId))
			.where(eq(projectMembers.projectId, p.id))
			.all(),
		issueTypes: ctx.db
			.select()
			.from(issueTypes)
			.where(eq(issueTypes.projectId, p.id))
			.all(),
	};
}
