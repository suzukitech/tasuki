import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApiToken, sha256, submitPlan } from "@tasuki/core";
import { createEvents } from "../src/events";
import { isPrivateIp } from "../src/webhooks";
import { harness } from "./harness";

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

async function world() {
	const calls: { url: string; init: RequestInit }[] = [];
	let reply = () => new Response("ok", { status: 200 });
	const h = harness({
		webhook: {
			fetch: (async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return reply();
			}) as unknown as typeof fetch,
			lookup: async (host) =>
				host === "internal.test" ? ["10.0.0.5"] : ["93.184.216.34"],
			retryMs: 1,
		},
	});
	const a = await h.setup();
	await a.req("POST", "/projects", { key: "WEB", name: "Web" });
	const u = await h.addUser(a, "bob");
	await h.member(a, u.id, "WEB");
	const viewer = await h.addUser(a, "vic");
	await h.member(a, viewer.id, "WEB", "viewer");
	const outsider = await h.addUser(a, "olly");
	const issue = await (
		await a.req("POST", "/projects/WEB/issues", { title: "T" })
	).json();
	const upload = (
		who: { cookie?: string; csrf?: string },
		bytes: Uint8Array | string = PNG,
		type = "image/png",
		ref = issue.ref,
		extra: Record<string, string> = {},
	) =>
		h.app.request(
			`/api/v1/issues/${ref}/attachments?filename=${encodeURIComponent("画面 (1).png")}`,
			{
				method: "POST",
				headers: {
					"content-type": type,
					cookie: who.cookie ?? "",
					...(who.csrf && { "x-tasuki-csrf": who.csrf }),
					...extra,
				},
				body: bytes as BodyInit,
			},
		);
	return {
		h,
		a,
		u,
		viewer,
		outsider,
		issue,
		upload,
		calls,
		setReply: (f: typeof reply) => (reply = f),
	};
}

describe("attachments over REST", () => {
	test("upload, serve with safe headers, permissions", async () => {
		const w = await world();
		const res = await w.upload(w.a);
		expect(res.status).toBe(201);
		const att = await res.json();
		expect(att.url).toBe(`/api/v1/attachments/${att.id}`);
		expect(att.contentType).toBe("image/png");
		expect(existsSync(join(w.h.dataDir, "attachments", att.id))).toBe(true);

		const get = await w.a.req("GET", `/attachments/${att.id}`);
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("image/png");
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		expect(get.headers.get("cache-control")).toBe("private");
		expect(get.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
		expect(get.headers.get("content-disposition")).toBe(
			"inline; filename*=UTF-8''%E7%94%BB%E9%9D%A2%20%281%29.png",
		);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);

		// viewers may read but not attach; outsiders neither
		expect((await w.viewer.req("GET", `/attachments/${att.id}`)).status).toBe(
			200,
		);
		expect((await w.upload(w.viewer)).status).toBe(403);
		expect((await w.outsider.req("GET", `/attachments/${att.id}`)).status).toBe(
			403,
		);
		expect((await w.upload(w.outsider)).status).toBe(403);
		expect((await w.h.call("GET", `/attachments/${att.id}`)).status).toBe(401);
		expect((await w.a.req("GET", "/attachments/nope")).status).toBe(404);
	});

	test("CSRF still required for sessions; a token needs write scope", async () => {
		const w = await world();
		expect((await w.upload({ cookie: w.a.cookie })).status).toBe(403);
		const me = await (await w.a.req("GET", "/me")).json();
		const mk = async (scopes: string[]) =>
			(
				await (
					await w.a.req("POST", "/me/tokens", { name: "t", scopes })
				).json()
			).token as string;
		const post = (bearer: string) =>
			w.h.app.request(`/api/v1/issues/${w.issue.ref}/attachments`, {
				method: "POST",
				headers: {
					"content-type": "image/png",
					authorization: `Bearer ${bearer}`,
				},
				body: PNG,
			});
		expect((await post(await mk(["write"]))).status).toBe(201);
		expect((await post(await mk(["read"]))).status).toBe(403);
		expect(me.id).toBeTruthy();
	});

	test("only real png/jpeg/gif/webp, whatever the Content-Type says; 10 MB cap", async () => {
		const w = await world();
		const svg = "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>";
		expect((await w.upload(w.a, svg, "image/png")).status).toBe(415);
		expect((await w.upload(w.a, PNG, "text/plain")).status).toBe(415);
		expect((await w.upload(w.a, PNG, "image/svg+xml")).status).toBe(415);
		expect((await w.upload(w.a, new Uint8Array(0))).status).toBe(400);
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		big.set(PNG);
		expect((await w.upload(w.a, big)).status).toBe(413);
		// a lying Content-Length is refused before reading; no Content-Length is counted
		expect(
			(
				await w.upload(w.a, PNG, "image/png", w.issue.ref, {
					"content-length": String(11 * 1024 * 1024),
				})
			).status,
		).toBe(413);
		const ok = new Uint8Array(1024 * 1024 + 10);
		ok.set(PNG);
		expect((await w.upload(w.a, ok)).status).toBe(201); // above the 1 MB JSON cap
		expect((await w.upload(w.a, PNG, "image/png", "WEB-99")).status).toBe(404);
	});

	test("deleting the issue deletes the files", async () => {
		const w = await world();
		const att = await (await w.upload(w.a)).json();
		const file = join(w.h.dataDir, "attachments", att.id);
		expect((await w.a.req("DELETE", `/issues/${w.issue.ref}`)).status).toBe(
			204,
		);
		await Bun.sleep(20);
		expect(existsSync(file)).toBe(false);
		expect((await w.a.req("GET", `/attachments/${att.id}`)).status).toBe(404);
	});
});

describe("notifications over REST", () => {
	test("assignment notifies; list, mark read", async () => {
		const w = await world();
		await w.a.req("PATCH", `/issues/${w.issue.ref}`, { assigneeId: w.u.id });
		const list = await (
			await w.u.req("GET", "/me/notifications?limit=5")
		).json();
		expect(list.unread).toBe(1);
		expect(list.items[0]).toMatchObject({
			kind: "assigned",
			ref: "WEB-1",
			title: "T",
		});
		expect((await w.a.req("GET", "/me/notifications")).status).toBe(200);
		expect(
			(await (await w.a.req("GET", "/me/notifications")).json()).unread,
		).toBe(0);
		const r = await w.u.req("POST", "/me/notifications/read", {
			ids: [list.items[0].id],
		});
		expect(r.status).toBe(204);
		expect(
			(await (await w.u.req("GET", "/me/notifications")).json()).unread,
		).toBe(0);
		expect((await w.u.req("POST", "/me/notifications/read", {})).status).toBe(
			400,
		);
		expect((await w.h.call("GET", "/me/notifications")).status).toBe(401);
	});
});

describe("SSE user scoping", () => {
	test("a user-scoped event reaches only that user", async () => {
		const w = await world();
		const ev = createEvents();
		const mk = async (who: { cookie: string }, id: string) => {
			const sess = /tasuki_session=([^;]+)/.exec(who.cookie)?.[1] ?? "";
			const got: string[] = [];
			ev.subscribe(
				{ db: w.h.db, actor: { userId: id, via: "web", auth: "session" } },
				{ kind: "session", hash: sha256(sess) },
				(e) => void got.push(e.type),
				() => {},
			);
			return got;
		};
		const me = await (await w.a.req("GET", "/me")).json();
		const gotA = await mk(w.a, me.id);
		const gotU = await mk(w.u, w.u.id);
		const project = await (await w.a.req("GET", "/projects/WEB")).json();
		ev.publish({
			type: "notification.created",
			projectId: project.id,
			ref: "WEB-1",
			userId: w.u.id,
		});
		ev.publish({ type: "issue.updated", projectId: project.id, ref: "WEB-1" });
		expect(gotU).toEqual(["notification.created", "issue.updated"]);
		expect(gotA).toEqual(["issue.updated"]);
	});
});

describe("webhooks over REST", () => {
	const HOOK = "https://hooks.example.com/services/SECRET/xyz1234";
	test("manager + session only, masked, test-send, SSRF refusal", async () => {
		const w = await world();
		const res = await w.a.req("POST", "/projects/WEB/webhooks", {
			url: HOOK,
			events: ["plan.submitted"],
		});
		expect(res.status).toBe(201);
		const made = await res.json();
		expect(JSON.stringify(made)).not.toContain("SECRET");
		const list = await (await w.a.req("GET", "/projects/WEB/webhooks")).json();
		expect(list).toEqual([
			{
				id: made.id,
				url: "https://hooks.example.com/…1234",
				events: ["plan.submitted"],
			},
		]);
		expect((await w.u.req("GET", "/projects/WEB/webhooks")).status).toBe(403);
		expect(
			(
				await w.a.req("POST", "/projects/WEB/webhooks", {
					url: "file:///etc/passwd",
					events: ["plan.submitted"],
				})
			).status,
		).toBe(400);
		const tok = (
			await (
				await w.a.req("POST", "/me/tokens", {
					name: "t",
					scopes: ["read", "write"],
				})
			).json()
		).token;
		expect(
			(await w.h.call("GET", "/projects/WEB/webhooks", { bearer: tok })).status,
		).toBe(409);

		const ok = await (
			await w.a.req("POST", `/projects/WEB/webhooks/${made.id}/test`)
		).json();
		expect(ok).toEqual({ ok: true });
		expect(JSON.parse(w.calls[0]?.init.body as string).text).toContain(
			"テスト",
		);
		expect(w.calls[0]?.init.redirect).toBe("manual");

		w.setReply(
			() =>
				new Response("", {
					status: 302,
					headers: { location: "http://169.254.169.254/" },
				}),
		);
		expect(
			await (
				await w.a.req("POST", `/projects/WEB/webhooks/${made.id}/test`)
			).json(),
		).toEqual({ ok: false, reason: "failed" });

		const priv = await (
			await w.a.req("POST", "/projects/WEB/webhooks", {
				url: "http://internal.test/hook",
				events: ["plan.submitted"],
			})
		).json();
		const n = w.calls.length;
		expect(
			await (
				await w.a.req("POST", `/projects/WEB/webhooks/${priv.id}/test`)
			).json(),
		).toEqual({ ok: false, reason: "blocked" });
		expect(w.calls.length).toBe(n); // never fetched
		expect(
			(await w.a.req("DELETE", `/projects/WEB/webhooks/${priv.id}`)).status,
		).toBe(204);
		expect(
			(await w.a.req("POST", "/projects/WEB/webhooks/zzz/test")).status,
		).toBe(404);
	});

	test("turn events post Slack-format text after commit; failures log the id, not the URL", async () => {
		const w = await world();
		const made = await (
			await w.a.req("POST", "/projects/WEB/webhooks", {
				url: HOOK,
				events: ["plan.submitted", "issue.assigned"],
			})
		).json();
		await w.a.req("PATCH", `/issues/${w.issue.ref}`, { assigneeId: w.u.id });
		await Bun.sleep(30);
		expect(w.calls).toHaveLength(1);
		const text = JSON.parse(w.calls[0]?.init.body as string).text as string;
		expect(text).toContain("*WEB-1* T");
		expect(text).toContain("担当者が割り当てられました");
		expect(text).toContain("http://localhost:3000/p/WEB?issue=WEB-1");

		// a failing endpoint: one retry, then a log line with the id and never the URL
		const err = spyOn(console, "error").mockImplementation(() => {});
		w.setReply(() => {
			throw new Error(`connect ECONNREFUSED ${HOOK}`);
		});
		await w.a.req("PATCH", `/issues/${w.issue.ref}`, {
			assigneeId: w.viewer.id,
		});
		await Bun.sleep(60);
		expect(w.calls).toHaveLength(3);
		const logged = err.mock.calls.flat().join(" ");
		expect(logged).toContain(`webhook ${made.id} delivery failed: network`);
		expect(logged).not.toContain("SECRET");
		err.mockRestore();
	});
});

describe("webhook delivery is pinned to the checked address", () => {
	test("http: connects to the IP literal with the original Host; one lookup only", async () => {
		const seen: { url: string; host: string; redirect?: string }[] = [];
		let lookups = 0;
		const h = harness({
			webhook: {
				fetch: (async (url: string, init: RequestInit) => {
					seen.push({
						url,
						host: (init.headers as Record<string, string>).host as string,
						redirect: init.redirect,
					});
					return new Response("secret body", { status: 200 });
				}) as unknown as typeof fetch,
				// first answer public; a rebinding server would answer 127.0.0.1 the second time
				lookup: async () =>
					++lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"],
			},
		});
		const a = await h.setup();
		await a.req("POST", "/projects", { key: "WEB", name: "Web" });
		const hook = await (
			await a.req("POST", "/projects/WEB/webhooks", {
				url: "http://hook.example.test:8080/a/b?x=1",
				events: ["plan.submitted"],
			})
		).json();
		const res = await a.req("POST", `/projects/WEB/webhooks/${hook.id}/test`);
		const body = await res.json();
		expect(body).toEqual({ ok: true }); // nothing of the response leaks
		expect(seen).toEqual([
			{
				url: "http://93.184.216.34:8080/a/b?x=1",
				host: "hook.example.test:8080",
				redirect: "manual",
			},
		]);
		expect(lookups).toBe(1);
	});

	test("test-send exposes only ok / blocked / failed, never why", async () => {
		const mk = (f: () => Response | never) =>
			harness({
				webhook: {
					fetch: (async () => f()) as unknown as typeof fetch,
					lookup: async () => ["93.184.216.34"],
				},
			});
		for (const f of [
			() => new Response("<html>internal admin</html>", { status: 500 }),
			() =>
				new Response("", {
					status: 302,
					headers: { location: "http://10.0.0.1/" },
				}),
			() => {
				throw Object.assign(new Error("ECONNREFUSED"), {
					code: "ECONNREFUSED",
				});
			},
			() => {
				throw Object.assign(new Error("t"), { name: "TimeoutError" });
			},
		]) {
			const h = mk(f);
			const a = await h.setup();
			await a.req("POST", "/projects", { key: "WEB", name: "Web" });
			const hook = await (
				await a.req("POST", "/projects/WEB/webhooks", {
					url: "https://x.example.test/h",
					events: ["plan.submitted"],
				})
			).json();
			expect(
				await (
					await a.req("POST", `/projects/WEB/webhooks/${hook.id}/test`)
				).json(),
			).toEqual({ ok: false, reason: "failed" });
		}
	});

	test("https: real TLS to the pinned IP, certificate checked against the host name", async () => {
		const dir = join(import.meta.dir, "fixtures");
		const ca = await Bun.file(join(dir, "hook.pem")).text();
		const got: string[] = [];
		const srv = Bun.serve({
			port: 0,
			tls: {
				key: Bun.file(join(dir, "hook.key")),
				cert: Bun.file(join(dir, "hook.pem")),
			},
			fetch: (r) => {
				got.push(r.headers.get("host") ?? "");
				return new Response("hi");
			},
		});
		try {
			const run = async (host: string) => {
				const h = harness({
					webhook: {
						allowPrivate: true, // the fixture server is on loopback
						lookup: async () => ["127.0.0.1"],
						tls: { ca },
					},
				});
				const a = await h.setup();
				await a.req("POST", "/projects", { key: "WEB", name: "Web" });
				const hook = await (
					await a.req("POST", "/projects/WEB/webhooks", {
						url: `https://${host}:${srv.port}/h`,
						events: ["plan.submitted"],
					})
				).json();
				return (await (
					await a.req("POST", `/projects/WEB/webhooks/${hook.id}/test`)
				).json()) as { ok: boolean; reason?: string };
			};
			expect(await run("hook.example.test")).toEqual({ ok: true });
			expect(got).toEqual([`hook.example.test:${srv.port}`]);
			// the certificate is for hook.example.test: any other name must fail verification
			expect(await run("evil.example.test")).toEqual({
				ok: false,
				reason: "failed",
			});
		} finally {
			srv.stop(true);
		}
	});
});

test("isPrivateIp covers loopback, private, link-local, metadata, mapped and v6 ranges", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"ff02::1",
		"64:ff9b::1",
		"2002:7f00:1::1",
		"not-an-ip",
	])
		expect(isPrivateIp(ip)).toBe(true);
	for (const ip of [
		"93.184.216.34",
		"8.8.8.8",
		"172.32.0.1",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
	])
		expect(isPrivateIp(ip)).toBe(false);
});
