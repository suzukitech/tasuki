import { z } from "zod";

export const PRIORITIES = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
	urgent: 4,
} as const;

const md = (max = 4000) => z.string().max(max);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = z.string().regex(DATE_RE);

export const createProjectInput = z.object({
	key: z.string().regex(/^[A-Z]{2,10}$/),
	name: z.string().trim().min(1).max(100),
	description: md().default(""),
});

const title = z.string().trim().min(1).max(200);
const bodyMd = md(50000);
const flow = z.enum(["ai", "simple"]);
const labelNames = z.array(z.string().trim().min(1));
const criterion = z.object({ text: z.string().trim().min(1).max(500) });

/** Fields that can be left out or cleared (null). */
const clearable = z.object({
	typeId: z.string().nullish(),
	priority: z.number().int().min(0).max(4).nullish(),
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
	expiresAt: z.date().nullish(),
});

export const registerInput = z.object({
	email: z.string().trim().toLowerCase().pipe(z.email()),
	name: z.string().trim().min(1).max(100),
	password: z.string().min(8).max(200),
});
