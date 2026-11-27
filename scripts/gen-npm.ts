// dist/bin -> dist/npm/<package>/ : the platform packages plus the main launcher package.
// The executable bit is set where it matters: the release workflow runs chmod before `npm publish`
// (artifact upload drops it). The version comes from the root package.json (single source of truth).
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { binName, PLATFORMS } from "./platforms";

const root = resolve(import.meta.dir, "..");
const { version } = (await Bun.file(join(root, "package.json")).json()) as {
	version: string;
};
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
for (const [key, f] of Object.entries(PLATFORMS)) {
	const name = `@suzukitech/tasuki-${key}`;
	const exe = key.startsWith("windows") ? "tasuki.exe" : "tasuki";
	const src = join(root, "dist/bin", binName(key));
	if (!existsSync(src))
		throw new Error(`missing ${src}: run bun run build:bin first`);
	const dir = join(out, `tasuki-${key}`);
	mkdirSync(join(dir, "bin"), { recursive: true });
	copyFileSync(src, join(dir, "bin", exe));
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
	`generated ${Object.keys(PLATFORMS).length + 1} packages at version ${version} in ${out}`,
);
