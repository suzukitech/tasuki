import { mkdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	type Actor,
	acceptInvite,
	addAttachment,
	addComment,
	addMember,
	answerQuestion,
	approvePlan,
	bulkUpdate,
	type Ctx,
	changeMemberRole,
	completeIssue,
	createApiToken,
	createInvite,
	createIssue,
	createProject,
	createTemplate,
	createWebhook,
	deleteIssue,
	deleteTemplate,
	deleteWebhook,
	destroySession,
	etagOf,
	fail,
	getAttachment,
	getIssue,
	getMe,
	listActivities,
	listApiTokens,
	listComments,
	listNotifications,
	listProjects,
	listTemplates,
	listWebhooks,
	login,
	markNotificationsRead,
	moveIssue,
	needsSetup,
	pageIssues,
	parse,
	parseEtag,
	projectDetail,
	rejectPlan,
	removeMember,
	renameStatus,
	requireAttach,
	resolveSession,
	resolveToken,
	returnReport,
	revokeApiToken,
	setupFirstAdmin,
	sha256,
	sniffImage,
	TasukiError,
	updateCriteria,
	updateIssue,
	updateProject,
	updateTemplate,
	webhookForTest,
} from "@tasuki/core";
import type { Db } from "@tasuki/db";
import { createMcpServer } from "@tasuki/mcp";
import {
	answerInput,
	commentInput,
	completeInput,
	inviteAcceptInput,
	listQuery,
	loginInput,
	moveInput,
	noteBody,
	optNoteBody,
} from "@tasuki/schema";
import { ATTACHMENT_MAX, ATTACHMENT_TYPES } from "@tasuki/schema/pure";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { createEvents } from "./events";
import { createWebhooks } from "./webhooks";

type Cred = { kind: "session" | "token"; hash: string };
type Env = {
	Variables: { ctx: Ctx; session?: string; cred: Cred; ip: string };
	Bindings: { ip?: string };
};
type C = Context<Env>;

const SESSION = "tasuki_session";
const CSRF = "tasuki_csrf";
const MONTH = 30 * 86_400;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC = new Set([
	"/api/v1/setup/status",
	"/api/v1/setup",
	"/api/v1/auth/login",
	"/api/v1/invites/accept",
]);

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	409: "Conflict",
	412: "Precondition Failed",
	415: "Unsupported Media Type",
	413: "Content Too Large",
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
const csrfOf = (session: string) => sha256(`csrf:${session}`);

/**
 * Fixed-window counter per key.
 * ponytail: in-memory, single process; a multi-instance deploy needs a shared store.
 */
function rateLimiter(windowMs = 60_000) {
	const hits = new Map<string, { n: number; reset: number }>();
	setInterval(() => {
		const now = Date.now();
		for (const [k, e] of hits) if (e.reset <= now) hits.delete(k);
	}, 60_000).unref();
	const live = (k: string) => {
		const e = hits.get(k);
		return e && e.reset > Date.now() ? e : undefined;
	};
	const hit = (k: string) => {
		const e = live(k);
		if (e) e.n++;
		else hits.set(k, { n: 1, reset: Date.now() + windowMs });
	};
	return {
		blocked: (k: string, max: number) => (live(k)?.n ?? 0) >= max,
		hit,
		/** Count one attempt now; false when the key was already at `max` (still counted). */
		take(k: string, max: number) {
			const over = (live(k)?.n ?? 0) >= max;
			hit(k);
			return !over;
		},
		refund(k: string) {
			const e = live(k);
			if (e && --e.n <= 0) hits.delete(k);
		},
	};
}

const MAX_BODY = 1_000_000;
/** The one route whose body may exceed MAX_BODY and need not be JSON (an image's bytes). */
const ATTACH = /^\/api\/v1\/issues\/[^/]+\/attachments$/;
const IMAGE_CT = new Set<string>(ATTACHMENT_TYPES);
const ctOf = (c: C) =>
	(c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ??
	"";
const bearerOf = (c: C) =>
	/^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];

const JSON_CT = /^application\/json\s*(;\s*charset=\S+)?$/i;

const json = (c: C): Promise<unknown> =>
	c.req.json().catch(() => fail("invalid", "request body must be JSON"));
/** Only an empty body is `{}`; anything else must parse. */
const jsonOrEmpty = async (c: C): Promise<unknown> => {
	const t = await c.req.text();
	if (!t.trim()) return {};
	try {
		return JSON.parse(t);
	} catch {
		return fail("invalid", "request body must be JSON");
	}
};

const safeDecode = (p: string) => {
	try {
		return decodeURIComponent(p);
	} catch {
		return "/";
	}
};

export function createApp(
	db: Db,
	opts: {
		baseUrl: string;
		rateLimit?: number;
		trustProxy?: boolean;
		/** Built SPA (apps/web/dist). Absent or missing on disk: nothing is served. */
		webDir?: string;
		/** Attachments live in `<dataDir>/attachments/`. */
		dataDir?: string;
		webhook?: Omit<Parameters<typeof createWebhooks>[1], "baseUrl">;
	},
) {
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const secure = baseUrl.startsWith("https:");
	const ipMax = opts.rateLimit ?? 10;
	const acctMax = ipMax * 2;
	const limiter = rateLimiter();
	const origin = new URL(baseUrl).origin;
	const events = createEvents();
	const hooks = createWebhooks(db, { baseUrl, ...opts.webhook });
	const dataDir = resolve(opts.dataDir ?? "./tasuki-data");
	/** After commit: stream to subscribers, then notify webhooks (async, never blocks). */
	const emit = (e: Parameters<typeof events.publish>[0]) => {
		events.publish(e);
		hooks.dispatch(e);
	};
	const app = new Hono<Env>();
	const api = new Hono<Env>();

	// X-Forwarded-For is client-controlled: only the proxy-appended (last) entry is
	// believable, and only when the operator says a proxy is in front.
	const ipOf = (c: C) =>
		(opts.trustProxy
			? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim()
			: undefined) ||
		c.env?.ip ||
		"local";
	const tooMany = () => new TasukiError("rate_limited", "too many attempts");
	const setCookies = (c: C, session: string) => {
		const base = { sameSite: "Lax", secure, path: "/", maxAge: MONTH } as const;
		setCookie(c, SESSION, session, { ...base, httpOnly: true });
		setCookie(c, CSRF, csrfOf(session), { ...base, httpOnly: false });
	};
	/** Resolve a Bearer token with the shared bad-token rate limit. `via` is the default. */
	const bearerActor = (c: C, token: string, via: string) => {
		const ip = c.get("ip");
		if (limiter.blocked(ip, ipMax)) throw tooMany();
		const name = (c.req.header("x-tasuki-client") ?? "")
			.replace(/[^\w.-]/g, "")
			.slice(0, 40);
		const actor = resolveToken(db, token, name ? `mcp:${name}` : via);
		if (!actor) limiter.hit(ip);
		else c.set("cred", { kind: "token", hash: sha256(token) });
		return actor;
	};
	const ctxOf = (c: C) => c.get("ctx");

	/** `:ref` + JSON body → core. 204 when core returns nothing. */
	const act =
		(
			fn: (ctx: Ctx, ref: string, body: unknown) => unknown,
			o: { status?: 201; emptyBody?: true } = {},
		) =>
		async (c: C) => {
			const r = fn(
				ctxOf(c),
				c.req.param("ref") ?? "",
				await (o.emptyBody ? jsonOrEmpty(c) : json(c)),
			);
			return r === undefined ? c.body(null, 204) : c.json(r, o.status ?? 200);
		};

	app.onError((e) => {
		if (e instanceof TasukiError) return problem(e.status, e.code, e.message);
		console.error(e);
		return problem(500, "internal", "internal server error");
	});
	app.notFound(() => problem(404, "not_found", "no such route"));
	app.get("/health", (c) => c.json({ ok: true }));

	api.use("*", async (c, next) => {
		const ip = ipOf(c);
		c.set("ip", ip);
		const isPublic = PUBLIC.has(c.req.path);
		if (!SAFE.has(c.req.method)) {
			const post = c.req.method === "POST";
			if (
				(c.req.raw.body !== null || (isPublic && post)) &&
				!JSON_CT.test(c.req.header("content-type") ?? "") &&
				// image uploads: a cross-site form cannot send image/* (and fetch needs a
				// preflight), and the CSRF header below is still required
				!(post && ATTACH.test(c.req.path) && IMAGE_CT.has(ctOf(c)))
			)
				throw new TasukiError(
					"unsupported_media",
					"Content-Type must be application/json",
				);
			const o = c.req.header("origin");
			if (isPublic && post && o !== undefined && o !== origin)
				throw new TasukiError("csrf", "cross-origin request refused");
		}
		if (isPublic) return next();
		const token = bearerOf(c);
		let actor: Actor | null = null;
		if (token) {
			actor = bearerActor(c, token, "cli");
		} else {
			const session = getCookie(c, SESSION);
			actor = session ? resolveSession(db, session) : null;
			if (session && actor) {
				c.set("session", session);
				c.set("cred", { kind: "session", hash: sha256(session) });
				if (
					!SAFE.has(c.req.method) &&
					c.req.header("x-tasuki-csrf") !== csrfOf(session)
				)
					throw new TasukiError("csrf", "missing or invalid X-Tasuki-CSRF");
			}
		}
		if (!actor)
			throw new TasukiError("unauthorized", "authentication required");
		c.set("ctx", { db, actor, emit });
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
		const b = loginInput.safeParse(await json(c));
		// Count the attempt BEFORE the (slow) password check so a parallel burst cannot
		// slip past the limit; refund on success. Per account too, so rotating IPs
		// cannot brute-force one email.
		const keys: [string, number][] = [[c.get("ip"), ipMax]];
		if (b.success)
			keys.push([`acct:${b.data.email.trim().toLowerCase()}`, acctMax]);
		const ok = keys.map(([k, max]) => limiter.take(k, max)).every(Boolean);
		if (!ok) throw tooMany();
		const r = b.success ? await login(db, b.data.email, b.data.password) : null;
		if (!r) throw new TasukiError("unauthorized", "invalid email or password");
		for (const [k] of keys) limiter.refund(k);
		setCookies(c, r.session);
		return c.json(r.user);
	});
	api.post("/auth/logout", (c) => {
		const s = c.get("session");
		if (s) {
			destroySession(db, s);
			events.drop(c.get("cred").hash);
		}
		deleteCookie(c, SESSION, { path: "/" });
		deleteCookie(c, CSRF, { path: "/" });
		return c.body(null, 204);
	});
	api.post("/invites", (c) => {
		const r = createInvite(ctxOf(c));
		return c.json({ ...r, url: `${baseUrl}/invite/${r.token}` }, 201);
	});
	api.post("/invites/accept", async (c) => {
		const { token, ...rest } = parse(inviteAcceptInput, await json(c));
		const u = await acceptInvite(db, token, rest);
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
		const r = createApiToken(ctxOf(c), await json(c));
		return c.json(
			{
				...r,
				claudeMcpAdd: `claude mcp add --transport http tasuki ${baseUrl}/mcp --header "Authorization: Bearer ${r.token}" --header "X-Tasuki-Client: claude-code"`,
			},
			201,
		);
	});
	api.delete("/me/tokens/:id", (c) => {
		events.drop(revokeApiToken(ctxOf(c), c.req.param("id")));
		return c.body(null, 204);
	});

	// --- notifications (own data) ---
	api.get("/me/notifications", (c) => {
		const n = Number(c.req.query("limit"));
		return c.json(
			listNotifications(ctxOf(c), Number.isInteger(n) && n > 0 ? n : 30),
		);
	});
	api.post("/me/notifications/read", async (c) => {
		markNotificationsRead(ctxOf(c), await json(c));
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
	api.post("/projects/:key/members", async (c) =>
		c.json(addMember(ctxOf(c), c.req.param("key"), await json(c)), 201),
	);
	api.patch("/projects/:key/members/:userId", async (c) =>
		c.json(
			changeMemberRole(
				ctxOf(c),
				c.req.param("key"),
				c.req.param("userId"),
				await json(c),
			),
		),
	);
	api.delete("/projects/:key/members/:userId", (c) => {
		removeMember(ctxOf(c), c.req.param("key"), c.req.param("userId"));
		return c.body(null, 204);
	});
	api.patch("/projects/:key/statuses/:id", async (c) =>
		c.json(
			renameStatus(
				ctxOf(c),
				c.req.param("key"),
				c.req.param("id"),
				await json(c),
			),
		),
	);
	api.get("/projects/:key/webhooks", (c) =>
		c.json(listWebhooks(ctxOf(c), c.req.param("key"))),
	);
	api.post("/projects/:key/webhooks", async (c) =>
		c.json(createWebhook(ctxOf(c), c.req.param("key"), await json(c)), 201),
	);
	api.delete("/projects/:key/webhooks/:id", (c) => {
		deleteWebhook(ctxOf(c), c.req.param("key"), c.req.param("id"));
		return c.body(null, 204);
	});
	api.post("/projects/:key/webhooks/:id/test", async (c) => {
		const w = webhookForTest(ctxOf(c), c.req.param("key"), c.req.param("id"));
		return c.json(await hooks.test(w.url));
	});
	api.get("/projects/:key/templates", (c) =>
		c.json(listTemplates(ctxOf(c), c.req.param("key"))),
	);
	api.post("/projects/:key/templates", async (c) =>
		c.json(createTemplate(ctxOf(c), c.req.param("key"), await json(c)), 201),
	);
	api.patch("/projects/:key/templates/:id", async (c) =>
		c.json(
			updateTemplate(
				ctxOf(c),
				c.req.param("key"),
				c.req.param("id"),
				await json(c),
			),
		),
	);
	api.delete("/projects/:key/templates/:id", (c) => {
		deleteTemplate(ctxOf(c), c.req.param("key"), c.req.param("id"));
		return c.body(null, 204);
	});
	api.get("/projects/:key/issues", (c) => {
		const q = parse(listQuery, c.req.query());
		return c.json(pageIssues(ctxOf(c), c.req.param("key"), q.q, q));
	});
	api.post("/projects/:key/issues", async (c) =>
		c.json(createIssue(ctxOf(c), c.req.param("key"), await json(c)), 201),
	);

	// --- issues ---
	api.post("/issues/bulk", async (c) =>
		c.json({ refs: bulkUpdate(ctxOf(c), await json(c)) }),
	);
	api.get("/issues/:ref", (c) => {
		const r = getIssue(ctxOf(c), c.req.param("ref"));
		c.header("ETag", etagOf(r.issue));
		return c.json(r);
	});
	api.patch("/issues/:ref", async (c) => {
		const i = updateIssue(ctxOf(c), c.req.param("ref"), await json(c), {
			ifMatch: parseEtag(c.req.header("if-match")),
		});
		c.header("ETag", etagOf(i));
		return c.json(i);
	});
	api.delete("/issues/:ref", (c) => {
		for (const p of deleteIssue(ctxOf(c), c.req.param("ref")))
			void unlink(join(dataDir, p)).catch(() => {});
		return c.body(null, 204);
	});
	api.post("/issues/:ref/attachments", async (c) => {
		const ref = c.req.param("ref");
		const ctx = ctxOf(c);
		requireAttach(ctx, ref); // permission before a single body byte is read
		const len = Number(c.req.header("content-length") ?? 0);
		if (len > ATTACHMENT_MAX)
			throw new TasukiError("too_large", "image over 10 MB");
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = c.req.raw.body?.getReader();
		for (;;) {
			const r = await reader?.read();
			if (!r || r.done) break;
			size += r.value.byteLength;
			if (size > ATTACHMENT_MAX) {
				void reader?.cancel();
				throw new TasukiError("too_large", "image over 10 MB");
			}
			chunks.push(r.value);
		}
		if (!size) throw new TasukiError("invalid", "empty body");
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const ch of chunks) {
			bytes.set(ch, at);
			at += ch.byteLength;
		}
		const contentType = sniffImage(bytes);
		if (!contentType)
			throw new TasukiError(
				"unsupported_media",
				"only png, jpeg, gif and webp images are accepted",
			);
		const id = Bun.randomUUIDv7();
		const path = join("attachments", id);
		await mkdir(join(dataDir, "attachments"), { recursive: true });
		await Bun.write(join(dataDir, path), bytes);
		try {
			const row = addAttachment(ctx, ref, {
				id,
				filename: c.req.query("filename") ?? "",
				size,
				contentType,
				path,
			});
			return c.json(
				{
					id: row.id,
					filename: row.filename,
					size: row.size,
					contentType: row.contentType,
					url: `/api/v1/attachments/${row.id}`,
				},
				201,
			);
		} catch (e) {
			await unlink(join(dataDir, path)).catch(() => {});
			throw e;
		}
	});
	api.post(
		"/issues/:ref/move",
		act((x, ref, b) => moveIssue(x, ref, parse(moveInput, b))),
	);
	api.get("/issues/:ref/comments", (c) =>
		c.json(listComments(ctxOf(c), c.req.param("ref"))),
	);
	api.post(
		"/issues/:ref/comments",
		act((x, ref, b) => addComment(x, ref, parse(commentInput, b).bodyMd), {
			status: 201,
		}),
	);
	api.get("/issues/:ref/activities", (c) =>
		c.json(listActivities(ctxOf(c), c.req.param("ref"))),
	);

	// --- workflow (human gates: core rejects token actors) ---
	api.post(
		"/issues/:ref/plan/approve",
		act((x, ref, b) => approvePlan(x, ref, parse(optNoteBody, b).note), {
			emptyBody: true,
		}),
	);
	api.post(
		"/issues/:ref/plan/reject",
		act((x, ref, b) => rejectPlan(x, ref, parse(noteBody, b).note)),
	);
	api.post(
		"/issues/:ref/complete",
		act((x, ref, b) => completeIssue(x, ref, parse(completeInput, b)), {
			emptyBody: true,
		}),
	);
	api.post(
		"/issues/:ref/report/return",
		act((x, ref, b) => returnReport(x, ref, parse(noteBody, b).note)),
	);
	api.put(
		"/issues/:ref/criteria",
		act((x, ref, b) => updateCriteria(x, ref, b)),
	);
	api.post("/questions/:id/answer", async (c) =>
		c.json(
			answerQuestion(
				ctxOf(c),
				c.req.param("id"),
				parse(answerInput, await json(c)).answerMd,
			),
		),
	);

	api.get("/attachments/:id", async (c) => {
		const a = getAttachment(ctxOf(c), c.req.param("id"));
		const file = Bun.file(join(dataDir, a.path));
		if (!(await file.exists()))
			throw new TasukiError("not_found", "attachment file is missing");
		// attr-char (RFC 8187) leaves ' ( ) * alone; encode them too
		const name = encodeURIComponent(a.filename).replace(
			/['()*]/g,
			(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		return new Response(file, {
			headers: {
				"content-type": a.contentType,
				"content-length": String(a.size),
				"x-content-type-options": "nosniff",
				"content-disposition": `inline; filename*=UTF-8''${name}`,
				"cache-control": "private",
				"content-security-policy": "default-src 'none'",
			},
		});
	});

	// --- SSE ---
	api.get("/events", (c) => {
		let stream: SSEStreamingApi | undefined;
		let closed = false;
		let wake = () => {};
		const sub = events.subscribe(
			ctxOf(c),
			c.get("cred"),
			// returns the write promise so a failed write removes the subscriber
			(e) => stream?.writeSSE({ event: e.type, data: JSON.stringify(e) }),
			() => {
				closed = true;
				stream?.abort();
				wake();
			},
		);
		if (!sub)
			throw new TasukiError("rate_limited", "too many open event streams");
		return streamSSE(c, async (s) => {
			stream = s;
			s.onAbort(() => {
				sub.off();
				wake();
			});
			await s.writeSSE({ event: "ready", data: "{}" });
			while (!s.aborted && !closed) {
				await new Promise<void>((done) => {
					const t = setTimeout(done, 25_000);
					wake = () => {
						clearTimeout(t);
						done();
					};
				});
				if (s.aborted || closed || !sub.ok()) break;
				await s.writeSSE({ event: "ping", data: "" });
			}
		});
	});

	// --- MCP (Streamable HTTP, stateless: a fresh server + transport per request) ---
	// Auth first (so a bad token is limited before any body is read), then the size cap.
	app.use("/mcp", async (c, next) => {
		c.set("ip", ipOf(c));
		const token = bearerOf(c);
		// bearer only: a cookie session must never reach MCP (CSRF-able, and not an AI client)
		if (!token) throw new TasukiError("unauthorized", "Bearer token required");
		const actor = bearerActor(c, token, "mcp:mcp");
		if (!actor)
			throw new TasukiError("unauthorized", "authentication required");
		c.set("ctx", { db, actor, emit });
		return next();
	});
	const limit = bodyLimit({
		maxSize: MAX_BODY,
		onError: () => problem(413, "too_large", "request body too large"),
	});
	app.use("*", (c, next) =>
		ATTACH.test(c.req.path) ? next() : limit(c, next),
	);
	app.all("/mcp", async (c) => {
		if (c.req.method !== "POST")
			return c.json(
				{
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Method not allowed (stateless server: POST only)",
					},
					id: null,
				},
				405,
				{ allow: "POST" },
			);
		let body: unknown;
		try {
			body = JSON.parse(await c.req.text());
		} catch {
			body = undefined; // the transport answers with a JSON-RPC parse error
		}
		const server = createMcpServer(ctxOf(c), { baseUrl });
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		await server.connect(transport);
		try {
			return await transport.handleRequest(c.req.raw, { parsedBody: body });
		} finally {
			await server.close();
		}
	});

	app.route("/api/v1", api);

	// --- SPA: static files, and index.html for every other non-API GET (client-side routes) ---
	const webDir = opts.webDir && resolve(opts.webDir);
	if (webDir)
		app.get("*", async (c) => {
			const p = c.req.path;
			if (p === "/api" || p.startsWith("/api/") || p.startsWith("/mcp"))
				return c.notFound();
			const file = resolve(webDir, `.${safeDecode(p)}`);
			const hit = file.startsWith(webDir + sep) && Bun.file(file);
			if (hit && (await hit.exists()))
				return new Response(hit, {
					headers: p.startsWith("/assets/")
						? { "cache-control": "public, max-age=31536000, immutable" }
						: {},
				});
			// a missing asset or a path with a file extension is a real 404, not a client route
			if (p.startsWith("/assets/") || /\.[^/]+$/.test(p)) return c.notFound();
			const index = Bun.file(resolve(webDir, "index.html"));
			return (await index.exists())
				? new Response(index, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"cache-control": "no-cache",
							// belt and braces for the markdown renderer: no image from another origin
							"content-security-policy": "img-src 'self' data:",
						},
					})
				: c.notFound();
		});
	return app;
}
