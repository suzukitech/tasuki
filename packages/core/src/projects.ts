import {
	createDefaultIssueTypes,
	createDefaultStatuses,
	projectMembers,
	projects,
} from "@tasuki/db";
import { createProjectInput } from "@tasuki/schema";
import { eq } from "drizzle-orm";
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
