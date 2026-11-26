import {
	createDefaultIssueTypes,
	createDefaultStatuses,
	issueTypes,
	projectMembers,
	projects,
	statuses,
	users,
} from "@tasuki/db";
import { createProjectInput, updateProjectInput } from "@tasuki/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { atomic, type Ctx, fail, parse } from "./ctx";
import { type Role, requireProjectRole, requireScope } from "./permissions";

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
	ctx.db
		.insert(projectMembers)
		.values({ projectId: project.id, userId, role })
		.onConflictDoUpdate({
			target: [projectMembers.projectId, projectMembers.userId],
			set: { role },
		})
		.run();
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
