import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () =>
	text("id")
		.primaryKey()
		.$defaultFn(() => Bun.randomUUIDv7());
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const now = (name: string) =>
	ts(name)
		.notNull()
		.$defaultFn(() => new Date());
const createdAt = () => now("created_at");

export const STATUS_CATEGORIES = [
	"draft",
	"ready",
	"plan_review",
	"in_progress",
	"impl_review",
	"done",
] as const;

export const users = sqliteTable("users", {
	id: id(),
	email: text("email").notNull().unique(),
	name: text("name").notNull(),
	passwordHash: text("password_hash").notNull(),
	role: text("role", { enum: ["admin", "member"] })
		.notNull()
		.default("member"),
	locale: text("locale").notNull().default("ja"),
	createdAt: createdAt(),
});

export const projects = sqliteTable("projects", {
	id: id(),
	key: text("key").notNull().unique(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	nextNumber: integer("next_number").notNull().default(1),
	archivedAt: ts("archived_at"),
	createdAt: createdAt(),
});

export const projectMembers = sqliteTable(
	"project_members",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["manager", "member", "viewer"] })
			.notNull()
			.default("member"),
	},
	(t) => [
		primaryKey({ columns: [t.projectId, t.userId] }),
		index("project_members_user_idx").on(t.userId),
	],
);

export const statuses = sqliteTable(
	"statuses",
	{
		id: id(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		category: text("category", { enum: STATUS_CATEGORIES }).notNull(),
		position: integer("position").notNull().default(0),
		color: text("color").notNull().default("#9ca3af"),
	},
	(t) => [index("statuses_project_idx").on(t.projectId)],
);

export const issueTypes = sqliteTable(
	"issue_types",
	{
		id: id(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		icon: text("icon"),
	},
	(t) => [index("issue_types_project_idx").on(t.projectId)],
);

export const issues = sqliteTable(
	"issues",
	{
		id: id(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		number: integer("number").notNull(),
		title: text("title").notNull(),
		bodyMd: text("body_md").notNull().default(""),
		typeId: text("type_id").references(() => issueTypes.id),
		statusId: text("status_id")
			.notNull()
			.references(() => statuses.id),
		priority: integer("priority"),
		assigneeId: text("assignee_id").references(() => users.id),
		reporterId: text("reporter_id").references(() => users.id),
		approverId: text("approver_id").references(() => users.id),
		parentId: text("parent_id").references((): AnySQLiteColumn => issues.id),
		dueDate: text("due_date"),
		estimate: integer("estimate"),
		rank: text("rank").notNull(),
		flow: text("flow", { enum: ["ai", "simple"] })
			.notNull()
			.default("ai"),
		skipPlanReview: integer("skip_plan_review", { mode: "boolean" })
			.notNull()
			.default(false),
		createdAt: createdAt(),
		updatedAt: now("updated_at"),
		closedAt: ts("closed_at"),
	},
	(t) => [
		uniqueIndex("issues_project_number_uq").on(t.projectId, t.number),
		index("issues_project_status_idx").on(t.projectId, t.statusId),
		index("issues_status_idx").on(t.statusId),
		index("issues_assignee_idx").on(t.assigneeId),
		index("issues_parent_idx").on(t.parentId),
		check(
			"issues_priority_range",
			sql`${t.priority} IS NULL OR ${t.priority} BETWEEN 0 AND 4`,
		),
	],
);

export const labels = sqliteTable(
	"labels",
	{
		id: id(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color").notNull().default("#9ca3af"),
	},
	(t) => [uniqueIndex("labels_project_name_uq").on(t.projectId, t.name)],
);

export const issueLabels = sqliteTable(
	"issue_labels",
	{
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		labelId: text("label_id")
			.notNull()
			.references(() => labels.id, { onDelete: "cascade" }),
	},
	(t) => [
		primaryKey({ columns: [t.issueId, t.labelId] }),
		index("issue_labels_label_idx").on(t.labelId),
	],
);

export const issueLinks = sqliteTable(
	"issue_links",
	{
		fromId: text("from_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		toId: text("to_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["blocks", "relates", "duplicates"] }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.fromId, t.toId, t.kind] }),
		index("issue_links_to_idx").on(t.toId),
	],
);

const issueRef = () =>
	text("issue_id")
		.notNull()
		.references(() => issues.id, { onDelete: "cascade" });

export const comments = sqliteTable(
	"comments",
	{
		id: id(),
		issueId: issueRef(),
		authorId: text("author_id").references(() => users.id),
		bodyMd: text("body_md").notNull(),
		via: text("via").notNull().default("web"),
		createdAt: createdAt(),
		editedAt: ts("edited_at"),
	},
	(t) => [index("comments_issue_idx").on(t.issueId)],
);

export const activities = sqliteTable(
	"activities",
	{
		id: id(),
		issueId: issueRef(),
		actorId: text("actor_id").references(() => users.id),
		via: text("via").notNull().default("web"),
		action: text("action").notNull(),
		field: text("field"),
		before: text("before"),
		after: text("after"),
		createdAt: createdAt(),
	},
	(t) => [index("activities_issue_idx").on(t.issueId, t.createdAt)],
);

export const apiTokens = sqliteTable("api_tokens", {
	id: id(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	/** JSON array of scope strings */
	scopes: text("scopes").notNull().default("[]"),
	/** JSON array of project ids; null = unrestricted */
	projectIds: text("project_ids"),
	lastUsedAt: ts("last_used_at"),
	expiresAt: ts("expires_at"),
	revokedAt: ts("revoked_at"),
	createdAt: createdAt(),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: ts("expires_at").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("sessions_user_idx").on(t.userId)],
);

export const invites = sqliteTable("invites", {
	id: id(),
	tokenHash: text("token_hash").notNull().unique(),
	expiresAt: ts("expires_at").notNull(),
	usedAt: ts("used_at"),
	createdBy: text("created_by")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: createdAt(),
});

export const acceptanceCriteria = sqliteTable(
	"acceptance_criteria",
	{
		id: id(),
		issueId: issueRef(),
		text: text("text").notNull(),
		position: integer("position").notNull().default(0),
		result: text("result", { enum: ["pending", "met", "unmet", "unsure"] })
			.notNull()
			.default("pending"),
		evidenceMd: text("evidence_md"),
		checkedBy: text("checked_by").references(() => users.id),
	},
	(t) => [index("criteria_issue_idx").on(t.issueId)],
);

export const plans = sqliteTable(
	"plans",
	{
		id: id(),
		issueId: issueRef(),
		version: integer("version").notNull(),
		understandingMd: text("understanding_md").notNull().default(""),
		stepsMd: text("steps_md").notNull().default(""),
		risksMd: text("risks_md").notNull().default(""),
		state: text("state", {
			enum: ["proposed", "approved", "rejected", "superseded"],
		})
			.notNull()
			.default("proposed"),
		reviewedBy: text("reviewed_by").references(() => users.id),
		reviewNote: text("review_note"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("plans_issue_version_uq").on(t.issueId, t.version)],
);

export const planCriteria = sqliteTable(
	"plan_criteria",
	{
		planId: text("plan_id")
			.notNull()
			.references(() => plans.id, { onDelete: "cascade" }),
		criterionId: text("criterion_id")
			.notNull()
			.references(() => acceptanceCriteria.id, { onDelete: "cascade" }),
		stepRef: text("step_ref"),
	},
	(t) => [
		primaryKey({ columns: [t.planId, t.criterionId] }),
		index("plan_criteria_criterion_idx").on(t.criterionId),
	],
);

export const reports = sqliteTable(
	"reports",
	{
		id: id(),
		issueId: issueRef(),
		planId: text("plan_id").references(() => plans.id),
		summaryMd: text("summary_md").notNull().default(""),
		decisionsMd: text("decisions_md").notNull().default(""),
		deviationsMd: text("deviations_md").notNull().default(""),
		testsMd: text("tests_md").notNull().default(""),
		prUrl: text("pr_url"),
		branch: text("branch"),
		state: text("state", { enum: ["submitted", "accepted", "returned"] })
			.notNull()
			.default("submitted"),
		createdAt: createdAt(),
	},
	(t) => [index("reports_issue_idx").on(t.issueId)],
);

export const questions = sqliteTable(
	"questions",
	{
		id: id(),
		issueId: issueRef(),
		askedBy: text("asked_by").references(() => users.id),
		bodyMd: text("body_md").notNull(),
		answerMd: text("answer_md"),
		answeredBy: text("answered_by").references(() => users.id),
		state: text("state", { enum: ["open", "answered"] })
			.notNull()
			.default("open"),
		createdAt: createdAt(),
	},
	(t) => [index("questions_issue_idx").on(t.issueId, t.state)],
);

export const agentSessions = sqliteTable(
	"agent_sessions",
	{
		id: id(),
		issueId: issueRef(),
		userId: text("user_id").references(() => users.id),
		client: text("client").notNull(),
		startedAt: now("started_at"),
		expiresAt: ts("expires_at").notNull(),
		endedAt: ts("ended_at"),
		outcome: text("outcome"),
	},
	(t) => [index("agent_sessions_issue_idx").on(t.issueId)],
);

export const issueTemplates = sqliteTable("issue_templates", {
	id: id(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	typeId: text("type_id").references(() => issueTypes.id, {
		onDelete: "set null",
	}),
	name: text("name").notNull(),
	bodyTemplateMd: text("body_template_md").notNull().default(""),
	/** JSON array of criteria strings */
	criteriaTemplate: text("criteria_template").notNull().default("[]"),
});

export const notifications = sqliteTable(
	"notifications",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		issueId: issueRef(),
		kind: text("kind").notNull(),
		readAt: ts("read_at"),
		createdAt: createdAt(),
	},
	(t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

export const webhooks = sqliteTable("webhooks", {
	id: id(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	url: text("url").notNull(),
	/** JSON array of event names */
	events: text("events").notNull().default("[]"),
});

export const attachments = sqliteTable(
	"attachments",
	{
		id: id(),
		issueId: issueRef(),
		filename: text("filename").notNull(),
		size: integer("size").notNull(),
		path: text("path").notNull(),
		uploadedBy: text("uploaded_by").references(() => users.id),
		createdAt: createdAt(),
	},
	(t) => [index("attachments_issue_idx").on(t.issueId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Status = typeof statuses.$inferSelect;
export type IssueType = typeof issueTypes.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type Label = typeof labels.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type IssueTemplate = typeof issueTemplates.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
