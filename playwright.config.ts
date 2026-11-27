import { defineConfig } from "@playwright/test";

const PORT = 4317;

// The server serves the built SPA (apps/web/dist) itself, against a fresh temp TASUKI_DATA,
// so the run never touches a dev database. `bun run e2e` builds the web app first.
export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts", // not *.test.ts / *.spec.ts: `bun test` must not pick these up
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: "ja-JP",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "setup", testMatch: "**/auth.setup.ts" },
		{
			name: "app",
			dependencies: ["setup"],
			use: { storageState: "e2e/.auth/admin.json" },
		},
	],
	webServer: {
		command: `sh -c 'TASUKI_DATA=$(mktemp -d) PORT=${PORT} TASUKI_BASE_URL=http://localhost:${PORT} bun apps/server/src/index.ts'`,
		url: `http://localhost:${PORT}/health`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
