import {
	type Actor,
	acceptInvite,
	addComment,
	answerQuestion,
	approvePlan,
	bulkUpdate,
	type Ctx,
	completeIssue,
	createApiToken,
	createInvite,
	createIssue,
	createProject,
	deleteIssue,
	destroySession,
	getIssue,
	getMe,
	listActivities,
	listApiTokens,
	listComments,
	listProjects,
	loadIssue,
	loadIssueById,
	login,
	moveIssue,
	needsSetup,
	pageIssues,
	parse,
	projectDetail,
	refOf,
	rejectPlan,
	resolveSession,
	resolveToken,
	returnReport,
	revokeApiToken,
	setupFirstAdmin,
	TasukiError,
	updateCriteria,
	updateIssue,
	updateProject,
} from "@tasuki/core";
import type { Db } from "@tasuki/db";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createEvents } from "./events";

type Env = {
	Variables: { ctx: Ctx; session?: string };
	Bindings: { ip?: string };
};
type C = Context<Env>;

const SESSION = "tasuki_session";
const CSRF = "tasuki_csrf";
const MONTH = 30 * 86_400;
const PUBLIC = new Set([
	"/api/v1/setup/status",
	"/api/v1/setup",
	"/api/v1/auth/login",
	"/api/v1/invites/accept",
]);

class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	409: "Conflict",
	412: "Precondition Failed",
	429: "Too Many Requests",
};

const problem = (status: number, code: string, detail: string) =>
	new Response(
		JSON.stringify({
			type: `urn:tasuki:problem:${code}`,
			title: TITLES[status] ?? "Internal Server Error",
			status,
			detail,
			code,
		}),
		{
			status,
			headers: {
				"content-type": "application/problem+json",
				...(status === 429 && { "retry-after": "60" }),
			},
		},
	);

/** Per-session CSRF value, derived from the session token (no server secret needed). */
const csrfOf = (session: string) =>
	new Bun.CryptoHasher("sha256").update(`csrf:${session}`).digest("hex");

/**
 * Fixed-window counter per key.
 * ponytail: in-memory, single process; a multi-instance deploy needs a shared store.
 */
function rateLimiter(max: number, windowMs = 60_000) {
	const hits = new Map<string, { n: number; reset: number }>();
	const live = (k: string) => {
		const e = hits.get(k);
		return e && e.reset > Date.now() ? e : undefined;
	};
	return {
		blocked: (k: string) => (live(k)?.n ?? 0) >= max,
		hit(k: string) {
			const e = live(k);
			if (e) return void e.n++;
			if (hits.size > 10_000)
				for (const [key] of hits) if (!live(key)) hits.delete(key);
			hits.set(k, { n: 1, reset: Date.now() + windowMs });
		},
	};
}

const json = async (c: C, optional = false): Promise<unknown> => {
	try {
		return await c.req.json();
	} catch {
		if (optional) return {};
		throw new TasukiError("invalid", "request body must be JSON");
	}
};

const noteBody = z.object({ note: z.string() });
const optNoteBody = z.object({ note: z.string().optional() });
const moveBody = z.object({
	statusId: z.string(),
	rank: z.string().optional(),
});
const completeBody = z.object({
	statusId: z.string().optional(),
	rank: z.string().optional(),
});
const answerBody = z.object({ answerMd: z.string() });
const commentBody = z.object({ bodyMd: z.string() });
const loginBody = z.object({ email: z.string(), password: z.string() });
const listQuery = z.object({
	q: z.string().default(""),
	cursor: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function createApp(
	db: Db,
	opts: { baseUrl: string; rateLimit?: number },
) {
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const secure = baseUrl.startsWith("https:");
	const limiter = rateLimiter(opts.rateLimit ?? 10);
	const events = createEvents();
	const app = new Hono<Env>();
	const api = new Hono<Env>();

	const ipOf = (c: C) =>
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
		c.env?.ip ||
		"local";
	const tooMany = () => new ApiError(429, "rate_limited", "too many attempts");
	const setCookies = (c: C, session: string) => {
		const base = { sameSite: "Lax", secure, path: "/", maxAge: MONTH } as const;
		setCookie(c, SESSION, session, { ...base, httpOnly: true });
		setCookie(c, CSRF, csrfOf(session), { ...base, httpOnly: false });
	};
	const ctxOf = (c: C) => c.get("ctx");
	const announce = (c: C, type: string, ref: string) =>
		events.publish(type, loadIssue(ctxOf(c), ref).project.id, ref);

	app.onError((e) => {
		if (e instanceof TasukiError || e instanceof ApiError)
			return problem(e.status, e.code, e.message);
		console.error(e);
		return problem(500, "internal", "internal server error");
	});
	app.notFound(() => problem(404, "not_found", "no such route"));
	app.get("/health", (c) => c.json({ ok: true }));

	api.use("*", async (c, next) => {
		if (PUBLIC.has(c.req.path)) return next();
		const bearer = /^Bearer\s+(\S+)$/i.exec(
			c.req.header("authorization") ?? "",
		);
		let actor: Actor | null = null;
		if (bearer) {
			if (limiter.blocked(ipOf(c))) throw tooMany();
			const client = (c.req.header("x-tasuki-client") ?? "")
				.replace(/[^\w.-]/g, "")
				.slice(0, 40);
			actor = resolveToken(
				db,
				bearer[1] ?? "",
				client ? `mcp:${client}` : "cli",
			);
			if (!actor) limiter.hit(ipOf(c));
		} else {
			const session = getCookie(c, SESSION);
			actor = session ? resolveSession(db, session) : null;
			if (session && actor) {
				c.set("session", session);
				const safe = ["GET", "HEAD", "OPTIONS"].includes(c.req.method);
				if (!safe && c.req.header("x-tasuki-csrf") !== csrfOf(session))
					throw new ApiError(403, "csrf", "missing or invalid X-Tasuki-CSRF");
			}
		}
		if (!actor)
			throw new ApiError(401, "unauthorized", "authentication required");
		c.set("ctx", { db, actor });
		return next();
	});

	// --- setup / auth ---
	api.get("/setup/status", (c) => c.json({ needsSetup: needsSetup(db) }));
	api.post("/setup", async (c) => {
		const u = await setupFirstAdmin(db, await json(c));
		return c.json(
			{ id: u.id, email: u.email, name: u.name, role: u.role },
			201,
		);
	});
	api.post("/auth/login", async (c) => {
		if (limiter.blocked(ipOf(c))) throw tooMany();
		const b = loginBody.safeParse(await json(c));
		const session = b.success
			? await login(db, b.data.email, b.data.password)
			: null;
		const actor = session ? resolveSession(db, session) : null;
		if (!session || !actor) {
			limiter.hit(ipOf(c));
			throw new ApiError(401, "unauthorized", "invalid email or password");
		}
		setCookies(c, session);
		return c.json(getMe({ db, actor }));
	});
	api.post("/auth/logout", (c) => {
		const s = c.get("session");
		if (s) destroySession(db, s);
		deleteCookie(c, SESSION, { path: "/" });
		deleteCookie(c, CSRF, { path: "/" });
		return c.body(null, 204);
	});
	api.post("/invites", (c) => {
		const r = createInvite(ctxOf(c));
		return c.json({ ...r, url: `${baseUrl}/invite/${r.token}` }, 201);
	});
	api.post("/invites/accept", async (c) => {
		const { token, ...rest } = (await json(c)) as Record<string, unknown>;
		const u = await acceptInvite(db, String(token ?? ""), rest);
		return c.json({ id: u.id, email: u.email, name: u.name }, 201);
	});

	// --- me / tokens ---
	api.get("/me", (c) =>
		c.json({
			...getMe(ctxOf(c)),
			auth: ctxOf(c).actor.auth,
			via: ctxOf(c).actor.via,
		}),
	);
	api.get("/me/tokens", (c) => c.json(listApiTokens(ctxOf(c))));
	api.post("/me/tokens", async (c) => {
		const b = (await json(c)) as Record<string, unknown>;
		const r = createApiToken(ctxOf(c), {
			...b,
			expiresAt: b.expiresAt ? new Date(String(b.expiresAt)) : undefined,
		});
		return c.json(
			{
				...r,
				claudeMcpAdd: `claude mcp add --transport http tasuki ${baseUrl}/mcp --header "Authorization: Bearer ${r.token}"`,
			},
			201,
		);
	});
	api.delete("/me/tokens/:id", (c) => {
		revokeApiToken(ctxOf(c), c.req.param("id"));
		return c.body(null, 204);
	});

	// --- projects ---
	api.get("/projects", (c) => c.json(listProjects(ctxOf(c))));
	api.post("/projects", async (c) =>
		c.json(createProject(ctxOf(c), await json(c)), 201),
	);
	api.get("/projects/:key", (c) =>
		c.json(projectDetail(ctxOf(c), c.req.param("key"))),
	);
	api.patch("/projects/:key", async (c) =>
		c.json(updateProject(ctxOf(c), c.req.param("key"), await json(c))),
	);
	api.get("/projects/:key/issues", (c) => {
		const key = c.req.param("key");
		const q = parse(listQuery, c.req.query());
		const page = pageIssues(ctxOf(c), key, q.q, q);
		return c.json({
			items: page.items.map((i) => ({
				...i,
				ref: refOf(key.toUpperCase(), i.number),
			})),
			nextCursor: page.nextCursor,
		});
	});
	api.post("/projects/:key/issues", async (c) => {
		const key = c.req.param("key").toUpperCase();
		const i = createIssue(ctxOf(c), key, await json(c));
		const ref = refOf(key, i.number);
		events.publish("issue.created", i.projectId, ref);
		return c.json({ ...i, ref }, 201);
	});

	// --- issues ---
	const etag = (d: Date) => `"${d.getTime()}"`;
	api.post("/issues/bulk", async (c) => {
		const refs = bulkUpdate(ctxOf(c), await json(c));
		for (const r of refs) announce(c, "issue.updated", r);
		return c.json({ refs });
	});
	api.get("/issues/:ref", (c) => {
		const r = getIssue(ctxOf(c), c.req.param("ref"));
		c.header("ETag", etag(r.issue.updatedAt));
		return c.json(r);
	});
	api.patch("/issues/:ref", async (c) => {
		const ref = c.req.param("ref");
		const inm = c.req.header("if-match");
		const m = inm === undefined ? null : /^(?:W\/)?"(\d+)"$/.exec(inm);
		if (inm !== undefined && !m)
			throw new TasukiError("invalid", "If-Match must be an ETag from GET");
		const i = updateIssue(ctxOf(c), ref, await json(c), {
			ifMatch: m ? Number(m[1]) : undefined,
		});
		const l = loadIssue(ctxOf(c), ref);
		events.publish("issue.updated", l.project.id, l.ref);
		c.header("ETag", etag(i.updatedAt));
		return c.json({ ...i, ref: l.ref });
	});
	api.delete("/issues/:ref", (c) => {
		const l = loadIssue(ctxOf(c), c.req.param("ref"));
		deleteIssue(ctxOf(c), l.ref);
		events.publish("issue.deleted", l.project.id, l.ref);
		return c.body(null, 204);
	});
	api.post("/issues/:ref/move", async (c) => {
		const ref = c.req.param("ref");
		moveIssue(ctxOf(c), ref, parse(moveBody, await json(c)));
		announce(c, "issue.moved", ref);
		return c.body(null, 204);
	});
	api.get("/issues/:ref/comments", (c) =>
		c.json(listComments(ctxOf(c), c.req.param("ref"))),
	);
	api.post("/issues/:ref/comments", async (c) => {
		const ref = c.req.param("ref");
		const { bodyMd } = parse(commentBody, await json(c));
		const row = addComment(ctxOf(c), ref, bodyMd);
		announce(c, "issue.commented", ref);
		return c.json(row, 201);
	});
	api.get("/issues/:ref/activities", (c) =>
		c.json(listActivities(ctxOf(c), c.req.param("ref"))),
	);

	// --- workflow (human gates: core rejects token actors) ---
	api.post("/issues/:ref/plan/approve", async (c) => {
		const ref = c.req.param("ref");
		const { note } = parse(optNoteBody, await json(c, true));
		const plan = approvePlan(ctxOf(c), ref, note);
		announce(c, "plan.approved", ref);
		return c.json(plan);
	});
	api.post("/issues/:ref/plan/reject", async (c) => {
		const ref = c.req.param("ref");
		const plan = rejectPlan(ctxOf(c), ref, parse(noteBody, await json(c)).note);
		announce(c, "plan.rejected", ref);
		return c.json(plan);
	});
	const finish = async (c: C, type: string) => {
		const ref = c.req.param("ref") ?? "";
		completeIssue(ctxOf(c), ref, parse(completeBody, await json(c, true)));
		announce(c, type, ref);
		return c.body(null, 204);
	};
	api.post("/issues/:ref/report/accept", (c) => finish(c, "report.accepted"));
	api.post("/issues/:ref/complete", (c) => finish(c, "issue.completed"));
	api.post("/issues/:ref/report/return", async (c) => {
		const ref = c.req.param("ref");
		returnReport(ctxOf(c), ref, parse(noteBody, await json(c)).note);
		announce(c, "report.returned", ref);
		return c.body(null, 204);
	});
	api.put("/issues/:ref/criteria", async (c) => {
		const ref = c.req.param("ref");
		const r = updateCriteria(ctxOf(c), ref, await json(c));
		announce(c, "criteria.updated", ref);
		return c.json(r);
	});
	api.post("/questions/:id/answer", async (c) => {
		const q = answerQuestion(
			ctxOf(c),
			c.req.param("id"),
			parse(answerBody, await json(c)).answerMd,
		);
		const l = loadIssueById(ctxOf(c), q.issueId);
		events.publish("question.answered", l.project.id, l.ref);
		return c.json(q);
	});

	// --- SSE ---
	api.get("/events", (c) =>
		streamSSE(c, async (stream) => {
			const off = events.subscribe(ctxOf(c), (e) => {
				stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
			});
			stream.onAbort(off);
			await stream.writeSSE({ event: "ready", data: "{}" });
			while (!stream.aborted) {
				await stream.sleep(25_000);
				await stream.writeSSE({ event: "ping", data: "" });
			}
		}),
	);

	app.route("/api/v1", api);
	return app;
}
