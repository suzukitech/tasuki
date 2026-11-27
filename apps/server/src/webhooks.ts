import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
	type IssueEvent,
	testText,
	webhookTargets,
	webhookText,
} from "@tasuki/core";
import type { Db } from "@tasuki/db";

export type Sent =
	| { ok: true }
	| { ok: false; reason: "blocked" | "timeout" | "http" | "network" };

const v4 = (ip: string) =>
	ip.split(".").map(Number) as [number, number, number, number];

function privateV4(ip: string) {
	const [a, b] = v4(ip);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 || // multicast + reserved + broadcast
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || b === 0)) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

/** Eight 16-bit groups of an IPv6 literal. */
function groups(ip: string) {
	const [head = "", tail] = ip.toLowerCase().split("::");
	const parts = (s: string) => (s ? s.split(":") : []);
	let h = parts(head);
	let t = tail === undefined ? [] : parts(tail);
	// a trailing dotted IPv4 counts as two groups
	const fix = (g: string[]) =>
		g.flatMap((x) => {
			if (!x.includes(".")) return [x];
			const [a, b, c, d] = v4(x);
			return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
		});
	h = fix(h);
	t = fix(t);
	const mid =
		tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
	return [...h, ...mid, ...t].map((x) => Number.parseInt(x, 16));
}

/** True for addresses a webhook must never reach: loopback, private, link-local, metadata, mapped/embedded v4. */
export function isPrivateIp(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return privateV4(ip);
	if (kind !== 6) return true; // not an address at all: refuse
	const g = groups(ip);
	const embedded = (hi: number, lo: number) =>
		`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
		return privateV4(embedded(g[6] ?? 0, g[7] ?? 0)); // ::ffff:a.b.c.d, ::a.b.c.d, ::, ::1
	if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
	if (g[0] === 0x2002) return privateV4(embedded(g[1] ?? 0, g[2] ?? 0)); // 6to4
	const top = g[0] ?? 0;
	return (
		(top & 0xfe00) === 0xfc00 || // unique local
		(top & 0xffc0) === 0xfe80 || // link-local
		(top & 0xff00) === 0xff00 // multicast
	);
}

type Opts = {
	baseUrl: string;
	allowPrivate?: boolean;
	fetch?: typeof fetch;
	/** every address the host resolves to */
	lookup?: (host: string) => Promise<string[]>;
	retryMs?: number;
	/** extra TLS options for https deliveries (tests: a private CA) */
	tls?: Record<string, unknown>;
};

export function createWebhooks(db: Db, o: Opts) {
	const doFetch = o.fetch ?? fetch;
	const resolve =
		o.lookup ??
		(async (h: string) =>
			(await lookup(h, { all: true })).map((a) => a.address));

	/**
	 * One POST, pinned to the address that was checked. The host is resolved here, every
	 * address must be public (unless private is allowed), and the connection then goes to that
	 * IP literal itself, so a second DNS answer (rebinding) can never redirect it. http sends the
	 * original `Host`; https also sets the TLS server name, so the certificate is still verified
	 * against the real host name.
	 */
	async function post(url: string, text: string): Promise<Sent> {
		try {
			const u = new URL(url);
			if (u.protocol !== "http:" && u.protocol !== "https:")
				return { ok: false, reason: "blocked" };
			const name = u.hostname.replace(/^\[|\]$/g, "");
			const addrs = await resolve(name);
			if (!addrs.length || (!o.allowPrivate && addrs.some(isPrivateIp)))
				return { ok: false, reason: "blocked" };
			const ip = addrs[0] as string;
			const literal = isIP(name) !== 0;
			const pinned = new URL(url);
			pinned.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
			const res = await doFetch(pinned.href, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					host: u.host,
				},
				body: JSON.stringify({ text }),
				redirect: "manual",
				signal: AbortSignal.timeout(5000),
				...(u.protocol === "https:" && {
					tls: { ...o.tls, ...(!literal && { serverName: name }) },
				}),
			} as RequestInit);
			await res.body?.cancel().catch(() => {});
			return res.status >= 200 && res.status < 300
				? { ok: true }
				: { ok: false, reason: "http" };
		} catch (e) {
			return {
				ok: false,
				reason: (e as Error)?.name === "TimeoutError" ? "timeout" : "network",
			};
		}
	}

	async function deliver(id: string, url: string, text: string) {
		let r = await post(url, text);
		// one retry, only for what may be transient
		if (!r.ok && (r.reason === "network" || r.reason === "timeout")) {
			await new Promise((d) => setTimeout(d, o.retryMs ?? 1000));
			r = await post(url, text);
		}
		// the id only: the URL is a secret and must never reach a log
		if (!r.ok) console.error(`webhook ${id} delivery failed: ${r.reason}`);
	}

	return {
		/** Fire-and-forget: never throws, never delays the caller. Call after commit. */
		dispatch(e: IssueEvent) {
			try {
				const targets = webhookTargets(db, e);
				if (!targets.length) return;
				const text = webhookText(db, e, o.baseUrl);
				if (!text) return;
				for (const w of targets) void deliver(w.id, w.url, text);
			} catch {
				console.error("webhook dispatch failed");
			}
		},
		/**
		 * Test-send result for the settings screen. Deliberately coarse: only ok, refused
		 * address, or failed. Timeout vs refused vs HTTP status would let a manager probe
		 * internal hosts, and the response itself is never read or returned.
		 */
		async test(
			url: string,
		): Promise<{ ok: true } | { ok: false; reason: "blocked" | "failed" }> {
			const r = await post(url, testText());
			return r.ok
				? { ok: true }
				: { ok: false, reason: r.reason === "blocked" ? "blocked" : "failed" };
		},
	};
}
