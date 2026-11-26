import { type Ctx, requireProjectRole } from "@tasuki/core";

export type IssueEvent = {
	type: string;
	projectId: string;
	ref: string;
	at: string;
};

const canRead = (ctx: Ctx, projectId: string) => {
	try {
		requireProjectRole(ctx, projectId, "viewer");
		return true;
	} catch {
		return false;
	}
};

/**
 * In-process pub/sub. Permission is re-checked per event, so a revoked member stops receiving.
 * ponytail: single-process only; multiple server instances would need a shared bus.
 */
export function createEvents() {
	const subs = new Set<{ ctx: Ctx; send: (e: IssueEvent) => void }>();
	return {
		subscribe(ctx: Ctx, send: (e: IssueEvent) => void) {
			const sub = { ctx, send };
			subs.add(sub);
			return () => void subs.delete(sub);
		},
		publish(type: string, projectId: string, ref: string) {
			const e = { type, projectId, ref, at: new Date().toISOString() };
			for (const s of subs) if (canRead(s.ctx, projectId)) s.send(e);
		},
	};
}
