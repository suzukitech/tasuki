import { expect, test } from "@playwright/test";
import { ADMIN } from "./helpers";

test("first run: create the admin, then log in", async ({ page }) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/(setup|login)/);
	if (page.url().includes("/login")) await page.goto("/setup");
	await page.getByLabel("表示名").fill(ADMIN.name);
	await page.getByLabel("メールアドレス").fill(ADMIN.email);
	await page.getByLabel("パスワード").fill(ADMIN.password);
	await page.getByRole("button", { name: "管理者を作る" }).click();

	// setup signs the admin in; log out to prove the login form works too
	await page.getByRole("button", { name: "ログアウト" }).click();
	await page.waitForURL(/\/login/);
	await page.getByLabel("メールアドレス").fill(ADMIN.email);
	await page.getByLabel("パスワード").fill(ADMIN.password);
	await page.getByRole("button", { name: "ログインする" }).click();
	await expect(page.getByRole("button", { name: /コマンド/ })).toBeVisible();
	await page.context().storageState({ path: "e2e/.auth/admin.json" });
});
