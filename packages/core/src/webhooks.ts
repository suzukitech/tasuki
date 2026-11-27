import { issues, projects, webhooks } from "@tasuki/db";
import { webhookInput } from "@tasuki/schema";
import type { WebhookEvent } from "@tasuki/schema/pure";
import { and, asc, eq } from "drizzle-orm";
import { atomic, type Ctx, fail, type IssueEvent, parse } from "./ctx";
import { requireSession } from "./permissions";
import { getProject } from "./projects";

const MAX_PER_PROJECT = 10;

/** `https://host/…abcd`: enough to recognise it, not enough to use it (the URL is a secret). */
export function maskUrl(url: string) {
	try {
		return `${new URL(url).origin}/…${url.slice(-4)}`;
	} catch {
		return "…";
	}
}

const view = (w: typeof webhooks.$inferSelect) => ({
	id: w.id,
	url: maskUrl(w.url),
	events: JSON.parse(w.events) as WebhookEvent[],
});

/** Manager + login session: the URL is a credential, tokens never touch webhooks. */
function manage(ctx: Ctx, key: string) {
	requireSession(ctx, "managing webhooks");
	return getProject(ctx, key, "manager");
}

export const listWebhooks = (ctx: Ctx, key: string) =>
	ctx.db
		.select()
		.from(webhooks)
		.where(eq(webhooks.projectId, manage(ctx, key).id))
		.orderBy(asc(webhooks.id))
		.all()
		.map(view);

export function createWebhook(ctx: Ctx, key: string, input: unknown) {
	const inp = parse(webhookInput, input);
	return atomic(ctx, (c) => {
		const p = manage(c, key);
		const n = c.db
			.select({ id: webhooks.id })
			.from(webhooks)
			.where(eq(webhooks.projectId, p.id))
			.all().length;
		if (n >= MAX_PER_PROJECT) fail("conflict", "too many webhooks");
		return view(
			c.db
				.insert(webhooks)
				.values({
					projectId: p.id,
					url: inp.url,
					events: JSON.stringify([...new Set(inp.events)]),
				})
				.returning()
				.get(),
		);
	});
}

export function deleteWebhook(ctx: Ctx, key: string, id: string) {
	const p = manage(ctx, key);
	const n = ctx.db
		.delete(webhooks)
		.where(and(eq(webhooks.id, id), eq(webhooks.projectId, p.id)))
		.returning()
		.all().length;
	if (!n) fail("not_found", "webhook not found");
}

/** The full URL of one webhook, for the test-send route only. */
export function webhookForTest(ctx: Ctx, key: string, id: string) {
	const p = manage(ctx, key);
	const w = ctx.db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, id), eq(webhooks.projectId, p.id)))
		.get();
	return w ?? fail("not_found", "webhook not found");
}

const WHAT: Record<WebhookEvent, string> = {
	"plan.submitted": "計画が提出されました。確認をお願いします",
	"report.submitted": "結果レポートが提出されました。確認をお願いします",
	"question.asked": "AIから質問が届きました。回答をお願いします",
	"question.answered": "質問に回答がありました",
	"issue.assigned": "担当者が割り当てられました",
	"issue.completed": "完了しました",
};
export const isWebhookEvent = (t: string): t is WebhookEvent => t in WHAT;

/** Slack mrkdwn treats & < > specially. */
const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack-compatible `{text}` payload body for an event; null when it is not a webhook event. */
export function webhookText(db: Ctx["db"], e: IssueEvent, baseUrl: string) {
	if (!isWebhookEvent(e.type)) return null;
	const n = Number(/-(\d+)$/.exec(e.ref)?.[1]);
	const issue = db
		.select({ title: issues.title })
		.from(issues)
		.innerJoin(projects, eq(projects.id, issues.projectId))
		.where(and(eq(projects.id, e.projectId), eq(issues.number, n)))
		.get();
	if (!issue) return null;
	const link = `${baseUrl.replace(/\/$/, "")}/p/${e.ref.replace(/-\d+$/, "")}?issue=${e.ref}`;
	return `*${e.ref}* ${esc(issue.title)}\n${WHAT[e.type]}\n${link}`;
}

export const testText = () => "Tasuki: Webhookのテスト送信です";

/** Subscribed webhooks (full URL) for a project event. Internal: the server's delivery path. */
export function webhookTargets(db: Ctx["db"], e: IssueEvent) {
	if (!isWebhookEvent(e.type)) return [];
	return db
		.select()
		.from(webhooks)
		.where(eq(webhooks.projectId, e.projectId))
		.all()
		.filter((w) => (JSON.parse(w.events) as string[]).includes(e.type))
		.map((w) => ({ id: w.id, url: w.url }));
}
