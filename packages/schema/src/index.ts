import { z } from "zod";
import { PRIORITY_MAX } from "./pure";

export * from "./pure";

const md = (max = 4000) => z.string().max(max);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = z.string().regex(DATE_RE);

export const createProjectInput = z.object({
	key: z.string().regex(/^[A-Z]{2,10}$/),
	name: z.string().trim().min(1).max(100),
	description: md().default(""),
});

export const updateProjectInput = z
	.object({ name: createProjectInput.shape.name, description: md() })
	.partial();

const memberRole = z.enum(["manager", "member", "viewer"]);
export const addMemberInput = z.object({
	email: z.string().trim().toLowerCase().pipe(z.email()),
	role: memberRole,
});
export const memberRoleInput = z.object({ role: memberRole });
export const statusRenameInput = z.object({
	name: z.string().trim().min(1).max(50),
});

const title = z.string().trim().min(1).max(200);
const bodyMd = md(50000);
const flow = z.enum(["ai", "simple"]);
const labelNames = z.array(z.string().trim().min(1));
const criterion = z.object({ text: z.string().trim().min(1).max(500) });

/** Fields that can be left out or cleared (null). */
const clearable = z.object({
	typeId: z.string().nullish(),
	priority: z.number().int().min(0).max(PRIORITY_MAX).nullish(),
	assigneeId: z.string().nullish(),
	approverId: z.string().nullish(),
	parentId: z.string().nullish(),
	dueDate: date.nullish(),
	estimate: z.number().int().min(0).nullish(),
});

export const createIssueInput = clearable.extend({
	title,
	bodyMd: bodyMd.nullish(),
	flow: flow.default("ai"),
	skipPlanReview: z.boolean().default(false),
	labels: labelNames.default([]),
});

/** Clearable fields take null; title/body/flow/skipPlanReview cannot be cleared. */
export const updateIssueInput = clearable.extend({
	title: title.optional(),
	bodyMd: bodyMd.optional(),
	flow: flow.optional(),
	skipPlanReview: z.boolean().optional(),
	labels: labelNames.optional(),
});

export const criteriaInput = z.array(
	criterion.extend({ id: z.string().optional() }),
);

export const planInput = z.object({
	understandingMd: z.string().trim().min(1).max(4000),
	stepsMd: z.string().trim().min(1).max(4000),
	risksMd: md().default(""),
	criteria: z.array(criterion).optional(),
	mapping: z
		.array(
			z
				.object({
					criterionId: z.string().optional(),
					index: z.number().int().min(0).optional(),
					stepRef: z.string().max(200),
				})
				.refine(
					(m) => (m.criterionId === undefined) !== (m.index === undefined),
					{
						message: "give exactly one of criterionId / index",
					},
				),
		)
		.default([]),
});

export const evidenceInput = z.object({
	result: z.enum(["met", "unmet", "unsure"]),
	evidenceMd: md().default(""),
});

export const reportInput = z.object({
	summaryMd: z.string().trim().min(1).max(600),
	decisionsMd: z.string().trim().min(1).max(4000),
	deviationsMd: md().default(""),
	testsMd: md().default(""),
	prUrl: z.string().max(500).nullish(),
	branch: z.string().max(200).nullish(),
});

export const noteInput = z.string().trim().min(1).max(4000);

export const tokenInput = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum(["read", "write"])).min(1),
	projectIds: z.array(z.string()).nullable().default(null),
	expiresAt: z.iso
		.datetime({ offset: true })
		.transform((s) => new Date(s))
		.refine((d) => d.getTime() > Date.now(), "must be in the future")
		.nullish(),
});

export const registerInput = z.object({
	email: z.string().trim().toLowerCase().pipe(z.email()),
	name: z.string().trim().min(1).max(100),
	password: z.string().min(8).max(200),
});

export const bulkInput = updateIssueInput
	.pick({ assigneeId: true, labels: true })
	.extend({
		refs: z.array(z.string()).min(1).max(100),
		statusId: z.string().optional(),
	});

// --- small REST request bodies ---
export const loginInput = z.object({ email: z.string(), password: z.string() });
export const inviteAcceptInput = registerInput.extend({ token: z.string() });
export const noteBody = z.object({ note: z.string() });
export const optNoteBody = noteBody.partial();
export const moveInput = z.object({
	statusId: z.string(),
	rank: z.string().optional(),
});
export const completeInput = moveInput.partial();
export const answerInput = z.object({ answerMd: z.string() });
export const commentInput = z.object({ bodyMd: z.string() });
export const listQuery = z.object({
	q: z.string().default(""),
	cursor: z.preprocess(
		(v) => (v === "" ? undefined : v),
		z.coerce.number().int().min(1).optional(),
	),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});
