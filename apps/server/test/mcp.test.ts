import { describe, expect, test } from "bun:test";
import { harness } from "./harness";

const HDRS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};
let n = 0;
const rpc = (method: string, params?: unknown) =>
	JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params });

async function world(scopes: string[] = ["read", "write"]) {
	const h = harness();
	const a = await h.setup();
	const proj = await a.req("POST", "/projects", { key: "WEB", name: "Web" });
	expect(proj.status).toBe(201);
	const me = await (await a.req("GET", "/me")).json();
	const iss = await a.req("POST", "/projects/WEB/issues", {
		title: "Fix login",
		assigneeId: me.id,
		priority: 3,
	});
	expect(iss.status).toBe(201);
	const { token } = await (
		await a.req("POST", "/me/tokens", { name: "ai", scopes })
	).json();
	const mcp = (body: string, headers: Record<string, string> = {}) =>
		h.app.request("/mcp", {
			method: "POST",
			headers: { ...HDRS, authorization: `Bearer ${token}`, ...headers },
			body,
		});
	return { h, a, token, mcp };
}

describe("/mcp", () => {
	test("initialize + tools/list + tools/call over Streamable HTTP", async () => {
		const w = await world();
		const init = await w.mcp(
			rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "claude-code", version: "1" },
			}),
		);
		expect(init.status).toBe(200);
		expect((await init.json()).result.serverInfo.name).toBe("tasuki");

		const list = await (await w.mcp(rpc("tools/list"))).json();
		expect(list.result.tools.map((t: { name: string }) => t.name)).toContain(
			"next_task",
		);

		// move to ready via REST so next_task can find it
		const st = await (await w.a.req("GET", "/projects/WEB")).json();
		const ready = st.statuses.find(
			(s: { category: string }) => s.category === "ready",
		);
		await w.a.req("POST", "/issues/WEB-1/move", { statusId: ready.id });
		const call = await (
			await w.mcp(rpc("tools/call", { name: "next_task", arguments: {} }), {
				"x-tasuki-client": "my-client",
			})
		).json();
		expect(call.result.content[0].text).toContain("# WEB-1 Fix login");
	});

	test("via is mcp:<client> from X-Tasuki-Client, else mcp:mcp; writes are attributed", async () => {
		const w = await world();
		const say = (headers?: Record<string, string>) =>
			w.mcp(
				rpc("tools/call", {
					name: "comment",
					arguments: { ref: "WEB-1", bodyMd: "hi" },
				}),
				headers,
			);
		await say({ "x-tasuki-client": "my-client" });
		await say();
		const cs = await (await w.a.req("GET", "/issues/WEB-1/comments")).json();
		expect(cs.map((c: { via: string }) => c.via)).toEqual([
			"mcp:my-client",
			"mcp:mcp",
		]);
	});

	test("auth: cookie-only 401, bad token 401 + rate limit, GET/DELETE 405", async () => {
		const w = await world();
		const cookie = await w.h.app.request("/mcp", {
			method: "POST",
			headers: { ...HDRS, cookie: w.a.cookie, "x-tasuki-csrf": w.a.csrf },
			body: rpc("tools/list"),
		});
		expect(cookie.status).toBe(401);
		expect((await cookie.json()).code).toBe("unauthorized");
		const bad = await w.h.app.request("/mcp", {
			method: "POST",
			headers: { ...HDRS, authorization: "Bearer tsk_nope" },
			body: rpc("tools/list"),
		});
		expect(bad.status).toBe(401);
		for (const method of ["GET", "DELETE"]) {
			const r = await w.h.app.request("/mcp", {
				method,
				headers: { authorization: `Bearer ${w.token}` },
			});
			expect(r.status).toBe(405);
		}
		const noAuth = await w.h.app.request("/mcp", { method: "GET" });
		expect(noAuth.status).toBe(401);
	});

	test("clientInfo.name is ignored; X-Tasuki-Client decides via", async () => {
		const w = await world();
		await w.mcp(
			rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "sneaky", version: "1" },
			}),
		);
		await w.mcp(
			rpc("tools/call", {
				name: "comment",
				arguments: { ref: "WEB-1", bodyMd: "hi" },
			}),
		);
		const cs = await (await w.a.req("GET", "/issues/WEB-1/comments")).json();
		expect(cs.map((c: { via: string }) => c.via)).toEqual(["mcp:mcp"]);
	});

	test("oversized body is 413 problem+json (mcp and REST); small body still fine", async () => {
		const w = await world();
		const big = "x".repeat(1_000_001);
		const r = await w.mcp(big);
		expect(r.status).toBe(413);
		expect(r.headers.get("content-type")).toContain("application/problem+json");
		const rest = await w.h.app.request("/api/v1/projects", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: w.a.cookie },
			body: big,
		});
		expect(rest.status).toBe(413);
		const declared = await w.h.app.request("/mcp", {
			method: "POST",
			headers: {
				...HDRS,
				authorization: `Bearer ${w.token}`,
				"content-length": "5000000",
			},
			body: "{}",
		});
		expect(declared.status).toBe(413);
	});

	test("bad token with a body: 401 before the body is read, counts toward the limiter", async () => {
		const h = harness({ rateLimit: 1 });
		const big = "x".repeat(1_000_001);
		const hit = () =>
			h.app.request("/mcp", {
				method: "POST",
				headers: { ...HDRS, authorization: "Bearer tsk_nope" },
				body: big,
			});
		expect((await hit()).status).toBe(401); // not 413: auth runs first
		expect((await hit()).status).toBe(429);
	});

	test("GET with Accept: text/event-stream is still refused 405", async () => {
		const w = await world();
		const r = await w.h.app.request("/mcp", {
			method: "GET",
			headers: {
				authorization: `Bearer ${w.token}`,
				accept: "text/event-stream",
			},
		});
		expect(r.status).toBe(405);
	});

	test("bad token is rate limited like REST", async () => {
		const h = harness({ rateLimit: 2 });
		const hit = () =>
			h.app.request("/mcp", {
				method: "POST",
				headers: { ...HDRS, authorization: "Bearer tsk_nope" },
				body: rpc("tools/list"),
			});
		expect((await hit()).status).toBe(401);
		expect((await hit()).status).toBe(401);
		expect((await hit()).status).toBe(429);
	});

	test("read-only token: submit_plan is an error result, not a protocol error", async () => {
		const w = await world(["read"]);
		const r = await (
			await w.mcp(
				rpc("tools/call", {
					name: "submit_plan",
					arguments: {
						ref: "WEB-1",
						understandingMd: "u",
						stepsMd: "s",
					},
				}),
			)
		).json();
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain("forbidden");
	});

	test("malformed JSON gets a JSON-RPC error, not a 500", async () => {
		const w = await world();
		const r = await w.mcp("{nope");
		expect(r.status).toBe(400);
		expect((await r.json()).error).toBeTruthy();
	});
});
