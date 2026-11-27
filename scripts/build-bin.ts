// Single executables: `bun run build:bin [os-arch ...]` -> dist/bin/tasuki-<os>-<arch>[.exe]
// The web SPA (apps/web/dist) and the drizzle migrations are embedded into each binary via a
// generated entry (dist/.entry/entry.ts). In the repo, nothing is embedded: files are read from disk.
import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ALL = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
];
const targets = Bun.argv.slice(2).length ? Bun.argv.slice(2) : ALL;
for (const t of targets)
	if (!ALL.includes(t))
		throw new Error(`unknown target ${t} (${ALL.join(", ")})`);

const sh = (cmd: string[], cwd = root) => {
	const r = Bun.spawnSync(cmd, {
		cwd,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
};

sh(["bun", "run", "build"]);

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});

const entryDir = join(root, "dist/.entry");
rmSync(entryDir, { recursive: true, force: true });
mkdirSync(entryDir, { recursive: true });
const rel = (p: string) => relative(entryDir, p).replaceAll("\\", "/");

const webDir = join(root, "apps/web/dist");
const web = walk(webDir).sort();
const drizzle = join(root, "packages/db/drizzle");
const journal = (await Bun.file(
	join(drizzle, "meta/_journal.json"),
).json()) as {
	entries: { tag: string }[];
};

const lines = [
	`import { embeddedMigrations } from "${rel(join(root, "packages/db/src/index"))}";`,
	`import { run } from "${rel(join(root, "packages/cli/src/main"))}";`,
	`import journal from "${rel(join(drizzle, "meta/_journal.json"))}" with { type: "json" };`,
	...journal.entries.map(
		(e, i) =>
			`import m${i} from "${rel(join(drizzle, `${e.tag}.sql`))}" with { type: "text" };`,
	),
	...web.map((f, i) => `import w${i} from "${rel(f)}" with { type: "file" };`),
	"const webAssets: Record<string, string> = {",
	...web.map(
		(f, i) =>
			`\t${JSON.stringify(`/${relative(webDir, f).replaceAll("\\", "/")}`)}: w${i},`,
	),
	"};",
	"const migrations = embeddedMigrations(journal, {",
	...journal.entries.map((e, i) => `\t${JSON.stringify(e.tag)}: m${i},`),
	"});",
	"const code = await run(Bun.argv.slice(2), { webAssets, migrations });",
	"if (code !== undefined) process.exit(code);",
	"",
];
const entry = join(entryDir, "entry.ts");
writeFileSync(entry, lines.join("\n"));

const out = join(root, "dist/bin");
mkdirSync(out, { recursive: true });
for (const t of targets) {
	const file = join(out, `tasuki-${t}${t.startsWith("windows") ? ".exe" : ""}`);
	sh([
		"bun",
		"build",
		entry,
		"--compile",
		`--target=bun-${t}`,
		`--outfile=${file}`,
	]);
	console.log(`${file} ${(statSync(file).size / 1e6).toFixed(1)} MB`);
}
