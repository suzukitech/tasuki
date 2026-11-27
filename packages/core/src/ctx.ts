import { activities, type Conn } from "@tasuki/db";
import type { EventType, tokenInput } from "@tasuki/schema";
import type { z } from "zod";

export type Actor = {
	userId: string;
	/** 'web' | 'cli' | 'mcp:<client>' | 'import' */
	via: string;
	auth: "session" | "token";
	token?: {
		scopes: z.output<typeof tokenInput>["scopes"];
		projectIds: string[] | null;
	};
};
export type IssueEvent = {
	type: EventType;
	projectId: string;
	ref: string;
	/** user-scoped event: only this user's stream receives it */
	userId?: string;
};
export type Ctx = {
	db: Conn;
	actor: Actor;
	now?: () => Date;
	/** Called once per recorded event, only after the outermost transaction commits. */
	emit?: (e: IssueEvent) => void;
	/** Events recorded inside the running `atomic` (internal). */
	pending?: IssueEvent[];
};

const STATUS = {
	not_found: 404,
	forbidden: 403,
	conflict: 409,
	invalid: 400,
	gate: 409,
	precondition: 412,
	unauthorized: 401,
	csrf: 403,
	unsupported_media: 415,
	rate_limited: 429,
	too_large: 413,
} as const;

export class TasukiError extends Error {
	code: keyof typeof STATUS;
	status: number;
	constructor(code: keyof typeof STATUS, message: string) {
		super(message);
		this.code = code;
		this.status = STATUS[code];
	}
}

export const fail = (code: keyof typeof STATUS, message: string): never => {
	throw new TasukiError(code, message);
};

export const nowOf = (ctx: { now?: () => Date }) =>
	(ctx.now ?? (() => new Date()))();

/**
 * Run `fn` in a transaction. Nested calls become savepoints.
 * Events recorded with `record` fire via `ctx.emit` after the outermost commit, never on rollback.
 */
export function atomic<T>(ctx: Ctx, fn: (c: Ctx) => T): T {
	const pending = ctx.pending ?? [];
	const out = ctx.db.transaction((tx) => fn({ ...ctx, db: tx, pending }));
	if (!ctx.pending) for (const e of pending) ctx.emit?.(e);
	return out;
}

/** Queue an issue event (call inside `atomic`). */
export const record = (
	c: Ctx,
	type: EventType,
	projectId: string,
	ref: string,
	userId?: string,
) =>
	void c.pending?.push(
		userId ? { type, projectId, ref, userId } : { type, projectId, ref },
	);

export function parse<T extends z.ZodType>(
	schema: T,
	input: unknown,
): z.output<T> {
	const r = schema.safeParse(input);
	if (r.success) return r.data;
	return fail(
		"invalid",
		r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
	);
}

const text = (v: unknown) =>
	v === null || v === undefined
		? null
		: typeof v === "string"
			? v
			: JSON.stringify(v);

type Entry = {
	action: string;
	field?: string;
	before?: unknown;
	after?: unknown;
};

/** Append activity rows (who/via/what changed) for an issue in one insert. */
export function logAll(ctx: Ctx, issueId: string, entries: Entry[]) {
	if (!entries.length) return;
	const createdAt = nowOf(ctx);
	ctx.db
		.insert(activities)
		.values(
			entries.map((e) => ({
				issueId,
				actorId: ctx.actor.userId,
				via: ctx.actor.via,
				action: e.action,
				field: e.field ?? null,
				before: text(e.before),
				after: text(e.after),
				createdAt,
			})),
		)
		.run();
}

export function log(
	ctx: Ctx,
	issueId: string,
	action: string,
	field?: string,
	before?: unknown,
	after?: unknown,
) {
	logAll(ctx, issueId, [{ action, field, before, after }]);
}
