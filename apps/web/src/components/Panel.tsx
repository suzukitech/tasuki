import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reviewerOf } from "@tasuki/schema/pure";
import { type ReactNode, useState } from "react";
import { type Key, t } from "../i18n";
import { api } from "../lib/api";
import { type CritDraft, criteriaBody, critsOf, shown } from "../lib/draft";
import { etagOf } from "../lib/etag";
import { PRIORITY_KEYS } from "../lib/priority";
import { refreshIssue, useIssue, useWriteFailure } from "../lib/queries";
import { turnOf } from "../lib/turn";
import type {
	Activity,
	IssueDetail,
	Me,
	ProjectDetail,
	Report,
} from "../lib/types";
import { Button, cx, inputCls, TurnBadge } from "./ui";

type Tab = "request" | "plan" | "report" | "thread";
const TABS: Tab[] = ["request", "plan", "report", "thread"];
/** Run a write against the open issue, refresh it, and toast failures (412 refetches everything). */
function useAct(ref: string) {
	const qc = useQueryClient();
	const fail = useWriteFailure();
	return useMutation({
		mutationFn: (f: () => Promise<unknown>) => f(),
		onError: fail,
		// returned, so per-call onSuccess runs after the refetch has landed
		onSettled: () => refreshIssue(qc, ref),
	});
}
type Act = ReturnType<typeof useAct>;

const H = ({ children }: { children: ReactNode }) => (
	<h3 className="mt-4 mb-1 text-sm font-bold text-nezumi">{children}</h3>
);
const Text = ({ children }: { children: string }) => (
	<p className="whitespace-pre-wrap">{children}</p>
);

/** Approver (or the requester when none is set), project manager, or admin: the same people the server lets through. */
const canReview = (d: IssueDetail, me: Me) =>
	me.role === "admin" ||
	d.project.role === "manager" ||
	me.id === reviewerOf(d.issue);

export function viaLabel(via: string): string {
	const known = `via.${via}` as Key;
	if (
		via === "web" ||
		via === "cli" ||
		via === "import" ||
		via === "mcp:claude-code"
	)
		return t(known);
	if (via.startsWith("mcp:")) return t("via.mcp", { client: via.slice(4) });
	return via;
}

function Who({
	id,
	via,
	project,
}: {
	id: string | null;
	via: string;
	project: ProjectDetail;
}) {
	const name =
		project.members.find((m) => m.id === id)?.name ?? t("unknown.user");
	return (
		<span className="font-bold">
			{name}
			<span
				className={cx(
					"ml-2 text-sm font-normal",
					via === "web" ? "text-nezumi" : "text-asagi",
				)}
			>
				{viaLabel(via)}
			</span>
		</span>
	);
}

function RequestTab({
	d,
	project,
}: {
	d: IssueDetail;
	project: ProjectDetail;
}) {
	const act = useAct(d.ref);
	const i = d.issue;
	// Drafts: undefined = untouched, so the field follows the server; typed text survives refetches.
	const [draft, setDraft] = useState<{
		title?: string;
		body?: string;
		crit?: CritDraft[];
	}>({});
	const title = shown(draft.title, i.title);
	const body = shown(draft.body, i.bodyMd);
	const crit = shown(draft.crit, critsOf(d.criteria));
	const setCrit = (c: CritDraft[]) => setDraft((x) => ({ ...x, crit: c }));
	const save = (patch: Record<string, unknown>, onSuccess?: () => void) =>
		act.mutate(
			() =>
				api("PATCH", `/issues/${d.ref}`, patch, {
					"if-match": etagOf(i.updatedAt),
				}),
			{ onSuccess },
		);
	const sel = "rounded border border-line bg-surface px-2 py-1 text-base";
	return (
		<div>
			<label className="block text-sm font-bold text-nezumi" htmlFor="f-title">
				{t("req.title")}
			</label>
			<input
				id="f-title"
				className={inputCls}
				value={title}
				onChange={(e) => setDraft((x) => ({ ...x, title: e.target.value }))}
			/>
			<label
				className="mt-3 block text-sm font-bold text-nezumi"
				htmlFor="f-body"
			>
				{t("req.body")}
			</label>
			<textarea
				id="f-body"
				rows={8}
				className={inputCls}
				value={body}
				onChange={(e) => setDraft((x) => ({ ...x, body: e.target.value }))}
			/>
			<Button
				kind="primary"
				className="mt-2"
				disabled={
					act.isPending ||
					!title.trim() ||
					(title === i.title && body === i.bodyMd)
				}
				onClick={() =>
					save({ title: title.trim(), bodyMd: body }, () =>
						setDraft((x) => ({
							...x,
							title: x.title === title ? undefined : x.title,
							body: x.body === body ? undefined : x.body,
						})),
					)
				}
			>
				{t("req.save")}
			</Button>

			<H>{t("req.fields")}</H>
			<div className="grid grid-cols-[6rem_1fr] items-center gap-2">
				<span>{t("col.assignee")}</span>
				<select
					className={sel}
					value={i.assigneeId ?? ""}
					onChange={(e) => save({ assigneeId: e.target.value || null })}
				>
					<option value="">{t("assignee.none")}</option>
					{project.members.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name}
						</option>
					))}
				</select>
				<span>{t("col.priority")}</span>
				<select
					className={sel}
					value={i.priority ?? 0}
					onChange={(e) => save({ priority: Number(e.target.value) })}
				>
					{PRIORITY_KEYS.map((k, n) => (
						<option key={k} value={n}>
							{t(k)}
						</option>
					))}
				</select>
				<span>{t("col.due")}</span>
				<input
					type="date"
					className={cx(sel, "num")}
					value={i.dueDate ?? ""}
					onChange={(e) => save({ dueDate: e.target.value || null })}
				/>
				<span>{t("req.flow")}</span>
				<input
					type="checkbox"
					className="justify-self-start"
					checked={i.flow === "ai"}
					onChange={(e) => save({ flow: e.target.checked ? "ai" : "simple" })}
				/>
			</div>

			<H>{t("req.criteria")}</H>
			{crit.length === 0 && (
				<p className="text-nezumi">{t("req.criteria.empty")}</p>
			)}
			<ul className="space-y-2">
				{crit.map((c, n) => (
					<li key={c.id ?? `new-${n}`} className="flex gap-2">
						<input
							className={inputCls}
							aria-label={t("req.criteria")}
							placeholder={t("req.criteria.placeholder")}
							value={c.text}
							onChange={(e) =>
								setCrit(
									crit.map((x, m) =>
										m === n ? { ...x, text: e.target.value } : x,
									),
								)
							}
						/>
						<Button onClick={() => setCrit(crit.filter((_, m) => m !== n))}>
							{t("req.criteria.remove")}
						</Button>
					</li>
				))}
			</ul>
			<div className="mt-2 flex gap-2">
				<Button onClick={() => setCrit([...crit, { id: undefined, text: "" }])}>
					{t("req.criteria.add")}
				</Button>
				<Button
					kind="primary"
					disabled={act.isPending}
					onClick={() =>
						act.mutate(
							() => api("PUT", `/issues/${d.ref}/criteria`, criteriaBody(crit)),
							// the refetched criteria (with their ids) replace the draft: a second save keeps the ids
							{
								onSuccess: () =>
									setDraft((x) =>
										x.crit === crit ? { ...x, crit: undefined } : x,
									),
							},
						)
					}
				>
					{t("req.criteria.save")}
				</Button>
			</div>
		</div>
	);
}

/** Reject / return with a mandatory note. */
function NoteAction(p: {
	label: string;
	placeholder: string;
	onSubmit: (note: string) => void;
	busy: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState("");
	if (!open)
		return (
			<Button kind="danger" onClick={() => setOpen(true)}>
				{p.label}
			</Button>
		);
	return (
		<div className="w-full">
			<textarea
				// biome-ignore lint/a11y/noAutofocus: opened by the user clicking the cell / button
				autoFocus
				rows={3}
				className={inputCls}
				aria-label={p.placeholder}
				placeholder={p.placeholder}
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			<div className="mt-2 flex gap-2">
				<Button
					kind="danger"
					disabled={p.busy || !note.trim()}
					onClick={() => p.onSubmit(note.trim())}
				>
					{p.label}
				</Button>
			</div>
			{!note.trim() && (
				<p className="mt-1 text-sm text-nezumi">{t("plan.note.required")}</p>
			)}
		</div>
	);
}

/** Approve / return block shared by the plan and report tabs (the human gates). */
function Gate(p: {
	act: Act;
	issueRef: string;
	approve: { label: string; path: string };
	reject: { label: string; placeholder: string; path: string };
}) {
	return (
		<div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
			<Button
				kind="primary"
				disabled={p.act.isPending}
				onClick={() =>
					p.act.mutate(() =>
						api("POST", `/issues/${p.issueRef}${p.approve.path}`),
					)
				}
			>
				{p.approve.label}
			</Button>
			<NoteAction
				label={p.reject.label}
				placeholder={p.reject.placeholder}
				busy={p.act.isPending}
				onSubmit={(note) =>
					p.act.mutate(() =>
						api("POST", `/issues/${p.issueRef}${p.reject.path}`, { note }),
					)
				}
			/>
		</div>
	);
}

function PlanTab({ d, me }: { d: IssueDetail; me: Me }) {
	const act = useAct(d.ref);
	const plan =
		[...d.plans].reverse().find((p) => p.state !== "superseded") ??
		d.plans.at(-1);
	if (!plan) return <p className="text-nezumi">{t("plan.none")}</p>;
	const stepOf = new Map(
		d.planCriteria
			.filter((m) => m.planId === plan.id)
			.map((m) => [m.criterionId, m.stepRef]),
	);
	const gate = d.category === "plan_review" && canReview(d, me);
	return (
		<div>
			<p className="text-sm text-nezumi">
				{t("plan.version", { n: plan.version })}
			</p>
			<H>{t("plan.understanding")}</H>
			<div className="rounded border border-line bg-paper p-3">
				<Text>{plan.understandingMd}</Text>
			</div>
			<div className="mt-4 grid gap-4 sm:grid-cols-2">
				<div>
					<H>{t("plan.criteria")}</H>
					<ul className="space-y-2">
						{d.criteria.map((c) => {
							const step = stepOf.get(c.id);
							return (
								<li key={c.id} className="border-b border-line pb-2">
									<Text>{c.text}</Text>
									{step ? (
										<p className="text-sm text-nezumi">{step}</p>
									) : (
										<p role="alert" className="text-sm font-bold text-sash">
											{t("plan.uncovered")}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				</div>
				<div>
					<H>{t("plan.steps")}</H>
					<Text>{plan.stepsMd}</Text>
				</div>
			</div>
			{plan.risksMd && (
				<>
					<H>{t("plan.risks")}</H>
					<Text>{plan.risksMd}</Text>
				</>
			)}
			{gate && (
				<Gate
					act={act}
					issueRef={d.ref}
					approve={{ label: t("plan.approve"), path: "/plan/approve" }}
					reject={{
						label: t("plan.reject"),
						placeholder: t("plan.note"),
						path: "/plan/reject",
					}}
				/>
			)}
		</div>
	);
}

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

function ReportTab({ d, me }: { d: IssueDetail; me: Me }) {
	const act = useAct(d.ref);
	const r: Report | undefined = d.reports.at(-1);
	if (!r) return <p className="text-nezumi">{t("report.none")}</p>;
	const gate = d.category === "impl_review" && canReview(d, me);
	return (
		<div>
			<H>{t("report.summary")}</H>
			<Text>{r.summaryMd}</Text>
			<H>{t("report.decisions")}</H>
			<Text>{r.decisionsMd}</Text>
			<H>{t("report.deviations")}</H>
			<Text>{r.deviationsMd || t("report.deviations.none")}</Text>
			<H>{t("report.criteria")}</H>
			<ul className="space-y-2">
				{d.criteria.map((c) => (
					<li key={c.id} className="border-b border-line pb-2">
						<Text>{c.text}</Text>
						<p
							className={cx(
								"text-sm font-bold",
								c.result === "met"
									? "text-asagi"
									: c.result === "pending"
										? "text-nezumi"
										: "text-sash",
							)}
						>
							{t(`result.${c.result}`)}
						</p>
						<p className="text-sm text-nezumi">
							{c.evidenceMd || t("result.noEvidence")}
						</p>
					</li>
				))}
			</ul>
			{r.testsMd && (
				<>
					<H>{t("report.tests")}</H>
					<Text>{r.testsMd}</Text>
				</>
			)}
			{r.prUrl && (
				<>
					<H>{t("report.pr")}</H>
					{safeUrl(r.prUrl) ? (
						<a
							className="text-ai-indigo underline"
							href={safeUrl(r.prUrl)}
							target="_blank"
							rel="noreferrer"
						>
							{r.prUrl}
						</a>
					) : (
						<Text>{r.prUrl}</Text>
					)}
				</>
			)}
			{gate && (
				<Gate
					act={act}
					issueRef={d.ref}
					approve={{ label: t("report.complete"), path: "/complete" }}
					reject={{
						label: t("report.return"),
						placeholder: t("report.note"),
						path: "/report/return",
					}}
				/>
			)}
		</div>
	);
}

function activityText(a: Activity): string {
	if (a.field)
		return a.before
			? t("act.change", {
					field: a.field,
					before: a.before,
					after: a.after ?? "",
				})
			: t("act.set", { field: a.field, after: a.after ?? "" });
	return t("act.other", { action: a.action });
}

function AnswerBox({
	id,
	onSubmit,
	busy,
}: {
	id: string;
	onSubmit: (id: string, text: string) => void;
	busy: boolean;
}) {
	const [text, setText] = useState("");
	return (
		<div className="mt-2">
			<textarea
				rows={2}
				className={inputCls}
				aria-label={t("thread.question.placeholder")}
				placeholder={t("thread.question.placeholder")}
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			<Button
				kind="primary"
				className="mt-1"
				disabled={busy || !text.trim()}
				onClick={() => onSubmit(id, text.trim())}
			>
				{t("thread.question.answer")}
			</Button>
		</div>
	);
}

function ThreadTab({ d, project }: { d: IssueDetail; project: ProjectDetail }) {
	const act = useAct(d.ref);
	const [text, setText] = useState("");
	const none = <p className="text-nezumi">{t("thread.empty")}</p>;
	return (
		<div>
			<H>{t("thread.questions")}</H>
			{d.questions.length === 0
				? none
				: d.questions.map((q) => (
						<div key={q.id} className="mb-3 border-b border-line pb-2">
							<Who id={q.askedBy} via="mcp:ai" project={project} />
							<Text>{q.bodyMd}</Text>
							{q.state === "open" ? (
								<>
									<p className="text-sm font-bold text-sash">
										{t("thread.question.open")}
									</p>
									<AnswerBox
										id={q.id}
										busy={act.isPending}
										onSubmit={(id, answerMd) =>
											act.mutate(() =>
												api("POST", `/questions/${id}/answer`, { answerMd }),
											)
										}
									/>
								</>
							) : (
								<p className="mt-1 border-l-2 border-line pl-2 text-nezumi">
									{q.answerMd}
								</p>
							)}
						</div>
					))}
			<H>{t("thread.comments")}</H>
			{d.comments.length === 0
				? none
				: d.comments.map((c) => (
						<div key={c.id} className="mb-3">
							<Who id={c.authorId} via={c.via} project={project} />
							<Text>{c.bodyMd}</Text>
						</div>
					))}
			<textarea
				rows={3}
				className={inputCls}
				aria-label={t("thread.comment.placeholder")}
				placeholder={t("thread.comment.placeholder")}
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			<Button
				kind="primary"
				className="mt-2"
				disabled={act.isPending || !text.trim()}
				onClick={() =>
					act.mutate(
						() =>
							api("POST", `/issues/${d.ref}/comments`, { bodyMd: text.trim() }),
						// keep the text if the post fails
						{ onSuccess: () => setText("") },
					)
				}
			>
				{t("thread.comment.submit")}
			</Button>
			<H>{t("thread.activity")}</H>
			{d.activities.length === 0
				? none
				: d.activities.map((a) => (
						<p key={a.id} className="mb-1 text-sm">
							<Who id={a.actorId} via={a.via} project={project} />
							<span className="ml-2">{activityText(a)}</span>
							<span className="num ml-2 text-nezumi">
								{new Date(a.createdAt).toLocaleString("ja-JP")}
							</span>
						</p>
					))}
		</div>
	);
}

export function IssuePanel(p: {
	refId: string;
	project: ProjectDetail;
	me: Me;
	onClose: () => void;
}) {
	const { data: d, isLoading, isError } = useIssue(p.refId);
	const [tab, setTab] = useState<Tab | null>(null);
	const current: Tab =
		tab ??
		(d?.category === "plan_review"
			? "plan"
			: d?.category === "impl_review"
				? "report"
				: "request");
	return (
		<aside
			aria-label={p.refId}
			className="panel fixed inset-y-0 right-0 z-30 flex w-[540px] max-w-full flex-col border-l border-line bg-surface shadow-[-4px_0_12px_rgba(31,41,51,0.08)] xl:static xl:z-auto xl:shrink-0 xl:shadow-none"
		>
			<header className="flex items-start gap-3 border-b border-line p-3">
				<div className="min-w-0 flex-1">
					<span className="num text-sm text-nezumi">{p.refId}</span>
					<p className="truncate text-lg font-bold">{d?.issue.title}</p>
					{d && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className="text-sm text-nezumi">{d.statusName}</span>
							<TurnBadge turn={turnOf(d.issue, p.project.statuses, p.me.id)} />
							{d.labels.map((l) => (
								<span key={l} className="text-xs text-nezumi">
									#{l}
								</span>
							))}
						</div>
					)}
				</div>
				<Button aria-label={t("panel.close")} onClick={p.onClose}>
					{t("panel.close")}
				</Button>
			</header>
			<div role="tablist" className="flex border-b border-line px-2">
				{TABS.map((k) => (
					<button
						key={k}
						type="button"
						role="tab"
						aria-selected={current === k}
						onClick={() => setTab(k)}
						className={cx(
							"border-b-2 px-3 py-2 text-base",
							current === k
								? "border-ai-indigo font-bold text-ai-indigo"
								: "border-transparent text-nezumi",
						)}
					>
						{t(`tab.${k}`)}
					</button>
				))}
			</div>
			<div role="tabpanel" className="min-h-0 flex-1 overflow-auto p-4">
				{isLoading && <p className="text-nezumi">{t("panel.loading")}</p>}
				{isError && (
					<p role="alert" className="text-sash">
						{t("panel.error")}
					</p>
				)}
				{d && current === "request" && <RequestTab d={d} project={p.project} />}
				{d && current === "plan" && <PlanTab d={d} me={p.me} />}
				{d && current === "report" && <ReportTab d={d} me={p.me} />}
				{d && current === "thread" && <ThreadTab d={d} project={p.project} />}
			</div>
		</aside>
	);
}
