import { apiTokens, type Db, invites, sessions, users } from "@tasuki/db";
import { registerInput, tokenInput } from "@tasuki/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { type Actor, type Ctx, fail, nowOf, parse } from "./ctx";
import { requireAdmin, requireSession } from "./permissions";

const DAY = 86_400_000;

export const hashPassword = (pw: string) =>
	Bun.password.hash(pw, { algorithm: "argon2id" });
export const verifyPassword = (pw: string, hash: string) =>
	Bun.password.verify(pw, hash);

const sha256 = (s: string) =>
	new Bun.CryptoHasher("sha256").update(s).digest("hex");
const randomToken = (prefix = "") =>
	prefix +
	Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Returns the plaintext token ONCE; only its sha256 is stored. HUMAN GATE (session only). */
export function createApiToken(ctx: Ctx, input: unknown) {
	requireSession(ctx, "issuing an access token");
	const inp = parse(tokenInput, input);
	const token = randomToken("tsk_");
	const row = ctx.db
		.insert(apiTokens)
		.values({
			userId: ctx.actor.userId,
			name: inp.name,
			tokenHash: sha256(token),
			scopes: JSON.stringify(inp.scopes),
			projectIds: inp.projectIds ? JSON.stringify(inp.projectIds) : null,
			expiresAt: inp.expiresAt ?? null,
			createdAt: nowOf(ctx),
		})
		.returning({ id: apiTokens.id })
		.get();
	return { id: row.id, token };
}

export function resolveToken(
	db: Db,
	plaintext: string,
	via = "mcp:unknown",
	clock: Pick<Ctx, "now"> = {},
): Actor | null {
	const now = nowOf(clock);
	const t = db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, sha256(plaintext)))
		.get();
	if (!t || t.revokedAt || (t.expiresAt && t.expiresAt <= now)) return null;
	if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > 60_000)
		db.update(apiTokens)
			.set({ lastUsedAt: now })
			.where(eq(apiTokens.id, t.id))
			.run();
	return {
		userId: t.userId,
		via,
		auth: "token",
		token: {
			scopes: JSON.parse(t.scopes),
			projectIds: t.projectIds ? JSON.parse(t.projectIds) : null,
		},
	};
}

/** New session; returns the plaintext cookie value. */
export function createSession(
	db: Db,
	userId: string,
	clock: Pick<Ctx, "now"> = {},
) {
	const now = nowOf(clock);
	const token = randomToken();
	db.insert(sessions)
		.values({
			userId,
			tokenHash: sha256(token),
			expiresAt: new Date(now.getTime() + 30 * DAY),
			createdAt: now,
		})
		.run();
	return token;
}

export function resolveSession(
	db: Db,
	plaintext: string,
	clock: Pick<Ctx, "now"> = {},
): Actor | null {
	const s = db
		.select()
		.from(sessions)
		.where(eq(sessions.tokenHash, sha256(plaintext)))
		.get();
	if (!s || s.expiresAt <= nowOf(clock)) return null;
	return { userId: s.userId, via: "web", auth: "session" };
}

/** Email + password → session token, or null. */
export async function login(
	db: Db,
	email: string,
	password: string,
	clock: Pick<Ctx, "now"> = {},
) {
	const u = db
		.select()
		.from(users)
		.where(eq(users.email, email.trim().toLowerCase()))
		.get();
	if (!u || !(await verifyPassword(password, u.passwordHash))) return null;
	return createSession(db, u.id, clock);
}

/** Admin issues a 7-day invite link token (plaintext returned once). */
export function createInvite(ctx: Ctx) {
	requireSession(ctx, "creating an invite");
	requireAdmin(ctx);
	const token = randomToken();
	const expiresAt = new Date(nowOf(ctx).getTime() + 7 * DAY);
	ctx.db
		.insert(invites)
		.values({
			tokenHash: sha256(token),
			expiresAt,
			createdBy: ctx.actor.userId,
			createdAt: nowOf(ctx),
		})
		.run();
	return { token, expiresAt };
}

const insertUser = (
	db: Pick<Db, "insert">,
	inp: { email: string; name: string },
	passwordHash: string,
	extra: { role?: "admin"; createdAt?: Date } = {},
) =>
	db
		.insert(users)
		.values({ email: inp.email, name: inp.name, passwordHash, ...extra })
		.returning()
		.get();

export async function acceptInvite(
	db: Db,
	token: string,
	input: unknown,
	clock: Pick<Ctx, "now"> = {},
) {
	const inp = parse(registerInput, input);
	const passwordHash = await hashPassword(inp.password);
	return db.transaction((tx) => {
		const now = nowOf(clock);
		const used = tx
			.update(invites)
			.set({ usedAt: now })
			.where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.usedAt)))
			.returning()
			.get();
		if (!used || used.expiresAt <= now)
			return fail("invalid", "invite is invalid, used or expired");
		if (tx.select().from(users).where(eq(users.email, inp.email)).get())
			return fail("conflict", "email already registered");
		return insertUser(tx, inp, passwordHash, { createdAt: now });
	});
}

/** Only while the users table is empty. */
export async function setupFirstAdmin(db: Db, input: unknown) {
	const inp = parse(registerInput, input);
	const passwordHash = await hashPassword(inp.password);
	return db.transaction((tx) => {
		if ((tx.select({ n: count() }).from(users).get()?.n ?? 0) > 0)
			return fail("conflict", "setup already done");
		return insertUser(tx, inp, passwordHash, { role: "admin" });
	});
}
