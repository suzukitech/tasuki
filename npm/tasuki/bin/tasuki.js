#!/usr/bin/env node

// Thin launcher: finds the platform package holding the real (Bun-compiled) binary and runs it.
// Plain CommonJS, no dependencies: `npx` runs this under whatever Node the user has.
const { spawnSync } = require("node:child_process");
const { chmodSync, accessSync, constants } = require("node:fs");
const { dirname, join } = require("node:path");

const PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
];

/** "linux-x64" style key for a Node platform/arch pair, or null when unsupported. */
function platformKey(platform, arch) {
	const key = `${platform === "win32" ? "windows" : platform}-${arch}`;
	return PLATFORMS.includes(key) ? key : null;
}

/** { path } of the binary, or { error } with a message for the user. */
function findBinary(platform, arch, resolve) {
	const key = platformKey(platform, arch);
	if (!key)
		return {
			error: `tasuki: ${platform}-${arch} は未対応です（対応: ${PLATFORMS.join(", ")}）。GitHub Releases から実行ファイルを探すか、Docker を使ってください。`,
		};
	const pkg = `@suzukitech/tasuki-${key}`;
	try {
		const dir = dirname(resolve(`${pkg}/package.json`));
		return {
			path: join(
				dir,
				"bin",
				key.startsWith("windows") ? "tasuki.exe" : "tasuki",
			),
		};
	} catch {
		return {
			error: `tasuki: ${pkg} が見つかりません。\`--no-optional\` / \`--omit=optional\` を付けずにインストールし直してください（optionalDependencies に実行ファイルが入っています）。`,
		};
	}
}

/** Run the binary; returns the exit code. `env` is injectable for tests. */
function main(env) {
	const e = {
		platform: process.platform,
		arch: process.arch,
		resolve: require.resolve,
		argv: process.argv.slice(2),
		spawn: spawnSync,
		kill: process.kill.bind(process, process.pid),
		...env,
	};
	const r = findBinary(e.platform, e.arch, e.resolve);
	if (r.error) {
		console.error(r.error);
		return 1;
	}
	try {
		// some installers drop the executable bit
		accessSync(r.path, constants.X_OK);
	} catch {
		try {
			chmodSync(r.path, 0o755);
		} catch {}
	}
	const res = e.spawn(r.path, e.argv, { stdio: "inherit" });
	if (res.error) {
		console.error(`tasuki: 起動に失敗しました: ${res.error.message}`);
		return 1;
	}
	if (res.signal) {
		e.kill(res.signal);
		return 1;
	}
	return res.status ?? 1;
}

module.exports = { PLATFORMS, platformKey, findBinary, main };
if (require.main === module) process.exit(main());
