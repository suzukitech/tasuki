import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@tasuki/db";
import { createApp } from "../src/app";

const dir = mkdtempSync(join(tmpdir(), "tasuki-web-"));
beforeAll(() => {
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");
	writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
});
afterAll(() => rmSync(dir, { recursive: true }));

const mk = (webDir?: string) =>
	createApp(openDb(":memory:"), { baseUrl: "http://localhost:3000", webDir });

describe("SPA serving", () => {
	const app = mk(dir);
	test("static file with immutable cache, index.html fallback for client routes", async () => {
		const a = await app.request("/assets/a.js");
		expect(await a.text()).toBe("console.log(1)");
		expect(a.headers.get("cache-control")).toContain("immutable");
		for (const p of ["/", "/p/WEB", "/invite/abc"]) {
			const r = await app.request(p);
			expect(r.status).toBe(200);
			expect(await r.text()).toContain("<title>spa</title>");
		}
	});
	test("api and mcp paths never fall back", async () => {
		const r = await app.request("/api/v1/nope");
		expect(r.status).toBe(401);
		expect((await app.request("/api/nope")).status).toBe(404);
		expect((await app.request("/mcp", { method: "GET" })).status).toBe(401);
	});
	test("path traversal and bad escapes never leak files", async () => {
		const r = await app.request("/..%2f..%2fpackage.json");
		expect(r.status).toBe(404);
		expect(await r.text()).not.toContain("workspaces");
		const bad = await app.request("/%E0%A4%A");
		expect(await bad.text()).toContain("<title>spa</title>");
	});
	test("a missing asset or a file-like path is 404, not index.html", async () => {
		for (const p of ["/assets/gone.js", "/missing.js", "/favicon.ico"]) {
			const r = await app.request(p);
			expect(r.status).toBe(404);
			expect(await r.text()).not.toContain("<title>spa</title>");
		}
		expect((await app.request("/p/WEB")).status).toBe(200);
	});
	test("without a dist nothing is served", async () => {
		expect((await mk().request("/")).status).toBe(404);
		expect((await mk(join(dir, "missing")).request("/p/WEB")).status).toBe(404);
	});

	test("embedded assets (compiled binary) serve the same way, only listed paths", async () => {
		const app = createApp(openDb(":memory:"), {
			baseUrl: "http://localhost:3000",
			webAssets: {
				"/index.html": join(dir, "index.html"),
				"/assets/a.js": join(dir, "assets", "a.js"),
				"/assets/日本語.js": join(dir, "assets", "a.js"),
			},
		});
		const jp = await app.request(`/assets/${encodeURIComponent("日本語.js")}`);
		expect(await jp.text()).toBe("console.log(1)");
		expect((await app.request("/assets/constructor")).status).toBe(404);
		expect((await app.request("/__proto__")).status).not.toBe(500);
		const a = await app.request("/assets/a.js");
		expect(await a.text()).toBe("console.log(1)");
		expect(a.headers.get("cache-control")).toContain("immutable");
		expect(await (await app.request("/p/WEB")).text()).toContain(
			"<title>spa</title>",
		);
		expect((await app.request("/assets/b.js")).status).toBe(404);
		expect((await app.request("/..%2fpackage.json")).status).toBe(404);
	});
});
