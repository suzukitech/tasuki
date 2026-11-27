import { issueTemplates, issueTypes } from "@tasuki/db";
import { templateInput, templatePatch } from "@tasuki/schema";
import { and, asc, eq } from "drizzle-orm";
import { atomic, type Ctx, fail, parse } from "./ctx";
import { requireSession } from "./permissions";
import { getProject } from "./projects";

function checkType(
	c: Ctx,
	projectId: string,
	typeId: string | null | undefined,
) {
	if (
		typeId &&
		c.db.query.issueTypes.findFirst({ where: eq(issueTypes.id, typeId) }).sync()
			?.projectId !== projectId
	)
		fail("invalid", "unknown issue type");
}

export const listTemplates = (ctx: Ctx, key: string) =>
	ctx.db
		.select()
		.from(issueTemplates)
		.where(eq(issueTemplates.projectId, getProject(ctx, key).id))
		.orderBy(asc(issueTemplates.name), asc(issueTemplates.id))
		.all();

export function createTemplate(ctx: Ctx, key: string, input: unknown) {
	const inp = parse(templateInput, input);
	requireSession(ctx, "editing templates");
	return atomic(ctx, (c) => {
		const p = getProject(c, key, "manager");
		checkType(c, p.id, inp.typeId);
		return c.db
			.insert(issueTemplates)
			.values({ ...inp, typeId: inp.typeId ?? null, projectId: p.id })
			.returning()
			.get();
	});
}

export function updateTemplate(
	ctx: Ctx,
	key: string,
	id: string,
	input: unknown,
) {
	const inp = parse(templatePatch, input);
	requireSession(ctx, "editing templates");
	return atomic(ctx, (c) => {
		const p = getProject(c, key, "manager");
		checkType(c, p.id, inp.typeId);
		const set = Object.fromEntries(
			Object.entries(inp).filter(([, v]) => v !== undefined),
		);
		const where = and(
			eq(issueTemplates.id, id),
			eq(issueTemplates.projectId, p.id),
		);
		const row = Object.keys(set).length
			? c.db.update(issueTemplates).set(set).where(where).returning().get()
			: c.db.select().from(issueTemplates).where(where).get();
		return row ?? fail("not_found", "template not found");
	});
}

export function deleteTemplate(ctx: Ctx, key: string, id: string) {
	requireSession(ctx, "editing templates");
	atomic(ctx, (c) => {
		const p = getProject(c, key, "manager");
		const n = c.db
			.delete(issueTemplates)
			.where(and(eq(issueTemplates.id, id), eq(issueTemplates.projectId, p.id)))
			.returning()
			.all().length;
		if (!n) fail("not_found", "template not found");
	});
}
