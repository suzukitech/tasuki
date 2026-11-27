import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, users } from "@tasuki/db";
import { createMcpServer } from "@tasuki/mcp";
import { insecureRemote, mcpUrl, relay, runRelay } from "../src/mcp";

describe("mcp url", () => {
	test("base URL gets /mcp, a full /mcp URL is kept", () => {
		expect(mcpUrl("https://t.example")).toBe("https://t.example/mcp");
		expect(mcpUrl("https://t.example/")).toBe("https://t.example/mcp");
		expect(mcpUrl("https://t.example/mcp")).toBe("https://t.example/mcp");
		expect(mcpUrl("http://localhost:3000/")).toBe("http://localhost:3000/mcp");
	});
	test("http to a non-loopback host is flagged", () => {
		expect(insecureRemote("http://t.example/mcp")).toBe(true);
		expect(insecureRemote("https://t.example/mcp")).toBe(false);
		for (const h of ["localhost", "127.0.0.1", "[::1]"])
			expect(insecureRemote(`http://${h}:3000/mcp`)).toBe(false);
	});
});

describe("mcp relay", () => {
	test("forwards messages both ways over linked transports", async () => {
		const [agent, local] = InMemoryTransport.createLinkedPair();
		const [remote, server] = InMemoryTransport.createLinkedPair();
		// stand-in server: answers every request with its method name
		server.onmessage = (m) => {
			if ("id" in m && "method" in m)
				void server.send({
					jsonrpc: "2.0",
					id: m.id,
					result: { echo: m.method },
				});
		};
		await server.start();
		let closed = false;
		relay(local, remote, () => {
			closed = true;
		});
		await remote.start();
		await local.start();
		const got = Promise.withResolvers<unknown>();
		agent.onmessage = (m) => got.resolve(m);
		await agent.start();
		await agent.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(await got.promise).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { echo: "ping" },
		});
		local.onerror?.(new Error("ignored"));
		await agent.close();
		expect(closed).toBe(true);
	});

	test("undeliverable request gets a JSON-RPC error, without secrets", async () => {
		const [agent, local] = InMemoryTransport.createLinkedPair();
		const remote = {
			start: async () => {},
			close: async () => {},
			send: async () => {
				throw new Error("boom Bearer tsk_SECRET");
			},
		} as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
		relay(local, remote, () => {});
		await local.start();
		const got = Promise.withResolvers<unknown>();
		agent.onmessage = (m) => got.resolve(m);
		await agent.start();
		await agent.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
		const m = (await got.promise) as { id: number; error: { message: string } };
		expect(m.id).toBe(7);
		expect(JSON.stringify(m)).not.toContain("tsk_SECRET");
	});

	test("end to end against a real /mcp HTTP endpoint with a Bearer token", async () => {
		const db = openDb(":memory:");
		const u = db
			.insert(users)
			.values({ email: "a@example.com", name: "A", passwordHash: "x" })
			.returning()
			.get();
		let seenAuth = "";
		const http = Bun.serve({
			port: 0,
			async fetch(req) {
				seenAuth = req.headers.get("authorization") ?? "";
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const { WebStandardStreamableHTTPServerTransport: T } = await import(
					"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
				);
				const t = new T({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				const s = createMcpServer(
					{
						db,
						actor: {
							userId: u.id,
							via: "mcp:x",
							auth: "token",
							token: { scopes: ["read"], projectIds: null },
						},
					},
					{ baseUrl: "http://x" },
				);
				await s.connect(t);
				return t.handleRequest(req);
			},
		});
		const remote = new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${http.port}/mcp`),
			{
				requestInit: { headers: { authorization: "Bearer tsk_abc" } },
			},
		);
		const [agent, local] = InMemoryTransport.createLinkedPair();
		relay(local, remote, () => {});
		await local.start();
		const client = new Client({ name: "t", version: "0" });
		await client.connect(agent);
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("next_task");
		expect(seenAuth).toBe("Bearer tsk_abc");
		await client.close();
		http.stop(true);
	});

	test("runRelay resolves when the local side closes", async () => {
		const http = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 405 }),
		});
		const [agent, local] = InMemoryTransport.createLinkedPair();
		const done = runRelay(`http://127.0.0.1:${http.port}/mcp`, "tsk_x", local);
		await agent.start();
		await agent.close();
		await done;
		http.stop(true);
	});
});
