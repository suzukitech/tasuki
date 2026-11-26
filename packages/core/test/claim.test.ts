import { expect, test } from "bun:test";
import { agentSessions, statuses } from "@tasuki/db";
import {
	answerQuestion,
	askQuestion,
	claimNext,
	extendLockIfHeld,
	getAnswers,
	getIssue,
	moveIssue,
	rejectPlan,
	submitPlan,
	type TasukiError,
} from "../src/index";
import { setup } from "./fixture";

const PLAN = { understandingMd: "u", stepsMd: "s" };

function world() {
	const w = setup();
	const ready = w.db
		.select()
		.from(statuses)
		.all()
		.find((s) => s.category === "ready" && s.projectId === w.project.id)
		?.id as string;
	const mk = (input: Record<string, unknown>) => {
		const i = w.issue({ assigneeId: w.u.mem.id, ...input });
		moveIssue(w.ctx(w.u.mem), i.ref, { statusId: ready });
		return i.ref;
	};
	return { ...w, mk };
}

test("claimNext: priority desc, then oldest; takes the lock, no status change", () => {
	const w = world();
	const tok = w.ctx(w.u.mem, "token");
	w.mk({ title: "old low", priority: 1 });
	w.mk({ title: "none" });
	const hi = w.mk({ title: "high", priority: 3 });
	w.mk({ title: "high newer", priority: 3 });
	const r = claimNext(tok);
	expect(r?.ref).toBe(hi);
	expect(getIssue(tok, hi).category).toBe("ready");
	expect(w.db.select().from(agentSessions).all()).toHaveLength(1);
	expect(claimNext(tok)?.ref).toBe(hi); // idempotent: same open lock
});

test("claimNext: an already-held lock on an eligible issue wins over a higher-priority one", () => {
	const w = world();
	const tok = w.ctx(w.u.mem, "token");
	const low = w.mk({ title: "low", priority: 1 });
	expect(claimNext(tok)?.ref).toBe(low);
	const hi = w.mk({ title: "high", priority: 4 });
	expect(claimNext(tok)?.ref).toBe(low); // keeps the held one, no second lock
	expect(w.db.select().from(agentSessions).all()).toHaveLength(1);
	expect(hi).not.toBe(low);
});

test("extendLockIfHeld: extends own lock; null for no lock / bad ref / read-only token", () => {
	const w = world();
	const ref = w.mk({ title: "a" });
	const tok = w.ctx(w.u.mem, "token");
	expect(extendLockIfHeld(tok, ref)).toBeNull(); // no lock yet
	claimNext(tok);
	w.clock.t = new Date(w.clock.t.getTime() + 10 * 60_000);
	expect(extendLockIfHeld(tok, ref)?.expiresAt.getTime()).toBe(
		w.clock.t.getTime() + 30 * 60_000,
	);
	expect(extendLockIfHeld(tok, "nope")).toBeNull();
	expect(extendLockIfHeld(w.ctx(w.u.mem2, "token"), ref)).toBeNull(); // not theirs
	const ro = w.ctx(w.u.mem, "token", { scopes: ["read"], projectIds: null });
	expect(extendLockIfHeld(ro, ref)).toBeNull();
	w.clock.t = new Date(w.clock.t.getTime() + 31 * 60_000);
	expect(extendLockIfHeld(tok, ref)).toBeNull(); // expired
});

test("claimNext: skips issues locked by others, none -> null, needs write scope", () => {
	const w = world();
	w.mk({ title: "a" });
	const other = w.ctx(w.u.mem2, "token");
	expect(claimNext(other)).toBeNull(); // not assigned to mem2
	const mem = w.ctx(w.u.mem, "token");
	claimNext(mem);
	w.db.update(agentSessions).set({ userId: w.u.mem2.id }).run();
	expect(claimNext(mem)).toBeNull();
	const ro = w.ctx(w.u.mem, "token", { scopes: ["read"], projectIds: null });
	expect(
		(() => {
			try {
				claimNext(ro);
			} catch (e) {
				return (e as TasukiError).code;
			}
		})(),
	).toBe("forbidden");
});

test("claimNext skips projects the token cannot reach", () => {
	const w = world();
	w.mk({ title: "a" });
	const t = w.ctx(w.u.mem, "token", {
		scopes: ["write"],
		projectIds: ["other"],
	});
	expect(claimNext(t)).toBeNull();
});

test("getAnswers: answers to own questions and plan rejection", () => {
	const w = world();
	const ref = w.mk({ title: "a" });
	const tok = w.ctx(w.u.mem, "token");
	const human = w.ctx(w.u.mem);
	const q = askQuestion(tok, ref, "which db?");
	expect(getAnswers(tok, ref).questions[0]?.answer).toBeNull();
	answerQuestion(human, q.id, "sqlite");
	submitPlan(tok, ref, PLAN);
	rejectPlan(human, ref, "too vague");
	const a = getAnswers(tok, ref);
	expect(a.questions[0]).toMatchObject({ state: "answered", answer: "sqlite" });
	expect(a.planRejection).toEqual({ version: 1, note: "too vague" });
	expect(a.reportReturn).toBeNull();
});
