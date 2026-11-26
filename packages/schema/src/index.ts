import { z } from "zod";

export const PRIORITIES = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
	urgent: 4,
} as const;

const md = (max = 4000) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createProjectInput = z.object({
	key: z.string().regex(/^[A-Z]{2,10}$/),
	name: z.string().trim().min(1).max(100),
	description: md().default(""),
});

const issueFields = {
	bodyMd: md(50000),
	typeId: z.string(),
	priority: z.number().int().min(0).max(4),
	assigneeId: z.string(),
	approverId: z.string(),
	parentId: z.string(),
	dueDate: date,
	estimate: z.number().int().min(0),
};

export const createIssueInput = z.object({
	title: z.string().trim().min(1).max(200),
	bodyMd: issueFields.bodyMd.nullish(),
	typeId: issueFields.typeId.nullish(),
	priority: issueFields.priority.nullish(),
	assigneeId: issueFields.assigneeId.nullish(),
	approverId: issueFields.approverId.nullish(),
	parentId: issueFields.parentId.nullish(),
	dueDate: issueFields.dueDate.nullish(),
	estimate: issueFields.estimate.nullish(),
	flow: z.enum(["ai", "simple"]).default("ai"),
	skipPlanReview: z.boolean().default(false),
	labels: z.array(z.string().trim().min(1)).default([]),
});

/** Clearable fields take null; title/body/flow/skipPlanReview cannot be cleared. */
export const updateIssueInput = z.object({
	title: z.string().trim().min(1).max(200).optional(),
	bodyMd: issueFields.bodyMd.optional(),
	typeId: issueFields.typeId.nullable().optional(),
	priority: issueFields.priority.nullable().optional(),
	assigneeId: issueFields.assigneeId.nullable().optional(),
	approverId: issueFields.approverId.nullable().optional(),
	parentId: issueFields.parentId.nullable().optional(),
	dueDate: issueFields.dueDate.nullable().optional(),
	estimate: issueFields.estimate.nullable().optional(),
	flow: z.enum(["ai", "simple"]).optional(),
	skipPlanReview: z.boolean().optional(),
	labels: z.array(z.string().trim().min(1)).optional(),
});

export const criteriaInput = z.array(
	z.object({
		id: z.string().optional(),
		text: z.string().trim().min(1).max(500),
	}),
);

export const planInput = z.object({
	understandingMd: z.string().trim().min(1).max(4000),
	stepsMd: z.string().trim().min(1).max(4000),
	risksMd: md().default(""),
	criteria: z
		.array(z.object({ text: z.string().trim().min(1).max(500) }))
		.optional(),
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
	expiresAt: z.date().nullish(),
});

export const registerInput = z.object({
	email: z.string().trim().toLowerCase().pipe(z.email()),
	name: z.string().trim().min(1).max(100),
	password: z.string().min(8).max(200),
});
