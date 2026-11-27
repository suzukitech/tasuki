import { expect, test } from "@playwright/test";
import { ADMIN, api, BOB } from "./helpers";

// One project for the whole run; each test uses its own issues.
const KEY = "PWT";

test.beforeAll(async ({ browser }) => {
	const ctx = await browser.newContext({
		storageState: "e2e/.auth/admin.json",
	});
	const page = await ctx.newPage();
	await page.goto("/");
	await api(page, "POST", "/projects", { key: KEY, name: "E2E project" }).catch(
		() => {},
	); // already there on a worker restart
	await ctx.close();
});

test("quick create adds an issue to the list", async ({ page }) => {
	await page.goto(`/p/${KEY}`);
	const bar = page.getByPlaceholder(/タイトルを入れて Enter/);
	await bar.fill("ログイン画面の文言を直す");
	await bar.press("Enter");
	await expect(
		page.getByRole("row", { name: /ログイン画面の文言を直す/ }),
	).toBeVisible();
});

test("inline status edit persists after reload", async ({ page }) => {
	await page.goto(`/p/${KEY}`);
	const title = "状態を変えるチケット";
	const bar = page.getByPlaceholder(/タイトルを入れて Enter/);
	await bar.fill(title);
	await bar.press("Enter");
	const row = page.getByRole("row", { name: new RegExp(title) });
	await row.getByLabel(/^状態: /).click();
	await page
		.getByRole("option", { name: /着手待ち/ })
		.first()
		.click();
	await expect(row.getByLabel(/^状態: /)).not.toContainText("下書き");
	const shown = await row.getByLabel(/^状態: /).textContent();
	await page.reload();
	await expect(
		page.getByRole("row", { name: new RegExp(title) }).getByLabel(/^状態: /),
	).toHaveText(shown ?? "");
});

test("dragging into 計画確認 is refused with a Japanese toast", async ({
	page,
}) => {
	await page.goto(`/p/${KEY}?view=board`);
	const card = page
		.getByRole("button", { name: /ログイン画面の文言を直す/ })
		.first();
	await card.focus();
	await page.keyboard.press("Space");
	// dnd-kit's keyboard sensor measures between keys: give it a moment each time
	for (let i = 0; i < 2; i++) {
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowRight");
	}
	await page.waitForTimeout(200);
	await page.keyboard.press("Space");
	await expect(
		page.getByText(/計画確認へは、計画を提出すると進みます/),
	).toBeVisible();
});

test("a new token shows the claude mcp add command", async ({ page }) => {
	await page.goto("/settings");
	await page.getByLabel("名前", { exact: true }).fill("e2e-laptop");
	await page.getByRole("button", { name: "発行する" }).click();
	await expect(
		page.getByRole("textbox", { name: "Claude Code に登録するコマンド" }),
	).toHaveValue(/claude mcp add --transport http tasuki/);
});

test("a plan submitted with a token notifies the approver, who approves in the UI", async ({
	page,
	browser,
	playwright,
}) => {
	// bob (a member) owns the AI token; the admin is the requester and approver
	const invite = await api(page, "POST", "/invites");
	const anon = await playwright.request.newContext({
		baseURL: "http://localhost:4317",
	});
	const origin = "http://localhost:4317";
	const acc = await anon.post("/api/v1/invites/accept", {
		headers: { origin },
		data: { token: invite.token, ...BOB },
	});
	expect(acc.ok()).toBeTruthy();
	const bob = (await acc.json()) as { id: string };
	await api(page, "POST", `/projects/${KEY}/members`, {
		email: BOB.email,
		role: "member",
	});
	const issue = (await api(page, "POST", `/projects/${KEY}/issues`, {
		title: "通知のテスト用チケット",
		assigneeId: bob.id,
	})) as { ref: string };

	// bob's own session mints a token (token creation is a session act)
	const bobCtx = await browser.newContext();
	const login = await bobCtx.request.post("/api/v1/auth/login", {
		headers: { origin },
		data: { email: BOB.email, password: BOB.password },
	});
	expect(login.ok()).toBeTruthy();
	const csrf =
		(await bobCtx.storageState()).cookies.find((c) => c.name === "tasuki_csrf")
			?.value ?? "";
	const tok = await bobCtx.request.post("/api/v1/me/tokens", {
		headers: { "x-tasuki-csrf": csrf },
		data: { name: "ai", scopes: ["read", "write"] },
	});
	const token = ((await tok.json()) as { token: string }).token;
	const proj = (await api(page, "GET", `/projects/${KEY}`)) as {
		statuses: { id: string; category: string }[];
	};
	const ready = proj.statuses.find((s) => s.category === "ready")?.id;

	// the admin watches the app while the AI works
	await page.goto(`/p/${KEY}`);
	const bell = page.getByRole("button", { name: /^通知(: |$)/ });

	const auth = { authorization: `Bearer ${token}` };
	await anon.post(`/api/v1/issues/${issue.ref}/move`, {
		headers: auth,
		data: { statusId: ready },
	});
	const rpc = await anon.post("/mcp", {
		headers: { ...auth, accept: "application/json, text/event-stream" },
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "submit_plan",
				arguments: {
					ref: issue.ref,
					understandingMd: "通知を確かめる",
					stepsMd: "1. 提出する",
					criteria: [{ text: "通知が届く" }],
					mapping: [{ index: 0, stepRef: "1" }],
				},
			},
		},
	});
	expect(rpc.ok()).toBeTruthy();

	// pushed over SSE: no reload
	await expect(bell).toHaveAccessibleName(/未読/);
	await bell.click();
	await expect(page.getByText("計画が提出されました")).toBeVisible();
	await page
		.getByRole("dialog", { name: "通知" })
		.getByRole("button", { name: /通知のテスト用チケット/ })
		.click();
	await expect(page).toHaveURL(new RegExp(`issue=${issue.ref}`));
	await page.getByRole("button", { name: "計画を承認する" }).click();
	await expect(
		page.getByRole("button", { name: "計画を承認する" }),
	).toHaveCount(0);
	await expect(bell).not.toHaveAccessibleName(/未読/);
	await bobCtx.close();
	await anon.dispose();
	expect(ADMIN.email).toBeTruthy();
});
