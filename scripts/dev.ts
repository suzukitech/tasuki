// Server (:3000, watch) and Vite (:5173, proxies /api and /mcp to the server) in one terminal.
// The browser talks to Vite, so the server must accept its origin (CSRF Origin check).
process.env.TASUKI_BASE_URL ??= "http://localhost:5173";
const run = (cmd: string[], cwd?: string) =>
	Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
const procs = [
	run(["bun", "--watch", "apps/server/src/index.ts"]),
	run(["bunx", "--bun", "vite"], "apps/web"),
];
process.on("SIGINT", () => {
	for (const p of procs) p.kill();
});
await Promise.race(procs.map((p) => p.exited));
for (const p of procs) p.kill();
