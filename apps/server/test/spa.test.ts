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
	test("path traversal and bad escapes fall back to index.html, never leak files", async () => {
		for (const p of ["/..%2f..%2fpackage.json", "/%E0%A4%A"]) {
			const r = await app.request(p);
			expect(await r.text()).toContain("<title>spa</title>");
		}
	});
	test("without a dist nothing is served", async () => {
		expect((await mk().request("/")).status).toBe(404);
		expect((await mk(join(dir, "missing")).request("/p/WEB")).status).toBe(404);
	});
});
