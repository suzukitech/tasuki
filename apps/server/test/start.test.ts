import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/index";

test("startServer serves /health from a fresh data dir and creates the db", async () => {
	const data = join(mkdtempSync(join(tmpdir(), "tasuki-start-")), "d");
	const s = startServer({ data, port: 0 });
	try {
		const r = await fetch(`http://127.0.0.1:${s.port}/health`);
		expect(await r.json()).toEqual({ ok: true });
		expect(await Bun.file(join(data, "tasuki.db")).exists()).toBe(true);
	} finally {
		s.stop(true);
	}
});

test("baseUrl defaults to the bound port, so login passes the Origin check", async () => {
	const saved = process.env.TASUKI_BASE_URL;
	delete process.env.TASUKI_BASE_URL;
	const data = join(mkdtempSync(join(tmpdir(), "tasuki-start-")), "d");
	const s = startServer({ data, port: 0 });
	try {
		const origin = `http://localhost:${s.port}`;
		const r = await fetch(`${origin}/api/v1/auth/login`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ email: "x@example.com", password: "nope" }),
		});
		// wrong credentials: rejected by auth (401), not by the CSRF Origin check (403)
		expect(r.status).toBe(401);
	} finally {
		s.stop(true);
		if (saved !== undefined) process.env.TASUKI_BASE_URL = saved;
	}
});
