import {
	apiTokens,
	type Conn,
	type Db,
	invites,
	sessions,
	users,
} from "@tasuki/db";
import { registerInput, tokenInput } from "@tasuki/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { type Actor, type Ctx, fail, nowOf, parse } from "./ctx";
import { requireAdmin, requireSession } from "./permissions";

const DAY = 86_400_000;

export const hashPassword = (pw: string) =>
	Bun.password.hash(pw, { algorithm: "argon2id" });
export const verifyPassword = (pw: string, hash: string) =>
	Bun.password.verify(pw, hash);

export const sha256 = (s: string) =>
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

/** Email + password → `{ session, user }` (session = the plaintext cookie value), or null. */
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
	return { session: createSession(db, u.id, clock), user: meOf(u) };
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

export const needsSetup = (db: Db) =>
	(db.select({ n: count() }).from(users).get()?.n ?? 0) === 0;

const meOf = (u: typeof users.$inferSelect) => ({
	id: u.id,
	email: u.email,
	name: u.name,
	role: u.role,
	locale: u.locale,
});

/** The signed-in user (never includes the password hash). */
export function getMe(ctx: Ctx) {
	const u = ctx.db
		.select()
		.from(users)
		.where(eq(users.id, ctx.actor.userId))
		.get();
	if (!u) return fail("not_found", "user not found");
	return meOf(u);
}

export function destroySession(db: Db, plaintext: string) {
	db.delete(sessions)
		.where(eq(sessions.tokenHash, sha256(plaintext)))
		.run();
}

/** The caller's tokens (metadata only: the plaintext is unrecoverable). */
export function listApiTokens(ctx: Ctx) {
	requireSession(ctx, "listing access tokens");
	return ctx.db
		.select({
			id: apiTokens.id,
			name: apiTokens.name,
			scopes: apiTokens.scopes,
			projectIds: apiTokens.projectIds,
			lastUsedAt: apiTokens.lastUsedAt,
			expiresAt: apiTokens.expiresAt,
			revokedAt: apiTokens.revokedAt,
			createdAt: apiTokens.createdAt,
		})
		.from(apiTokens)
		.where(eq(apiTokens.userId, ctx.actor.userId))
		.all();
}

/** Revokes one of the caller's tokens; returns its hash (to close that token's live streams). */
export function revokeApiToken(ctx: Ctx, id: string) {
	requireSession(ctx, "revoking an access token");
	const r = ctx.db
		.update(apiTokens)
		.set({ revokedAt: nowOf(ctx) })
		.where(
			and(
				eq(apiTokens.id, id),
				eq(apiTokens.userId, ctx.actor.userId),
				isNull(apiTokens.revokedAt),
			),
		)
		.returning({ hash: apiTokens.tokenHash })
		.get();
	return r?.hash ?? fail("not_found", "token not found");
}

/** Is the session / token with this sha256 still usable (exists, not revoked, not expired)? */
export function credentialAlive(
	db: Conn,
	kind: "session" | "token",
	hash: string,
	clock: Pick<Ctx, "now"> = {},
) {
	const now = nowOf(clock);
	if (kind === "session") {
		const s = db
			.select()
			.from(sessions)
			.where(eq(sessions.tokenHash, hash))
			.get();
		return !!s && s.expiresAt > now;
	}
	const t = db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, hash))
		.get();
	return !!t && !t.revokedAt && !(t.expiresAt && t.expiresAt <= now);
}
