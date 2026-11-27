// dist/bin -> dist/npm/<package>/ : the platform packages plus the main launcher package.
// The version comes from the root package.json (single source of truth).
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const { version } = (await Bun.file(join(root, "package.json")).json()) as {
	version: string;
};
const NODE = {
	"linux-x64": { os: "linux", cpu: "x64", libc: ["glibc"] },
	"linux-arm64": { os: "linux", cpu: "arm64", libc: ["glibc"] },
	"darwin-x64": { os: "darwin", cpu: "x64" },
	"darwin-arm64": { os: "darwin", cpu: "arm64" },
	"windows-x64": { os: "win32", cpu: "x64" },
} as const;

const out = join(root, "dist/npm");
rmSync(out, { recursive: true, force: true });
const common = {
	version,
	license: "MIT",
	repository: {
		type: "git",
		url: "git+https://github.com/suzukitech/tasuki.git",
	},
	publishConfig: { access: "public" },
};
const optionalDependencies: Record<string, string> = {};
for (const [key, f] of Object.entries(NODE)) {
	const name = `@suzukitech/tasuki-${key}`;
	const exe = key.startsWith("windows") ? "tasuki.exe" : "tasuki";
	const src = join(
		root,
		"dist/bin",
		`tasuki-${key}${key.startsWith("windows") ? ".exe" : ""}`,
	);
	if (!existsSync(src))
		throw new Error(`missing ${src}: run bun run build:bin first`);
	const dir = join(out, `tasuki-${key}`);
	mkdirSync(join(dir, "bin"), { recursive: true });
	copyFileSync(src, join(dir, "bin", exe));
	chmodSync(join(dir, "bin", exe), 0o755);
	copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name, ...common, description: `Tasuki binary for ${key}`, os: [f.os], cpu: [f.cpu], ...("libc" in f ? { libc: f.libc } : {}), files: ["bin", "LICENSE"] }, null, "\t")}\n`,
	);
	optionalDependencies[name] = version;
}
const main = join(out, "tasuki");
cpSync(join(root, "npm/tasuki"), main, { recursive: true });
copyFileSync(join(root, "LICENSE"), join(main, "LICENSE"));
copyFileSync(join(root, "README.md"), join(main, "README.md"));
const pkg = await Bun.file(join(main, "package.json")).json();
writeFileSync(
	join(main, "package.json"),
	`${JSON.stringify({ ...pkg, version, optionalDependencies }, null, "\t")}\n`,
);
console.log(
	`generated ${Object.keys(NODE).length + 1} packages at version ${version} in ${out}`,
);
