import type { APIRequestContext, Page } from "@playwright/test";

export const ADMIN = {
	email: "admin@example.com",
	password: "e2e-password-123",
	name: "管理者",
};
export const BOB = {
	email: "bob@example.com",
	password: "bob-password-123",
	name: "ボブ",
};

const csrfOf = async (r: APIRequestContext) =>
	(await r.storageState()).cookies.find((c) => c.name === "tasuki_csrf")
		?.value ?? "";

/** JSON call as the signed-in browser user (cookie + CSRF header). */
export async function api(
	page: Page,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	data?: unknown,
) {
	const r = page.context().request;
	const res = await r.fetch(`/api/v1${path}`, {
		method,
		headers: { "x-tasuki-csrf": await csrfOf(r) },
		data,
	});
	if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()}`);
	return res.status() === 204 ? undefined : res.json();
}
