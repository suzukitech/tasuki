import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPES } from "@tasuki/schema";

// The web listens to exactly EVENT_TYPES; a type core records but the list lacks would never refresh a screen.
test("EVENT_TYPES covers every event type core records", () => {
	const dir = join(import.meta.dir, "../src");
	const used = new Set<string>();
	for (const f of readdirSync(dir))
		for (const m of readFileSync(join(dir, f), "utf8").matchAll(
			/"((?:issue|plan|criteria|evidence|report|question)\.[a-z]+)"/g,
		))
			used.add(m[1] as string);
	expect(used.size).toBeGreaterThan(10);
	expect([...used].sort()).toEqual([...EVENT_TYPES].sort());
});

test("the pure module stays zod-free (the web bundle imports it)", () => {
	const src = readFileSync(
		join(import.meta.dir, "../../schema/src/pure.ts"),
		"utf8",
	);
	expect(src).not.toMatch(/from "zod"|from '\.\/index'/);
});
