import {
	type Ctx,
	credentialAlive,
	type IssueEvent,
	requireProjectRole,
} from "@tasuki/core";

type Cred = { kind: "session" | "token"; hash: string };
type Sub = {
	ctx: Ctx;
	cred: Cred;
	send: (e: IssueEvent & { at: string }) => unknown;
	close: () => void;
	/** key (projectId or "cred") -> verdict, valid until `until` */
	cache: Map<string, { ok: boolean; until: number }>;
};

const TTL = 30_000;
const MAX_STREAMS_PER_USER = 5;

const canRead = (ctx: Ctx, projectId: string) => {
	try {
		requireProjectRole(ctx, projectId, "viewer");
		return true;
	} catch {
		return false;
	}
};

/**
 * In-process pub/sub.
 * ponytail: permission and credential verdicts are cached 30s per subscriber, so a revoked
 * member / credential keeps receiving for up to 30s (logout and token revoke close at once
 * via `drop`). Single-process only; multiple instances would need a shared bus.
 */
export function createEvents() {
	const subs = new Set<Sub>();
	const kill = (s: Sub) => {
		subs.delete(s);
		s.close();
	};
	const cached = (s: Sub, key: string, check: () => boolean) => {
		const hit = s.cache.get(key);
		if (hit && hit.until > Date.now()) return hit.ok;
		const ok = check();
		s.cache.set(key, { ok, until: Date.now() + TTL });
		return ok;
	};
	const alive = (s: Sub) => credentialAlive(s.ctx.db, s.cred.kind, s.cred.hash);

	return {
		/** null when the user already holds the maximum number of streams. */
		subscribe(ctx: Ctx, cred: Cred, send: Sub["send"], close: Sub["close"]) {
			let n = 0;
			for (const s of subs) if (s.ctx.actor.userId === ctx.actor.userId) n++;
			if (n >= MAX_STREAMS_PER_USER) return null;
			const sub: Sub = { ctx, cred, send, close, cache: new Map() };
			subs.add(sub);
			return {
				off: () => void subs.delete(sub),
				/** Heartbeat check: closes the stream and returns false if the credential died. */
				ok() {
					if (alive(sub)) return true;
					kill(sub);
					return false;
				},
			};
		},
		publish(e: IssueEvent) {
			const ev = { ...e, at: new Date().toISOString() };
			for (const s of [...subs]) {
				if (!cached(s, "cred", () => alive(s))) {
					kill(s);
					continue;
				}
				if (!cached(s, e.projectId, () => canRead(s.ctx, e.projectId)))
					continue;
				try {
					// a failed write (sync throw or async rejection) drops the subscriber
					Promise.resolve(s.send(ev)).catch(() => kill(s));
				} catch {
					kill(s);
				}
			}
		},
		/** Logout / token revoke: close every stream opened with this credential now. */
		drop(hash: string) {
			for (const s of [...subs]) if (s.cred.hash === hash) kill(s);
		},
	};
}
