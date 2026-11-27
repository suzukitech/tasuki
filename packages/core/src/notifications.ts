import { issues, notifications, projects } from "@tasuki/db";
import { notificationReadInput } from "@tasuki/schema";
import type { NotificationKind } from "@tasuki/schema/pure";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Ctx, nowOf, parse, record } from "./ctx";
import { projectRole, requireScope } from "./permissions";

/**
 * Tell `userId` it is their turn on `l`. Call inside `atomic`: the row commits with the
 * change and the user-scoped event fires after commit. Never notifies the actor.
 */
export function notify(
	c: Ctx,
	l: { issue: { id: string }; project: { id: string }; ref: string },
	kind: NotificationKind,
	userId: string | null | undefined,
) {
	if (!userId || userId === c.actor.userId) return;
	c.db
		.insert(notifications)
		.values({ userId, issueId: l.issue.id, kind, createdAt: nowOf(c) })
		.run();
	record(c, "notification.created", l.project.id, l.ref, userId);
}

/**
 * The actor's own notifications, unread first then newest first.
 * ponytail: `unread` counts rows in the db, including issues in projects the user has
 * since lost access to (those rows are hidden from `items`). Prune on member removal if it shows.
 */
export function listNotifications(ctx: Ctx, limit = 30) {
	requireScope(ctx, "read");
	const uid = ctx.actor.userId;
	const rows = ctx.db
		.select({
			id: notifications.id,
			kind: notifications.kind,
			readAt: notifications.readAt,
			createdAt: notifications.createdAt,
			projectId: projects.id,
			key: projects.key,
			number: issues.number,
			title: issues.title,
		})
		.from(notifications)
		.innerJoin(issues, eq(issues.id, notifications.issueId))
		.innerJoin(projects, eq(projects.id, issues.projectId))
		.where(eq(notifications.userId, uid))
		.orderBy(
			sql`${notifications.readAt} is not null`,
			desc(notifications.createdAt),
			desc(notifications.id),
		)
		.limit(Math.min(Math.max(limit, 1), 100))
		.all();
	const readable = new Map<string, boolean>();
	const ok = (id: string) => {
		if (!readable.has(id)) {
			let can = projectRole(ctx, id) !== null;
			try {
				requireScope(ctx, "read", id);
			} catch {
				can = false;
			}
			readable.set(id, can);
		}
		return readable.get(id);
	};
	const unread =
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(notifications)
			.where(and(eq(notifications.userId, uid), isNull(notifications.readAt)))
			.get()?.n ?? 0;
	return {
		items: rows
			.filter((r) => ok(r.projectId))
			.map(({ projectId: _p, key, number, ...r }) => ({
				...r,
				ref: `${key}-${number}`,
			})),
		unread,
	};
}

/** Mark some (or all) of the actor's own notifications read. */
export function markNotificationsRead(ctx: Ctx, input: unknown) {
	requireScope(ctx, "write");
	const inp = parse(notificationReadInput, input);
	const mine = eq(notifications.userId, ctx.actor.userId);
	ctx.db
		.update(notifications)
		.set({ readAt: nowOf(ctx) })
		.where(
			and(
				mine,
				isNull(notifications.readAt),
				"all" in inp ? undefined : inArray(notifications.id, inp.ids),
			),
		)
		.run();
}
