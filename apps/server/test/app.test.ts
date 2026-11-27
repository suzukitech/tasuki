import { describe, expect, test } from "bun:test";
import { harness } from "./harness";

const key = (name: string) => ({ key: name, name });

describe("auth & errors", () => {
	test("401 without auth, public routes open, problem+json shape", async () => {
		const h = harness();
		const r = await h.call("GET", "/projects");
		expect(r.status).toBe(401);
		expect(r.headers.get("content-type")).toContain("application/problem+json");
		expect(await r.json()).toMatchObject({
			type: "urn:tasuki:problem:unauthorized",
			title: "Unauthorized",
			status: 401,
			code: "unauthorized",
			detail: expect.any(String),
		});
		expect((await h.app.request("/health")).status).toBe(200);
		expect((await h.app.request("/nope")).status).toBe(404);
		const bad = await h.call("POST", "/setup", { body: { email: "x" } });
		expect(bad.status).toBe(400);
		expect((await bad.json()).code).toBe("invalid");
		const notJson = await h.app.request("/api/v1/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(notJson.status).toBe(400);
	});

	test("setup works once", async () => {
		const h = harness();
		expect(await (await h.call("GET", "/setup/status")).json()).toEqual({
			needsSetup: true,
		});
		const body = { email: "a@example.com", name: "A", password: "password123" };
		const ok = await h.call("POST", "/setup", { body });
		expect(ok.status).toBe(201);
		expect(await ok.json()).not.toHaveProperty("passwordHash");
		expect((await h.call("POST", "/setup", { body })).status).toBe(409);
		expect(await (await h.call("GET", "/setup/status")).json()).toEqual({
			needsSetup: false,
		});
	});

	test("login sets cookies; Secure only on https; logout ends the session", async () => {
		for (const [baseUrl, secure] of [
			["http://localhost:3000", false],
			["https://t.example.com", true],
		] as const) {
			const h = harness({ baseUrl });
			const a = await h.setup();
			const set = a.res.headers.getSetCookie();
			const s = set.find((c) => c.startsWith("tasuki_session="));
			const c = set.find((c) => c.startsWith("tasuki_csrf="));
			expect(s).toContain("HttpOnly");
			expect(s).toContain("SameSite=Lax");
			expect(s).toContain("Path=/");
			expect(s?.includes("Secure")).toBe(secure);
			expect(c).not.toContain("HttpOnly");
			expect((await a.req("GET", "/me")).status).toBe(200);
			expect((await a.req("POST", "/auth/logout")).status).toBe(204);
			expect((await a.req("GET", "/me")).status).toBe(401);
		}
	});

	test("wrong password is 401", async () => {
		const h = harness();
		await h.setup();
		const r = await h.signIn("admin@example.com", "wrongwrong");
		expect(r.res.status).toBe(401);
	});

	test("CSRF is required for cookie writes, not for Bearer", async () => {
		const h = harness();
		const a = await h.setup();
		const noCsrf = await h.call("POST", "/projects", {
			body: key("WEB"),
			cookie: a.cookie,
		});
		expect(noCsrf.status).toBe(403);
		expect((await noCsrf.json()).code).toBe("csrf");
		const bad = await h.call("POST", "/projects", {
			body: key("WEB"),
			cookie: a.cookie,
			csrf: "nope",
		});
		expect(bad.status).toBe(403);
		expect((await a.req("POST", "/projects", key("WEB"))).status).toBe(201);
		// GET needs no CSRF
		expect(
			(await h.call("GET", "/projects", { cookie: a.cookie })).status,
		).toBe(200);
		const t = await (
			await a.req("POST", "/me/tokens", {
				name: "cli",
				scopes: ["read", "write"],
			})
		).json();
		const viaToken = await h.call("POST", "/projects", {
			body: key("API"),
			bearer: t.token,
		});
		expect(viaToken.status).toBe(201);
	});

	test("rate limits repeated login and bad-token failures", async () => {
		const h = harness({ rateLimit: 3, trustProxy: true });
		await h.setup();
		for (let i = 0; i < 3; i++)
			expect(
				(await h.signIn("admin@example.com", "badbadbad")).res.status,
			).toBe(401);
		const blocked = await h.signIn("admin@example.com", "badbadbad");
		expect(blocked.res.status).toBe(429);
		expect(blocked.res.headers.get("retry-after")).toBe("60");
		expect((await blocked.res.json()).code).toBe("rate_limited");
		// another IP is unaffected; bad tokens are counted per IP too
		const other = { "x-forwarded-for": "9.9.9.9" };
		for (let i = 0; i < 3; i++)
			expect(
				(await h.call("GET", "/me", { bearer: "tsk_bad", headers: other }))
					.status,
			).toBe(401);
		expect(
			(await h.call("GET", "/me", { bearer: "tsk_bad", headers: other }))
				.status,
		).toBe(429);
	});
});

describe("rate limit: client address", () => {
	const login = (h: ReturnType<typeof harness>, email: string, ip: string) =>
		h.call("POST", "/auth/login", {
			body: { email, password: "badbadbad" },
			headers: { "x-forwarded-for": ip },
		});

	test("a spoofed X-Forwarded-For does not bypass the limit when proxy trust is off", async () => {
		const h = harness({ rateLimit: 3 });
		for (let i = 0; i < 3; i++)
			expect((await login(h, `u${i}@example.com`, `1.1.1.${i}`)).status).toBe(
				401,
			);
		expect((await login(h, "u9@example.com", "8.8.8.8")).status).toBe(429);
	});

	test("with proxy trust the last XFF entry is the client; failures also count per account", async () => {
		const h = harness({ rateLimit: 3, trustProxy: true });
		// client-supplied first hop is ignored, the proxy-appended last one counts
		for (let i = 0; i < 3; i++)
			expect(
				(await login(h, `u${i}@example.com`, `6.6.6.${i}, 7.7.7.7`)).status,
			).toBe(401);
		expect((await login(h, "x@example.com", "5.5.5.5, 7.7.7.7")).status).toBe(
			429,
		);
		// rotating IPs against one account is stopped by the per-email counter
		for (let i = 0; i < 6; i++)
			expect((await login(h, "Victim@Example.com", `2.2.2.${i}`)).status).toBe(
				401,
			);
		expect((await login(h, "victim@example.com", "2.2.2.99")).status).toBe(429);
		expect((await login(h, "other@example.com", "2.2.2.99")).status).toBe(401);
	});
});

describe("tokens", () => {
	test("issuance returns plaintext + claudeMcpAdd once; list/revoke", async () => {
		const h = harness();
		const a = await h.setup();
		const r = await a.req("POST", "/me/tokens", {
			name: "ai",
			scopes: ["read"],
		});
		expect(r.status).toBe(201);
		const t = await r.json();
		expect(t.token).toStartWith("tsk_");
		expect(t.claudeMcpAdd).toBe(
			`claude mcp add --transport http tasuki http://localhost:3000/mcp --header "Authorization: Bearer ${t.token}" --header "X-Tasuki-Client: claude-code"`,
		);
		const listed = await (await a.req("GET", "/me/tokens")).text();
		expect(listed).toContain("ai");
		expect(listed).not.toContain(t.token);
		expect(listed).not.toContain("tokenHash");
		// the token works and identifies as cli / mcp:<client>
		const me = await (await h.call("GET", "/me", { bearer: t.token })).json();
		expect(me).toMatchObject({ auth: "token", via: "cli" });
		const mcp = await (
			await h.call("GET", "/me", {
				bearer: t.token,
				headers: { "x-tasuki-client": "claude code!" },
			})
		).json();
		expect(mcp.via).toBe("mcp:claudecode");
		// tokens cannot mint tokens
		expect(
			(
				await h.call("POST", "/me/tokens", {
					bearer: t.token,
					body: { name: "x", scopes: ["read"] },
				})
			).status,
		).toBe(409);
		expect((await a.req("DELETE", `/me/tokens/${t.id}`)).status).toBe(204);
		expect((await a.req("DELETE", `/me/tokens/${t.id}`)).status).toBe(404);
		expect((await h.call("GET", "/me", { bearer: t.token })).status).toBe(401);
	});
});

describe("projects & issues", () => {
	async function world() {
		const h = harness();
		const a = await h.setup();
		await a.req("POST", "/projects", key("WEB"));
		const make = async (title: string, extra = {}) =>
			(await (
				await a.req("POST", "/projects/WEB/issues", { title, ...extra })
			).json()) as {
				ref: string;
				id: string;
				updatedAt: string;
			};
		return { h, a, make };
	}

	test("projects list/get/patch", async () => {
		const { a, h } = await world();
		const mine = (await (await a.req("GET", "/projects")).json()) as {
			key: string;
			role: string;
		}[];
		// the first admin also has the sample project from setup
		expect(mine.map((x) => x.key).sort()).toEqual(["DEMO", "WEB"]);
		expect(mine.find((x) => x.key === "WEB")?.role).toBe("manager");
		const d = await (await a.req("GET", "/projects/web")).json();
		expect(d.statuses.length).toBeGreaterThan(0);
		const p = await (
			await a.req("PATCH", "/projects/WEB", { name: "Website" })
		).json();
		expect(p.name).toBe("Website");
		expect((await a.req("PATCH", "/projects/WEB", {})).status).toBe(200);
		expect((await a.req("GET", "/projects/NOPE")).status).toBe(404);
		const u = await h.addUser(a, "bob");
		expect((await u.req("GET", "/projects")).status).toBe(200);
		expect(await (await u.req("GET", "/projects")).json()).toEqual([]);
	});

	test("ETag + If-Match: 412 on stale, ok on fresh", async () => {
		const { a, make } = await world();
		const i = await make("one");
		const g = await a.req("GET", `/issues/${i.ref}`);
		const tag = g.headers.get("etag") as string;
		expect(tag).toMatch(/^"\d+"$/);
		await new Promise((r) => setTimeout(r, 5));
		const ok = await a.req(
			"PATCH",
			`/issues/${i.ref}`,
			{ title: "two" },
			{ "if-match": tag },
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("etag")).not.toBe(tag);
		const stale = await a.req(
			"PATCH",
			`/issues/${i.ref}`,
			{ title: "three" },
			{ "if-match": tag },
		);
		expect(stale.status).toBe(412);
		expect((await stale.json()).code).toBe("precondition");
		const junk = await a.req(
			"PATCH",
			`/issues/${i.ref}`,
			{ title: "x" },
			{ "if-match": "abc" },
		);
		expect(junk.status).toBe(400);
		const noHeader = await a.req("PATCH", `/issues/${i.ref}`, {
			title: "four",
		});
		expect(noHeader.status).toBe(200);
	});

	test("cursor paging newest first, filter, comments, activities, delete", async () => {
		const { a, make } = await world();
		for (let n = 1; n <= 5; n++) await make(n % 2 ? `odd ${n}` : `even ${n}`);
		const p1 = await (
			await a.req("GET", "/projects/WEB/issues?limit=2")
		).json();
		expect(p1.items.map((i: { ref: string }) => i.ref)).toEqual([
			"WEB-5",
			"WEB-4",
		]);
		expect(p1.nextCursor).toBe(4);
		const p2 = await (
			await a.req("GET", `/projects/WEB/issues?limit=2&cursor=${p1.nextCursor}`)
		).json();
		expect(p2.items.map((i: { ref: string }) => i.ref)).toEqual([
			"WEB-3",
			"WEB-2",
		]);
		const p3 = await (
			await a.req("GET", `/projects/WEB/issues?limit=2&cursor=${p2.nextCursor}`)
		).json();
		expect(p3).toMatchObject({ nextCursor: null });
		expect(p3.items).toHaveLength(1);
		const f = await (await a.req("GET", "/projects/WEB/issues?q=odd")).json();
		expect(f.items).toHaveLength(3);
		expect((await a.req("GET", "/projects/WEB/issues?limit=abc")).status).toBe(
			400,
		);

		const c = await a.req("POST", "/issues/WEB-1/comments", { bodyMd: "hi" });
		expect(c.status).toBe(201);
		expect(
			await (await a.req("GET", "/issues/WEB-1/comments")).json(),
		).toHaveLength(1);
		const acts = await (await a.req("GET", "/issues/WEB-1/activities")).json();
		expect(acts.map((x: { action: string }) => x.action)).toEqual([
			"created",
			"commented",
		]);
		expect((await a.req("DELETE", "/issues/WEB-1")).status).toBe(204);
		expect((await a.req("GET", "/issues/WEB-1")).status).toBe(404);
	});

	test("move to a status", async () => {
		const { a, make } = await world();
		const i = await make("m", { flow: "simple" });
		const d = await (await a.req("GET", "/projects/WEB")).json();
		const doing = d.statuses.find(
			(s: { category: string }) => s.category === "in_progress",
		);
		expect(
			(await a.req("POST", `/issues/${i.ref}/move`, { statusId: doing.id }))
				.status,
		).toBe(204);
		const g = await (await a.req("GET", `/issues/${i.ref}`)).json();
		expect(g.category).toBe("in_progress");
	});

	test("bulk update is all-or-nothing", async () => {
		const { a, make } = await world();
		const x = await make("a");
		const y = await make("b");
		const ok = await a.req("POST", "/issues/bulk", {
			refs: [x.ref, y.ref],
			labels: ["bug"],
		});
		expect(ok.status).toBe(200);
		for (const r of [x.ref, y.ref])
			expect(
				(await (await a.req("GET", `/issues/${r}`)).json()).labels,
			).toEqual(["bug"]);
		const bad = await a.req("POST", "/issues/bulk", {
			refs: [x.ref, "WEB-999"],
			labels: ["other"],
		});
		expect(bad.status).toBe(404);
		expect(
			(await (await a.req("GET", `/issues/${x.ref}`)).json()).labels,
		).toEqual(["bug"]);
		expect((await a.req("POST", "/issues/bulk", { refs: [] })).status).toBe(
			400,
		);
	});
});

describe("human gates over REST", () => {
	test("token cannot approve a plan; session can; report flow", async () => {
		const h = harness();
		const a = await h.setup();
		await a.req("POST", "/projects", key("WEB"));
		const t = await (
			await a.req("POST", "/me/tokens", {
				name: "ai",
				scopes: ["read", "write"],
			})
		).json();
		const i = await (
			await a.req("POST", "/projects/WEB/issues", { title: "T" })
		).json();
		const d = await (await a.req("GET", "/projects/WEB")).json();
		const st = (c: string) =>
			d.statuses.find((s: { category: string }) => s.category === c).id;
		const bearer = t.token;
		expect(
			(
				await h.call("POST", `/issues/${i.ref}/move`, {
					bearer,
					body: { statusId: st("ready") },
				})
			).status,
		).toBe(204);

		// the AI submits a plan through core (MCP is a later phase)
		const { submitPlan } = await import("@tasuki/core");
		const me = await (await h.call("GET", "/me", { bearer })).json();
		submitPlan(
			{
				db: h.db,
				actor: {
					userId: me.id,
					via: "mcp:test",
					auth: "token",
					token: { scopes: ["read", "write"], projectIds: null },
				},
			},
			i.ref,
			{
				understandingMd: "u",
				stepsMd: "s",
				criteria: [{ text: "works" }],
				mapping: [{ index: 0, stepRef: "1" }],
			},
		);

		const viaToken = await h.call("POST", `/issues/${i.ref}/plan/approve`, {
			bearer,
			body: {},
		});
		expect(viaToken.status).toBe(409);
		expect((await viaToken.json()).code).toBe("gate");
		const reject = await a.req("POST", `/issues/${i.ref}/plan/reject`, {
			note: "more detail",
		});
		expect(reject.status).toBe(200);
		expect(
			(await a.req("POST", `/issues/${i.ref}/plan/reject`, {})).status,
		).toBe(400);
		expect(
			(
				await a.req("PUT", `/issues/${i.ref}/criteria`, [
					{ text: "works" },
					{ text: "tested" },
				])
			).status,
		).toBe(200);
		// an ai-flow issue cannot be completed from ready
		expect((await a.req("POST", `/issues/${i.ref}/complete`)).status).toBe(409);
		expect((await a.req("GET", `/issues/${i.ref}`)).status).toBe(200);
	});

	test("approve, return, accept and answer through the session", async () => {
		const h = harness();
		const a = await h.setup();
		await a.req("POST", "/projects", key("WEB"));
		const {
			submitPlan,
			askQuestion,
			submitReport,
			startImplementation,
			recordEvidence,
			getIssue,
		} = await import("@tasuki/core");
		const me = await (await a.req("GET", "/me")).json();
		const ai = {
			db: h.db,
			actor: {
				userId: me.id,
				via: "mcp:test",
				auth: "token" as const,
				token: {
					scopes: ["read" as const, "write" as const],
					projectIds: null,
				},
			},
		};
		const i = await (
			await a.req("POST", "/projects/WEB/issues", {
				title: "T",
				assigneeId: me.id,
			})
		).json();
		const d = await (await a.req("GET", "/projects/WEB")).json();
		const ready = d.statuses.find(
			(s: { category: string }) => s.category === "ready",
		).id;
		await a.req("POST", `/issues/${i.ref}/move`, { statusId: ready });
		const q = askQuestion(ai, i.ref, "which db?");
		expect(
			(
				await h.call("POST", `/questions/${q.id}/answer`, {
					bearer: undefined,
					body: { answerMd: "x" },
				})
			).status,
		).toBe(401);
		expect(
			(await a.req("POST", `/questions/${q.id}/answer`, { answerMd: "sqlite" }))
				.status,
		).toBe(200);
		submitPlan(ai, i.ref, {
			understandingMd: "u",
			stepsMd: "s",
			criteria: [{ text: "works" }],
			mapping: [{ index: 0, stepRef: "1" }],
		});
		expect(
			(await a.req("POST", `/issues/${i.ref}/plan/approve`, { note: "ok" }))
				.status,
		).toBe(200);
		startImplementation(ai, i.ref);
		const crit = getIssue(ai, i.ref).criteria[0]?.id as string;
		recordEvidence(ai, i.ref, crit, { result: "met", evidenceMd: "ran it" });
		submitReport(ai, i.ref, { summaryMd: "s", decisionsMd: "d" });
		expect(
			(await a.req("POST", `/issues/${i.ref}/report/return`, { note: "again" }))
				.status,
		).toBe(204);
		submitReport(ai, i.ref, { summaryMd: "s2", decisionsMd: "d" });
		expect((await a.req("POST", `/issues/${i.ref}/report/accept`)).status).toBe(
			404,
		);
		const acc = await a.req("POST", `/issues/${i.ref}/complete`);
		expect(acc.status).toBe(204);
		expect(
			(await (await a.req("GET", `/issues/${i.ref}`)).json()).category,
		).toBe("done");
	});

	test("invites are admin + session only", async () => {
		const h = harness();
		const a = await h.setup();
		const bob = await h.addUser(a, "bob");
		const r = await a.req("POST", "/invites");
		expect((await r.json()).url).toMatch(/^http:\/\/localhost:3000\/invite\//);
		expect((await bob.req("POST", "/invites")).status).toBe(403);
		expect(
			(
				await h.call("POST", "/invites/accept", {
					body: {
						token: "bad",
						email: "z@example.com",
						name: "z",
						password: "password123",
					},
				})
			).status,
		).toBe(400);
	});
});

describe("SSE", () => {
	async function reader(res: Response) {
		const rd = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
		const dec = new TextDecoder();
		let buf = "";
		return {
			/** Read until `pred(buffer)` holds or the timeout hits. */
			async until(pred: (b: string) => boolean, ms = 1500) {
				const end = Date.now() + ms;
				while (!pred(buf) && Date.now() < end) {
					const r = await Promise.race([
						rd.read(),
						new Promise<null>((ok) => setTimeout(() => ok(null), 100)),
					]);
					if (r?.value) buf += dec.decode(r.value);
				}
				return buf;
			},
			close: () => rd.cancel(),
			/** True once the server has ended the stream. */
			async ended(ms = 1500) {
				const end = Date.now() + ms;
				while (Date.now() < end) {
					const r = await Promise.race([
						rd.read(),
						new Promise<null>((ok) => setTimeout(() => ok(null), 100)),
					]);
					if (r?.done) return true;
				}
				return false;
			},
		};
	}

	test("subscriber gets events for readable projects only", async () => {
		const h = harness();
		const a = await h.setup();
		await a.req("POST", "/projects", key("WEB"));
		await a.req("POST", "/projects", key("SEC"));
		const bob = await h.addUser(a, "bob");
		await h.member(a, bob.id, "WEB");
		const web = await (
			await a.req("POST", "/projects/WEB/issues", { title: "w" })
		).json();
		const sec = await (
			await a.req("POST", "/projects/SEC/issues", { title: "s" })
		).json();

		const sse = await reader(await bob.req("GET", "/events"));
		await sse.until((b) => b.includes("event: ready"));
		// not visible to bob
		await a.req("PATCH", `/issues/${sec.ref}`, { title: "s2" });
		await a.req("PATCH", `/issues/${web.ref}`, { title: "w2" });
		const got = await sse.until((b) => b.includes("event: issue.updated"));
		await sse.close();
		expect(got).toContain('"ref":"WEB-1"');
		expect(got).toContain('"projectId"');
		expect(got).not.toContain("SEC-1");
	});

	test("logout and token revoke close that credential's stream at once", async () => {
		const h = harness();
		const a = await h.setup();
		await a.req("POST", "/projects", key("WEB"));
		const bob = await h.addUser(a, "bob");
		await h.member(a, bob.id, "WEB");
		const tok = await (
			await bob.req("POST", "/me/tokens", { name: "t", scopes: ["read"] })
		).json();
		const byToken = await reader(
			await h.call("GET", "/events", { bearer: tok.token }),
		);
		const bySession = await reader(await bob.req("GET", "/events"));
		await byToken.until((b) => b.includes("event: ready"));
		await bySession.until((b) => b.includes("event: ready"));

		await bob.req("DELETE", `/me/tokens/${tok.id}`);
		expect(await byToken.ended()).toBe(true);
		await bob.req("POST", "/auth/logout");
		expect(await bySession.ended()).toBe(true);
	});

	test("at most 5 streams per user, the 6th is a 429 problem", async () => {
		const h = harness();
		const a = await h.setup();
		const open = [];
		for (let i = 0; i < 5; i++) {
			const r = await a.req("GET", "/events");
			expect(r.status).toBe(200);
			open.push(await reader(r));
		}
		const sixth = await a.req("GET", "/events");
		expect(sixth.status).toBe(429);
		expect((await sixth.json()).code).toBe("rate_limited");
		for (const o of open) await o.close();
	});

	test("events endpoint needs auth", async () => {
		expect((await harness().call("GET", "/events")).status).toBe(401);
	});
});
