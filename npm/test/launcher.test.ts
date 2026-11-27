import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

const { PLATFORMS, platformKey, findBinary, main } = createRequire(
	import.meta.url,
)("../tasuki/bin/tasuki.js") as {
	PLATFORMS: string[];
	platformKey(platform: string, arch: string): string | null;
	main(env: Record<string, unknown>): number;
	findBinary(
		platform: string,
		arch: string,
		resolve: (id: string) => string,
	): { path?: string; error?: string };
};

describe("npm launcher", () => {
	test("maps node platform/arch to our package keys", () => {
		expect(platformKey("linux", "x64")).toBe("linux-x64");
		expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformKey("win32", "x64")).toBe("windows-x64");
		expect(platformKey("freebsd", "x64")).toBeNull();
		expect(platformKey("win32", "arm64")).toBeNull();
		expect(PLATFORMS).toHaveLength(5);
	});
	test("resolves the binary inside the platform package", () => {
		const resolve = (id: string) => join("/nm", id);
		expect(findBinary("linux", "arm64", resolve)).toEqual({
			path: join("/nm/@suzukitech/tasuki-linux-arm64", "bin", "tasuki"),
		});
		expect(findBinary("win32", "x64", resolve)).toEqual({
			path: join("/nm/@suzukitech/tasuki-windows-x64", "bin", "tasuki.exe"),
		});
	});
	test("missing platform package: message names the package and optional deps", () => {
		const r = findBinary("darwin", "x64", () => {
			throw new Error("not found");
		});
		expect(r.error).toContain("@suzukitech/tasuki-darwin-x64");
		expect(r.error).toContain("optional");
	});
	test("unsupported platform lists supported ones", () => {
		expect(findBinary("sunos", "x64", require.resolve).error).toContain(
			"linux-x64",
		);
	});
	test.skipIf(!Bun.which("node"))(
		"runs under plain node: forwards exit code and stdio",
		() => {
			// no platform package is installed here, so the launcher must fail with its own message
			const r = Bun.spawnSync(
				["node", join(import.meta.dir, "../tasuki/bin/tasuki.js"), "--version"],
				{
					stderr: "pipe",
				},
			);
			expect(r.exitCode).toBe(1);
			expect(r.stderr.toString()).toContain("@suzukitech/tasuki-");
		},
	);

	describe("main", () => {
		const base = {
			platform: "linux",
			arch: "x64",
			resolve: (id: string) => join("/nowhere", id),
			argv: ["serve", "--port", "1"],
		};
		test("forwards argv with inherited stdio and returns the exit code", () => {
			let seen: unknown[] = [];
			const code = main({
				...base,
				spawn: (...a: unknown[]) => {
					seen = a;
					return { status: 3 };
				},
			});
			expect(code).toBe(3);
			expect(seen[0]).toBe(
				join("/nowhere/@suzukitech/tasuki-linux-x64", "bin", "tasuki"),
			);
			expect(seen[1]).toEqual(["serve", "--port", "1"]);
			expect(seen[2]).toEqual({ stdio: "inherit" });
		});
		test("musl (Alpine) gets a clear message and never spawns", () => {
			const err = console.error;
			const lines: string[] = [];
			console.error = (m: string) => void lines.push(m);
			try {
				const code = main({
					...base,
					musl: () => true,
					spawn: () => {
						throw new Error("must not spawn");
					},
				});
				expect(code).toBe(1);
			} finally {
				console.error = err;
			}
			expect(lines.join()).toContain("musl");
			// glibc linux and non-linux are not affected
			expect(
				main({ ...base, musl: () => false, spawn: () => ({ status: 0 }) }),
			).toBe(0);
		});
		test("signal death is re-raised, spawn errors and missing package exit 1", () => {
			const sigs: string[] = [];
			expect(
				main({
					...base,
					spawn: () => ({ signal: "SIGTERM" }),
					kill: (s: string) => sigs.push(s),
				}),
			).toBe(1);
			expect(sigs).toEqual(["SIGTERM"]);
			expect(
				main({ ...base, spawn: () => ({ error: new Error("ENOENT") }) }),
			).toBe(1);
			expect(
				main({
					...base,
					resolve: () => {
						throw new Error("x");
					},
				}),
			).toBe(1);
			expect(main({ ...base, spawn: () => ({}) })).toBe(1);
		});
	});
});
