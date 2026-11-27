import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
	type IssueEvent,
	testText,
	webhookTargets,
	webhookText,
} from "@tasuki/core";
import type { Db } from "@tasuki/db";

/** "retry" = may be transient (network, timeout, DNS); "failed" = the peer answered non-2xx. */
export type Sent =
	| { ok: true }
	| { ok: false; reason: "blocked" | "retry" | "failed" };

// Addresses a webhook must never reach. IPv6 forms that embed an IPv4 address (mapped,
// translated, NAT64, 6to4, Teredo) are blocked whole instead of unpacking them.
// Separate lists per family: a v6 ::ffff:0:0/96 rule would otherwise match every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, len] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12],
	["192.0.0.0", 16],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3], // multicast + reserved + broadcast
] as const)
	blocked4.addSubnet(net, len, "ipv4");
for (const [net, len] of [
	["::", 96], // unspecified, loopback, v4-compatible
	["::ffff:0:0", 96], // IPv4-mapped
	["::ffff:0:0:0", 96], // IPv4-translated
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48],
	["2001::", 32], // Teredo
	["2002::", 16], // 6to4
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["ff00::", 8], // multicast
] as const)
	blocked6.addSubnet(net, len, "ipv6");

/** True for addresses a webhook must never reach. */
export function isPrivateIp(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return blocked4.check(ip, "ipv4");
	return kind !== 6 || blocked6.check(ip, "ipv6");
}

/** Module-level so tests can shorten them. */
export const timing = { retryMs: 1000, timeoutMs: 5000 };

type Opts = {
	baseUrl: string;
	allowPrivate?: boolean;
	fetch?: typeof fetch;
	/** every address the host resolves to */
	lookup?: (host: string) => Promise<string[]>;
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
			let timer: ReturnType<typeof setTimeout> | undefined;
			const addrs = await Promise.race([
				resolve(name),
				new Promise<never>((_, rej) => {
					timer = setTimeout(
						() => rej(new Error("dns timeout")),
						timing.timeoutMs,
					);
				}),
			]).finally(() => clearTimeout(timer));
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
				signal: AbortSignal.timeout(timing.timeoutMs),
				...(u.protocol === "https:" && {
					tls: { ...o.tls, ...(!literal && { serverName: name }) },
				}),
			} as RequestInit);
			await res.body?.cancel().catch(() => {});
			return res.status >= 200 && res.status < 300
				? { ok: true }
				: { ok: false, reason: "failed" };
		} catch {
			return { ok: false, reason: "retry" };
		}
	}

	async function deliver(id: string, url: string, text: string) {
		let r = await post(url, text);
		// one retry, only for what may be transient
		if (!r.ok && r.reason === "retry") {
			await new Promise((d) => setTimeout(d, timing.retryMs));
			r = await post(url, text);
		}
		// the id only: the URL is a secret and must never reach a log
		if (!r.ok) console.error(`webhook ${id} delivery failed`);
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
