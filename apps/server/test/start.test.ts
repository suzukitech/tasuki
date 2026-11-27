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
