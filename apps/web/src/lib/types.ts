import type { Category } from "@tasuki/schema/pure";

export type { Category };
// Response shapes of apps/server (hand-written: the Hono routes are not chained, so AppType carries no types).
export type Role = "manager" | "member" | "viewer";
export type Me = {
	id: string;
	email: string;
	name: string;
	role: "admin" | "member";
	auth: "session" | "token";
};
export type Project = { id: string; key: string; name: string; role: Role };
export type Status = {
	id: string;
	name: string;
	category: Category;
	position: number;
};
export type Member = { id: string; name: string; role: Role };
export type ProjectDetail = Project & { statuses: Status[]; members: Member[] };
export type IssueCore = {
	id: string;
	ref: string;
	number: number;
	title: string;
	statusId: string;
	priority: number | null;
	assigneeId: string | null;
	reporterId: string | null;
	approverId: string | null;
	dueDate: string | null;
	flow: "ai" | "simple";
	updatedAt: string;
};
/** A list row also carries its label names and its unanswered-question count. */
export type IssueRow = IssueCore & { labels: string[]; openQuestions: number };
export type Issue = IssueCore & {
	bodyMd: string;
	skipPlanReview: boolean;
};
export type Criterion = {
	id: string;
	text: string;
	position: number;
	result: "pending" | "met" | "unmet" | "unsure";
	evidenceMd: string | null;
};
export type Plan = {
	id: string;
	version: number;
	understandingMd: string;
	stepsMd: string;
	risksMd: string;
	state: "proposed" | "approved" | "rejected" | "superseded";
	reviewNote: string | null;
};
export type Report = {
	id: string;
	summaryMd: string;
	decisionsMd: string;
	deviationsMd: string;
	testsMd: string;
	prUrl: string | null;
	state: "submitted" | "accepted" | "returned";
};
export type Question = {
	id: string;
	askedBy: string | null;
	bodyMd: string;
	answerMd: string | null;
	answeredBy: string | null;
	via: string | null;
	state: "open" | "answered";
	createdAt: string;
	/** null while open, and on answers from before the column existed */
	answeredAt: string | null;
};
export type Comment = {
	id: string;
	authorId: string | null;
	bodyMd: string;
	via: string;
	createdAt: string;
};
export type Activity = {
	id: string;
	actorId: string | null;
	via: string;
	action: string;
	field: string | null;
	before: string | null;
	after: string | null;
	createdAt: string;
};
export type IssueDetail = {
	issue: Issue;
	category: Category;
	statusName: string;
	ref: string;
	project: Project;
	labels: string[];
	criteria: Criterion[];
	plans: Plan[];
	planCriteria: {
		planId: string;
		criterionId: string;
		stepRef: string | null;
	}[];
	reports: Report[];
	questions: Question[];
	openQuestions: number;
	comments: Comment[];
	activities: Activity[];
};
export type Page = { items: IssueRow[]; nextCursor: number | null };
