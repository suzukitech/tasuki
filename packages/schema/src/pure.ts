// Zod-free helpers shared with the browser: the web bundle imports only this module.

export const STATUS_CATEGORIES = [
	"draft",
	"ready",
	"plan_review",
	"in_progress",
	"impl_review",
	"done",
] as const;
export type Category = (typeof STATUS_CATEGORIES)[number];

/** Every event type core records; the SSE stream and the web listener both derive from this. */
export const EVENT_TYPES = [
	"issue.created",
	"issue.updated",
	"issue.deleted",
	"issue.moved",
	"issue.started",
	"issue.completed",
	"issue.commented",
	"plan.submitted",
	"plan.approved",
	"plan.rejected",
	"criteria.updated",
	"evidence.recorded",
	"report.submitted",
	"report.returned",
	"question.asked",
	"question.answered",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PRIORITIES = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
	urgent: 4,
} as const;
/** Priority label ("high"), "none" for null / 0. */
export const priorityName = (p: number | null) =>
	Object.entries(PRIORITIES).find(([, v]) => v === (p ?? 0))?.[0] ?? String(p);
export const PRIORITY_MAX = Math.max(...Object.values(PRIORITIES));

/** "fix login @taro #bug !high" → title + assignee/labels/priority. Accepts full-width ＠＃！. */
export function parseQuickTitle(text: string) {
	const out: {
		title: string;
		assignee?: string;
		labels: string[];
		priority?: number;
	} = {
		title: "",
		labels: [],
	};
	const words: string[] = [];
	for (const w of text.trim().split(/\s+/)) {
		const body = w.slice(1);
		const p = body.toLowerCase();
		if (!body) words.push(w);
		else if (/^[@＠]/.test(w)) out.assignee = body;
		else if (/^[#＃]/.test(w)) out.labels.push(body);
		else if (/^[!！]/.test(w) && p in PRIORITIES)
			out.priority = PRIORITIES[p as keyof typeof PRIORITIES];
		else words.push(w);
	}
	out.title = words.join(" ");
	return out;
}

/** Who passes the plan / report gates: the approver, or the requester when none is set. */
export const reviewerOf = (issue: {
	approverId: string | null;
	reporterId: string | null;
}) => issue.approverId ?? issue.reporterId;

/** Whose move is it? null when nobody's (done). */
export function whoseTurn(
	issue: {
		category: string;
		reporterId: string | null;
		assigneeId: string | null;
		approverId: string | null;
	},
	userId: string,
): "you" | "ai" | "others" | null {
	const who = (id: string | null) => (id === userId ? "you" : "others");
	switch (issue.category) {
		case "draft":
			return who(issue.reporterId);
		case "ready":
		case "in_progress":
			return issue.assigneeId ? "ai" : who(issue.reporterId);
		case "plan_review":
		case "impl_review":
			return who(reviewerOf(issue));
		default:
			return null;
	}
}
