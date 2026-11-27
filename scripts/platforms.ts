// The one platform table: build-bin builds these targets, gen-npm derives package metadata.
// (npm/tasuki/bin/tasuki.js keeps its own minimal map: it must run without dependencies.)
export const PLATFORMS = {
	"linux-x64": { os: "linux", cpu: "x64", libc: ["glibc"] },
	"linux-arm64": { os: "linux", cpu: "arm64", libc: ["glibc"] },
	"darwin-x64": { os: "darwin", cpu: "x64" },
	"darwin-arm64": { os: "darwin", cpu: "arm64" },
	"windows-x64": { os: "win32", cpu: "x64" },
} as const;

export type Target = keyof typeof PLATFORMS;
export const TARGETS = Object.keys(PLATFORMS) as Target[];
/** File name of the compiled binary in dist/bin. */
export const binName = (t: string) =>
	`tasuki-${t}${t.startsWith("windows") ? ".exe" : ""}`;
