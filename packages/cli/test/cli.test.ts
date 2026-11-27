import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { agentSetup, END, START, upsertSection } from "../src/agent-setup";
import { backup } from "../src/backup";
import { exportData } from "../src/export";
import { run } from "../src/main";
import { seededData, tmp } from "./fixture";

const cap = () => {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
	};
};

describe("arg parsing", () => {
	test("--version and --help", async () => {
		const a = cap();
		expect(await run(["--version"], undefined, a.io)).toBe(0);
		expect(a.out).toEqual([pkg.version]);
		const b = cap();
		expect(await run(["--help"], undefined, b.io)).toBe(0);
		expect(b.out[0]).toContain("serve");
		expect(await run([], undefined, cap().io)).toBe(2);
	});
	test("unknown command, unknown flag, bad port, missing format", async () => {
		for (const argv of [
			["nope"],
			["serve", "--bogus"],
			["serve", "--port", "abc"],
			["export", "--data", "/nonexistent"],
			["mcp"],
		]) {
			const c = cap();
			expect(await run(argv, undefined, c.io)).toBe(2);
			expect(c.err.length).toBe(1);
		}
	});
	test("agent-setup prints the claude mcp add hint with a placeholder url", async () => {
		const c = cap();
		await run(["agent-setup", "--dir", tmp()], undefined, c.io);
		expect(c.out.join("\n")).toContain("<your-host>/mcp");
	});
	test("errors never echo the token", async () => {
		const c = cap();
		const code = await run(
			["mcp", "--url", "not a url", "--token", "tsk_SECRET"],
			undefined,
			c.io,
		);
		expect(code).toBe(1);
		expect(c.err.join()).not.toContain("tsk_SECRET");
	});
	test("default io prints to the console", async () => {
		const log = console.log;
		const lines: unknown[] = [];
		console.log = (x: unknown) => void lines.push(x);
		try {
			expect(await run(["--version"])).toBe(0);
		} finally {
			console.log = log;
		}
		expect(lines).toEqual([pkg.version]);
		const err = console.error;
		console.error = () => {};
		try {
			expect(await run(["nope"])).toBe(2);
		} finally {
			console.error = err;
		}
	});
	test("serve starts a server on the given port and keeps running", async () => {
		const data = tmp();
		expect(await run(["serve", "--data", data, "--port", "0"])).toBeUndefined();
		expect(existsSync(join(data, "tasuki.db"))).toBe(true);
	});
	test("healthcheck fails when nothing listens", async () => {
		expect(await run(["healthcheck", "--port", "1"], undefined, cap().io)).toBe(
			1,
		);
	});
	test("healthcheck passes against a server", async () => {
		const s = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
		expect(
			await run(["healthcheck", "--port", String(s.port)], undefined, cap().io),
		).toBe(0);
		s.stop(true);
	});
});

describe("agent-setup", () => {
	test("creates both files, is idempotent, preserves other content", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nkeep me\n");
		const first = agentSetup(dir);
		expect(first.map((f) => f.changed)).toEqual([true, true]);
		const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
		expect(claude.startsWith("# Mine\n\nkeep me\n")).toBe(true);
		for (const t of [
			"next_task",
			"submit_plan",
			"record_evidence",
			"submit_report",
			"ask_question",
		])
			expect(claude).toContain(t);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(START);

		expect(agentSetup(dir).map((f) => f.changed)).toEqual([false, false]);
		// text around a stale section is preserved while the section is replaced
		writeFileSync(
			join(dir, "AGENTS.md"),
			`before\n${START}\nold\n${END}\nafter\n`,
		);
		agentSetup(dir);
		const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
		expect(agents.startsWith("before\n")).toBe(true);
		expect(agents.endsWith("\nafter\n")).toBe(true);
		expect(agents).not.toContain("old");
		expect(agents.split(START).length).toBe(2);
	});
	test("upsertSection on empty text", () => {
		expect(upsertSection("").startsWith(START)).toBe(true);
	});
	test("command prints files and the claude mcp add hint", async () => {
		const dir = tmp();
		const c = cap();
		expect(
			await run(
				["agent-setup", "--dir", dir, "--url", "https://t.example/"],
				undefined,
				c.io,
			),
		).toBe(0);
		expect(c.out.join("\n")).toContain("https://t.example/mcp");
		expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
	});
});

describe("backup", () => {
	test("snapshot is a valid db containing the data, even with the source open in WAL", () => {
		const { data } = seededData();
		const live = new Database(join(data, "tasuki.db"));
		live.run("PRAGMA journal_mode=WAL");
		const out = backup(data, undefined, new Date("2026-01-02T03:04:05Z"));
		expect(out).toContain("tasuki-2026-01-02T03-04-05-000Z.db");
		const snap = new Database(out, { readonly: true });
		expect(snap.query("SELECT count(*) AS n FROM issues").get()).toEqual({
			n: 1,
		});
		snap.close();
		live.close();
	});
	test("--out file, missing db, existing target refused", async () => {
		const { data } = seededData();
		const out = join(tmp(), "x", "b.db");
		const c = cap();
		expect(
			await run(["backup", "--data", data, "--out", out], undefined, c.io),
		).toBe(0);
		expect(existsSync(out)).toBe(true);
		expect(
			await run(["backup", "--data", data, "--out", out], undefined, cap().io),
		).toBe(1);
		expect(await run(["backup", "--data", tmp()], undefined, cap().io)).toBe(1);
	});
});

describe("export", () => {
	test("md: one file per issue with frontmatter, criteria and comments", () => {
		const { data, ref } = seededData();
		const out = join(tmp(), "md");
		expect(exportData({ data, format: "md", out }).files).toBe(1);
		const text = readFileSync(join(out, "WEB", `${ref}.md`), "utf8");
		expect(text).toStartWith("---\nref: WEB-1\n");
		for (const s of [
			'title: "Fix \\"login\\""',
			'assignee: "Alice"',
			'labels: ["bug"]',
			"Login fails on **Safari**.",
			"- [ ] Safari can log in (pending)",
			"### Alice",
			"Reproduced.",
		])
			expect(text).toContain(s);
	});
	test("json: all data, to a file and filtered by project", () => {
		const { data } = seededData();
		const out = join(tmp(), "all.json");
		expect(exportData({ data, format: "json", out }).files).toBe(1);
		const j = JSON.parse(readFileSync(out, "utf8"));
		expect(j.projects[0].project.key).toBe("WEB");
		expect(j.projects[0].issues[0].comments[0].bodyMd).toBe("Reproduced.");
		expect(JSON.stringify(j)).not.toContain("passwordHash");
		expect(() =>
			exportData({ data, format: "json", out, project: "NOPE" }),
		).toThrow();
	});
	test("needs a system admin", async () => {
		const data = tmp();
		mkdirSync(data, { recursive: true });
		const c = cap();
		expect(
			await run(
				["export", "--format", "json", "--data", data],
				undefined,
				c.io,
			),
		).toBe(1);
	});
	test("command: md summary line, json to stdout stays quiet", async () => {
		const { data } = seededData();
		const out = join(tmp(), "o");
		const c = cap();
		expect(
			await run(
				["export", "--format", "md", "--data", data, "--out", out],
				undefined,
				c.io,
			),
		).toBe(0);
		expect(c.out[0]).toContain("1 件");
		expect(readdirSync(join(out, "WEB"))).toEqual(["WEB-1.md"]);
	});
	test("md export is read-only: the db is unchanged", () => {
		const { data } = seededData();
		const before = readFileSync(join(data, "tasuki.db")).length;
		exportData({ data, format: "md", out: join(tmp(), "z") });
		expect(readFileSync(join(data, "tasuki.db")).length).toBe(before);
	});
});
