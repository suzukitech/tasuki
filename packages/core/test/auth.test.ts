import { describe, expect, test } from "bun:test";
import { apiTokens, invites, openDb, sessions, users } from "@tasuki/db";
import {
	acceptInvite,
	createApiToken,
	createInvite,
	createSession,
	getIssue,
	hashPassword,
	login,
	resolveSession,
	resolveToken,
	setupFirstAdmin,
	type TasukiError,
	verifyPassword,
} from "../src/index";
import { setup } from "./fixture";

const codeOf = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		return (e as TasukiError).code;
	}
};

test("password hashing is argon2id", async () => {
	const h = await hashPassword("secret-pass");
	expect(h.startsWith("$argon2id$")).toBe(true);
	expect(await verifyPassword("secret-pass", h)).toBe(true);
	expect(await verifyPassword("nope", h)).toBe(false);
});

describe("api tokens", () => {
	test("plaintext never stored; resolve; revoke/expire; scopes drive permissions", () => {
		const { db, ctx, u, issue, clock } = setup();
		issue();
		const { token, id } = createApiToken(ctx(u.mem), {
			name: "cc",
			scopes: ["read"],
		});
		expect(token.startsWith("tsk_")).toBe(true);
		expect(token.length).toBeGreaterThanOrEqual(47);
		const row = db.select().from(apiTokens).get();
		expect(JSON.stringify(row)).not.toContain(token);
		expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		const actor = resolveToken(db, token, "mcp:claude", { now: () => clock.t });
		expect(actor).toMatchObject({
			userId: u.mem.id,
			via: "mcp:claude",
			auth: "token",
			token: { scopes: ["read"], projectIds: null },
		});
		expect(db.select().from(apiTokens).get()?.lastUsedAt).toEqual(clock.t);
		expect(getIssue({ db, actor: actor as never }, "WEB-1").issue.number).toBe(
			1,
		);
		expect(resolveToken(db, "tsk_wrong")).toBeNull();
		db.update(apiTokens).set({ revokedAt: clock.t }).run();
		expect(resolveToken(db, token)).toBeNull();
		db.update(apiTokens)
			.set({ revokedAt: null, expiresAt: new Date(clock.t.getTime() - 1) })
			.run();
		expect(
			resolveToken(db, token, undefined, { now: () => clock.t }),
		).toBeNull();
		const r = createApiToken(ctx(u.mem), {
			name: "p",
			scopes: ["write"],
			projectIds: ["x"],
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(
			resolveToken(db, r.token, undefined, { now: () => clock.t })?.token
				?.projectIds,
		).toEqual(["x"]);
		expect(id).toBeTruthy();
	});
	test("a token cannot mint tokens", async () => {
		const { ctx, u } = setup();
		expect(
			await codeOf(() =>
				createApiToken(ctx(u.mem, "token"), { name: "x", scopes: ["read"] }),
			),
		).toBe("gate");
		expect(
			await codeOf(() => createApiToken(ctx(u.mem), { name: "x", scopes: [] })),
		).toBe("invalid");
	});
	test("token expiresAt: future ISO string only", async () => {
		const { ctx, u } = setup();
		const mk = (expiresAt: unknown) =>
			codeOf(() =>
				createApiToken(ctx(u.mem), {
					name: "x",
					scopes: ["read"],
					expiresAt,
				} as never),
			);
		expect(await mk(Date.now() + 60_000)).toBe("invalid"); // number
		expect(await mk(new Date(Date.now() + 60_000))).toBe("invalid"); // Date object
		expect(await mk(new Date(Date.now() - 1000).toISOString())).toBe("invalid"); // past
		expect(await mk("not a date")).toBe("invalid");
		expect(
			await mk(new Date(Date.now() + 60_000).toISOString()),
		).toBeUndefined();
		expect(await mk(null)).toBeUndefined();
	});
});

describe("sessions, invites, setup", () => {
	test("login + session", async () => {
		const { clock } = setup();
		const db = openDb(":memory:");
		const admin = await setupFirstAdmin(db, {
			email: "Root@Example.com",
			name: "Root",
			password: "password1",
		});
		expect(admin).toMatchObject({ email: "root@example.com", role: "admin" });
		expect(
			await codeOf(() =>
				setupFirstAdmin(db, {
					email: "b@example.com",
					name: "B",
					password: "password1",
				}),
			),
		).toBe("conflict");
		const clk = { now: () => clock.t };
		expect(await login(db, "root@example.com", "bad", clk)).toBeNull();
		expect(await login(db, "nobody@example.com", "password1", clk)).toBeNull();
		const r = await login(db, " ROOT@example.com", "password1", clk);
		expect(r?.user).toMatchObject({ email: "root@example.com" });
		const s = r?.session as string;
		expect(JSON.stringify(db.select().from(sessions).get())).not.toContain(s);
		expect(resolveSession(db, s, clk)).toEqual({
			userId: admin.id,
			via: "web",
			auth: "session",
		});
		expect(resolveSession(db, "bogus", clk)).toBeNull();
		clock.t = new Date(clock.t.getTime() + 31 * 86_400_000);
		expect(resolveSession(db, s, clk)).toBeNull();
		expect(createSession(db, admin.id)).toBeTruthy();
	});
	test("invite: admin + session only, 7 days, single use, lowercased email", async () => {
		const { db, ctx, u, clock } = setup();
		expect(await codeOf(() => createInvite(ctx(u.mgr)))).toBe("forbidden");
		expect(await codeOf(() => createInvite(ctx(u.admin, "token")))).toBe(
			"gate",
		);
		const { token, expiresAt } = createInvite(ctx(u.admin));
		expect(expiresAt.getTime() - clock.t.getTime()).toBe(7 * 86_400_000);
		expect(JSON.stringify(db.select().from(invites).get())).not.toContain(
			token,
		);
		const input = {
			email: "New@Example.com",
			name: "New",
			password: "password1",
		};
		expect(
			await codeOf(() =>
				acceptInvite(db, token, { ...input, password: "short" }),
			),
		).toBe("invalid");
		const user = await acceptInvite(db, token, input, { now: () => clock.t });
		expect(user).toMatchObject({ email: "new@example.com", role: "member" });
		expect(await verifyPassword("password1", user.passwordHash)).toBe(true);
		expect(await codeOf(() => acceptInvite(db, token, input))).toBe("invalid"); // used
		expect(await codeOf(() => acceptInvite(db, "bogus", input))).toBe(
			"invalid",
		);
		// duplicate email rolls the invite back (still usable)
		const t2 = createInvite(ctx(u.admin)).token;
		expect(
			await codeOf(() => acceptInvite(db, t2, input, { now: () => clock.t })),
		).toBe("conflict");
		expect(
			db
				.select()
				.from(invites)
				.all()
				.filter((i) => !i.usedAt),
		).toHaveLength(1);
		// expired
		const t3 = createInvite(ctx(u.admin)).token;
		expect(
			await codeOf(() =>
				acceptInvite(
					db,
					t3,
					{ ...input, email: "z@example.com" },
					{ now: () => new Date(clock.t.getTime() + 8 * 86_400_000) },
				),
			),
		).toBe("invalid");
		expect(db.select().from(users).all().length).toBeGreaterThan(6);
	});
});
