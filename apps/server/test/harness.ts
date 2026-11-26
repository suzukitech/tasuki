import { setMember } from "@tasuki/core";
import { openDb } from "@tasuki/db";
import { createApp } from "../src/app";

export const PW = "password123";

type Init = {
	body?: unknown;
	cookie?: string;
	csrf?: string;
	bearer?: string;
	headers?: Record<string, string>;
};

/** App over an in-memory db with a request helper. */
export function harness(opts: { baseUrl?: string; rateLimit?: number } = {}) {
	const db = openDb(":memory:");
	const app = createApp(db, {
		baseUrl: opts.baseUrl ?? "http://localhost:3000",
		rateLimit: opts.rateLimit,
	});
	const call = (method: string, path: string, i: Init = {}) =>
		app.request(`/api/v1${path}`, {
			method,
			headers: {
				...(i.body !== undefined && { "content-type": "application/json" }),
				...(i.cookie && { cookie: i.cookie }),
				...(i.csrf && { "x-tasuki-csrf": i.csrf }),
				...(i.bearer && { authorization: `Bearer ${i.bearer}` }),
				...i.headers,
			},
			body: i.body === undefined ? undefined : JSON.stringify(i.body),
		});

	/** Log in and return a request helper that sends the session cookie + CSRF header. */
	const signIn = async (email: string, password = PW) => {
		const res = await call("POST", "/auth/login", {
			body: { email, password },
		});
		const set = res.headers.getSetCookie();
		const val = (n: string) =>
			set
				.find((s) => s.startsWith(`${n}=`))
				?.split(";")[0]
				?.split("=")[1] ?? "";
		const cookie = `tasuki_session=${val("tasuki_session")}; tasuki_csrf=${val("tasuki_csrf")}`;
		const csrf = val("tasuki_csrf");
		return {
			res,
			cookie,
			csrf,
			req: (
				method: string,
				path: string,
				body?: unknown,
				headers?: Record<string, string>,
			) => call(method, path, { body, cookie, csrf, headers }),
		};
	};
	const setup = async () => {
		await call("POST", "/setup", {
			body: { email: "admin@example.com", name: "Admin", password: PW },
		});
		return signIn("admin@example.com");
	};
	/** Invite + accept + login a plain member; returns their id too. */
	const addUser = async (
		admin: Awaited<ReturnType<typeof signIn>>,
		name: string,
	) => {
		const inv = await (await admin.req("POST", "/invites")).json();
		const u = await (
			await call("POST", "/invites/accept", {
				body: {
					token: inv.token,
					email: `${name}@example.com`,
					name,
					password: PW,
				},
			})
		).json();
		return { id: u.id as string, ...(await signIn(`${name}@example.com`)) };
	};
	const member = async (
		admin: Awaited<ReturnType<typeof signIn>>,
		userId: string,
		key: string,
		role: "member" | "viewer" = "member",
	) => {
		const me = await (await admin.req("GET", "/me")).json();
		setMember(
			{ db, actor: { userId: me.id, via: "web", auth: "session" } },
			key,
			userId,
			role,
		);
	};
	return { db, app, call, signIn, setup, addUser, member };
}
