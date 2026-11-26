import { activities, type Db } from "@tasuki/db";
import type { tokenInput } from "@tasuki/schema";
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
export type Ctx = { db: Db; actor: Actor; now?: () => Date };

const STATUS = {
	not_found: 404,
	forbidden: 403,
	conflict: 409,
	invalid: 400,
	gate: 409,
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

/** Run `fn` in a transaction. Nested calls become savepoints. */
export function atomic<T>(ctx: Ctx, fn: (c: Ctx) => T): T {
	// the drizzle transaction handle has the same query API as Db
	return ctx.db.transaction((tx) => fn({ ...ctx, db: tx as unknown as Db }));
}

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

/** Append an activity row (who/via/what changed) for an issue. */
export function log(
	ctx: Ctx,
	issueId: string,
	action: string,
	field?: string,
	before?: unknown,
	after?: unknown,
) {
	ctx.db
		.insert(activities)
		.values({
			issueId,
			actorId: ctx.actor.userId,
			via: ctx.actor.via,
			action,
			field: field ?? null,
			before: text(before),
			after: text(after),
			createdAt: nowOf(ctx),
		})
		.run();
}
