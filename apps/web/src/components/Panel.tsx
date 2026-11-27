import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reviewerOf } from "@tasuki/schema/pure";
import {
	CircleAlert,
	CircleCheck,
	CircleDashed,
	CircleHelp,
	CircleX,
	ExternalLink,
	Plus,
	X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { type Key, t } from "../i18n";
import { ja } from "../i18n/ja";
import { api } from "../lib/api";
import { type CritDraft, criteriaBody, critsOf, shown } from "../lib/draft";
import { etagOf } from "../lib/etag";
import { relativeTime, splitSteps, stepRefs } from "../lib/format";
import { PRIORITY_KEYS } from "../lib/priority";
import { refreshIssue, useIssue, useWriteFailure } from "../lib/queries";
import { turnOf } from "../lib/turn";
import type {
	Activity,
	Criterion,
	IssueDetail,
	Me,
	ProjectDetail,
} from "../lib/types";
import {
	Avatar,
	Button,
	Chip,
	cx,
	FlowToggle,
	IconButton,
	iconProps,
	inputCls,
	Menu,
	Skeleton,
	StatusDot,
	TurnBadge,
} from "./ui";

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

const H = ({ children }: { children: ReactNode }) => (
	<h3 className="mt-6 mb-2 text-xs font-medium text-nezumi first:mt-0">
		{children}
	</h3>
);
/** Panel body text: 15px / 1.75, about 68 columns wide. */
const Text = ({
	children,
	className,
}: {
	children: string;
	className?: string;
}) => (
	<p
		className={cx(
			"max-w-[68ch] whitespace-pre-wrap text-base leading-[1.75]",
			className,
		)}
	>
		{children}
	</p>
);
const Muted = ({ children }: { children: ReactNode }) => (
	<p className="text-sm text-nezumi">{children}</p>
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

const nameOf = (id: string | null, project: ProjectDetail) =>
	project.members.find((m) => m.id === id)?.name ?? t("unknown.user");

/** Avatar + name; the via tag is quiet and only shown for non-Web writes. */
function Who({
	id,
	via,
	project,
}: {
	id: string | null;
	via: string | null;
	project: ProjectDetail;
}) {
	const name = nameOf(id, project);
	return (
		<span className="inline-flex items-center gap-2">
			<Avatar id={id ?? "?"} name={name} size={20} />
			<span className="font-medium text-ink">{name}</span>
			{via && via !== "web" && (
				<span className="rounded-chip bg-paper px-1.5 text-xs leading-5 text-asagi">
					{viaLabel(via)}
				</span>
			)}
		</span>
	);
}

const Time = ({ at }: { at: string | number | Date }) => (
	<time
		dateTime={new Date(at).toISOString()}
		title={new Date(at).toLocaleString("ja-JP")}
		className="num text-xs text-nezumi"
	>
		{relativeTime(at)}
	</time>
);

const label = "mb-1 block text-xs font-medium text-nezumi";

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
	const field = "grid grid-cols-[5.5rem_1fr] items-center gap-2";
	return (
		<div>
			<label className={label} htmlFor="f-title">
				{t("req.title")}
			</label>
			<input
				id="f-title"
				className={inputCls}
				value={title}
				onChange={(e) => setDraft((x) => ({ ...x, title: e.target.value }))}
			/>
			<label className={cx(label, "mt-4")} htmlFor="f-body">
				{t("req.body")}
			</label>
			<textarea
				id="f-body"
				rows={8}
				className={cx(inputCls, "leading-relaxed")}
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
			<div className="space-y-1.5 text-sm">
				<div className={field}>
					<span className="text-nezumi">{t("col.assignee")}</span>
					<div>
						<Menu
							label={t("col.assignee")}
							value={i.assigneeId ?? ""}
							options={[
								{ value: "", label: t("assignee.none") },
								...project.members.map((m) => ({
									value: m.id,
									label: m.name,
									icon: <Avatar id={m.id} name={m.name} />,
								})),
							]}
							onChange={(v) => save({ assigneeId: v || null })}
							className="-ml-1.5 min-h-8 px-1.5"
						/>
					</div>
				</div>
				<div className={field}>
					<span className="text-nezumi">{t("col.priority")}</span>
					<div>
						<Menu
							label={t("col.priority")}
							value={String(i.priority ?? 0)}
							options={PRIORITY_KEYS.map((k, n) => ({
								value: String(n),
								label: t(k),
							}))}
							onChange={(v) => save({ priority: Number(v) })}
							className="-ml-1.5 min-h-8 px-1.5"
						/>
					</div>
				</div>
				<div className={field}>
					<label className="text-nezumi" htmlFor="f-due">
						{t("col.due")}
					</label>
					<input
						id="f-due"
						type="date"
						className={cx(inputCls, "num w-auto justify-self-start")}
						value={i.dueDate ?? ""}
						onChange={(e) => save({ dueDate: e.target.value || null })}
					/>
				</div>
				<div className={field}>
					<span className="text-nezumi">{t("req.flow")}</span>
					<FlowToggle
						value={i.flow === "ai"}
						onChange={(v) => save({ flow: v ? "ai" : "simple" })}
						label={t("list.create.flow")}
						className="justify-self-start"
					/>
				</div>
			</div>

			<H>{t("req.criteria")}</H>
			{crit.length === 0 && <Muted>{t("req.criteria.empty")}</Muted>}
			<ul className="space-y-2">
				{crit.map((c, n) => (
					<li key={c.id ?? `new-${n}`} className="flex gap-1.5">
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
						<IconButton
							icon={X}
							label={t("req.criteria.remove")}
							onClick={() => setCrit(crit.filter((_, m) => m !== n))}
						/>
					</li>
				))}
			</ul>
			<div className="mt-3 flex gap-2">
				<Button onClick={() => setCrit([...crit, { id: undefined, text: "" }])}>
					<Plus {...iconProps} />
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

/** The human gate, pinned to the panel bottom: approve, or return with a mandatory note. */
function Gate(p: {
	issueRef: string;
	approve: { label: string; path: string };
	reject: { label: string; placeholder: string; path: string };
}) {
	const act = useAct(p.issueRef);
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState("");
	const post = (path: string, body?: unknown) =>
		act.mutate(() => api("POST", `/issues/${p.issueRef}${path}`, body));
	return (
		<footer className="border-t border-line bg-surface px-4 py-3">
			{open && (
				<div className="mb-3">
					<textarea
						// biome-ignore lint/a11y/noAutofocus: opened by the user clicking the button
						autoFocus
						rows={3}
						className={inputCls}
						aria-label={p.reject.placeholder}
						placeholder={p.reject.placeholder}
						value={note}
						onChange={(e) => setNote(e.target.value)}
					/>
					{!note.trim() && (
						<p className="mt-1 text-xs text-nezumi">
							{t("plan.note.required")}
						</p>
					)}
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{open ? (
					<>
						<Button
							kind="danger"
							disabled={act.isPending || !note.trim()}
							onClick={() => post(p.reject.path, { note: note.trim() })}
						>
							{p.reject.label}
						</Button>
						<Button onClick={() => setOpen(false)}>{t("gate.cancel")}</Button>
					</>
				) : (
					<>
						<Button
							kind="primary"
							disabled={act.isPending}
							onClick={() => post(p.approve.path)}
						>
							{p.approve.label}
						</Button>
						<Button onClick={() => setOpen(true)}>{p.reject.label}</Button>
					</>
				)}
			</div>
		</footer>
	);
}

function Steps({ md }: { md: string }) {
	const steps = splitSteps(md);
	if (!steps) return <Text className="text-sm leading-relaxed">{md}</Text>;
	return (
		<ol className="space-y-2">
			{steps.map((s) => (
				<li key={s.n} className="flex gap-2 text-sm leading-relaxed">
					<span className="num mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-chip bg-paper text-xs font-medium text-nezumi">
						{s.n}
					</span>
					{s.text}
				</li>
			))}
		</ol>
	);
}

function PlanTab({ d }: { d: IssueDetail }) {
	const plan =
		[...d.plans].reverse().find((p) => p.state !== "superseded") ??
		d.plans.at(-1);
	if (!plan) return <Muted>{t("plan.none")}</Muted>;
	const stepOf = new Map(
		d.planCriteria
			.filter((m) => m.planId === plan.id)
			.map((m) => [m.criterionId, m.stepRef]),
	);
	return (
		<div>
			<p className="num mb-3 text-xs text-nezumi">
				{t("plan.version", { n: plan.version })}
			</p>
			<H>{t("plan.understanding")}</H>
			<blockquote className="border-l-2 border-ai-indigo pl-3">
				<Text>{plan.understandingMd}</Text>
			</blockquote>
			<div className="mt-6 grid gap-x-5 gap-y-6 sm:grid-cols-2">
				<div>
					<H>{t("plan.criteria")}</H>
					<ul className="space-y-2">
						{d.criteria.map((c) => {
							const refs = stepRefs(stepOf.get(c.id));
							return (
								<li
									key={c.id}
									className={cx(
										"rounded-control border px-2.5 py-2 text-sm leading-relaxed",
										refs.length ? "border-line" : "border-sash/30 bg-sash-tint",
									)}
								>
									{c.text}
									{refs.length ? (
										<div className="mt-1.5 flex flex-wrap gap-1">
											{refs.map((r) => (
												<Chip key={r} className="num">
													{/^\d+$/.test(r) ? t("plan.stepN", { n: r }) : r}
												</Chip>
											))}
										</div>
									) : (
										<p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-sash">
											<CircleAlert {...iconProps} />
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
					<Steps md={plan.stepsMd} />
				</div>
			</div>
			{plan.risksMd && (
				<>
					<H>{t("plan.risks")}</H>
					<Text>{plan.risksMd}</Text>
				</>
			)}
		</div>
	);
}

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

const RESULT_ICON = {
	met: [CircleCheck, "text-asagi"],
	unmet: [CircleX, "text-sash"],
	unsure: [CircleHelp, "text-nezumi"],
	pending: [CircleDashed, "text-nezumi"],
} as const;

function CriterionResult({ c }: { c: Criterion }) {
	const [Icon, color] = RESULT_ICON[c.result];
	return (
		<li className="flex gap-2.5 border-b border-line py-2.5 last:border-b-0">
			<Icon {...iconProps} className={cx("mt-0.5 shrink-0", color)} />
			<div className="min-w-0 flex-1 text-sm leading-relaxed">
				<p>{c.text}</p>
				<p className={cx("text-xs font-medium", color)}>
					{t(`result.${c.result}`)}
				</p>
				<p className="mt-0.5 text-nezumi">
					{c.evidenceMd || t("result.noEvidence")}
				</p>
			</div>
		</li>
	);
}

function ReportTab({ d }: { d: IssueDetail }) {
	const r = d.reports.at(-1);
	if (!r) return <Muted>{t("report.none")}</Muted>;
	const block = "rounded-control border border-line px-3 py-2.5";
	return (
		<div>
			<H>{t("report.summary")}</H>
			<div className="rounded-panel border border-line bg-paper px-4 py-3">
				<Text>{r.summaryMd}</Text>
			</div>
			<div className="mt-6 space-y-3">
				<section className={block}>
					<h3 className="mb-1 text-xs font-medium text-nezumi">
						{t("report.decisions")}
					</h3>
					<Text className="text-sm leading-relaxed">{r.decisionsMd}</Text>
				</section>
				<section className={block}>
					<h3 className="mb-1 text-xs font-medium text-nezumi">
						{t("report.deviations")}
					</h3>
					{r.deviationsMd ? (
						<Text className="text-sm leading-relaxed">{r.deviationsMd}</Text>
					) : (
						<Muted>{t("report.deviations.none")}</Muted>
					)}
				</section>
			</div>
			<H>{t("report.criteria")}</H>
			<ul>
				{d.criteria.map((c) => (
					<CriterionResult key={c.id} c={c} />
				))}
			</ul>
			{r.testsMd && (
				<>
					<H>{t("report.tests")}</H>
					<Text className="text-sm leading-relaxed">{r.testsMd}</Text>
				</>
			)}
			{r.prUrl && (
				<>
					<H>{t("report.pr")}</H>
					{safeUrl(r.prUrl) ? (
						<a
							className="inline-flex max-w-full items-center gap-1.5 break-all text-sm text-ai-indigo underline underline-offset-2"
							href={safeUrl(r.prUrl)}
							target="_blank"
							rel="noreferrer"
						>
							{r.prUrl}
							<ExternalLink {...iconProps} className="shrink-0" />
						</a>
					) : (
						<Text>{r.prUrl}</Text>
					)}
				</>
			)}
		</div>
	);
}

const known = (prefix: string, k: string) =>
	`${prefix}.${k}` in ja ? t(`${prefix}.${k}` as Key) : k;

function activityText(a: Activity): string {
	if (a.field) {
		const field = known("field", a.field);
		const long = (a.before ?? "").length > 40 || (a.after ?? "").length > 40;
		if (long || a.field === "criteria") return t("act.changed", { field });
		return a.before
			? t("act.change", { field, before: a.before, after: a.after ?? "" })
			: t("act.set", { field, after: a.after ?? "" });
	}
	return known("act", a.action);
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
				className="mt-2"
				disabled={busy || !text.trim()}
				onClick={() => onSubmit(id, text.trim())}
			>
				{t("thread.question.answer")}
			</Button>
		</div>
	);
}

type Entry =
	| {
			k: "comment";
			at: string;
			id: string;
			who: string | null;
			via: string;
			body: string;
	  }
	| {
			k: "answer";
			at: string;
			id: string;
			who: string | null;
			via: string | null;
			q: string;
			a: string;
	  }
	| { k: "activity"; at: string; id: string; a: Activity };

function ThreadTab({ d, project }: { d: IssueDetail; project: ProjectDetail }) {
	const act = useAct(d.ref);
	const [text, setText] = useState("");
	const open = d.questions.filter((q) => q.state === "open");
	const timeline: Entry[] = [
		...d.comments.map(
			(c): Entry => ({
				k: "comment",
				at: c.createdAt,
				id: c.id,
				who: c.authorId,
				via: c.via,
				body: c.bodyMd,
			}),
		),
		...d.questions
			.filter((q) => q.state !== "open")
			.map(
				(q): Entry => ({
					k: "answer",
					at: q.createdAt,
					id: q.id,
					who: q.askedBy,
					via: q.via,
					q: q.bodyMd,
					a: q.answerMd ?? "",
				}),
			),
		...d.activities.map(
			(a): Entry => ({ k: "activity", at: a.createdAt, id: a.id, a }),
		),
	].sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
	return (
		<div>
			{open.map((q) => (
				<section
					key={q.id}
					className="mb-5 rounded-panel border border-sash/30 bg-sash-tint p-3"
				>
					<div className="mb-1.5 flex flex-wrap items-center gap-2">
						<Who id={q.askedBy} via={q.via} project={project} />
						<span className="rounded-chip border border-sash/40 px-1.5 text-xs leading-5 font-medium text-sash">
							{t("thread.question.open")}
						</span>
						<span className="ml-auto">
							<Time at={q.createdAt} />
						</span>
					</div>
					<Text>{q.bodyMd}</Text>
					<AnswerBox
						id={q.id}
						busy={act.isPending}
						onSubmit={(id, answerMd) =>
							act.mutate(() =>
								api("POST", `/questions/${id}/answer`, { answerMd }),
							)
						}
					/>
				</section>
			))}
			{timeline.length === 0 && open.length === 0 && (
				<Muted>{t("thread.empty")}</Muted>
			)}
			<ol className="space-y-4">
				{timeline.map((e) =>
					e.k === "activity" ? (
						<li
							key={e.id}
							className="flex items-center gap-2 text-sm text-nezumi"
						>
							<Avatar
								id={e.a.actorId ?? "?"}
								name={nameOf(e.a.actorId, project)}
								size={20}
							/>
							<span className="min-w-0 flex-1">
								<span className="font-medium text-ink">
									{nameOf(e.a.actorId, project)}
								</span>
								<span className="ml-1.5">{activityText(e.a)}</span>
							</span>
							<Time at={e.at} />
						</li>
					) : (
						<li key={e.id}>
							<div className="mb-1 flex items-center gap-2">
								<Who id={e.who} via={e.via} project={project} />
								<span className="ml-auto">
									<Time at={e.at} />
								</span>
							</div>
							{e.k === "comment" ? (
								<Text className="pl-7">{e.body}</Text>
							) : (
								<div className="pl-7">
									<Text>{e.q}</Text>
									<p className="mt-1.5 max-w-[68ch] border-l-2 border-line pl-3 text-base leading-[1.75] text-nezumi">
										{e.a}
									</p>
								</div>
							)}
						</li>
					),
				)}
			</ol>
			<div className="mt-6">
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
								api("POST", `/issues/${d.ref}/comments`, {
									bodyMd: text.trim(),
								}),
							// keep the text if the post fails
							{ onSuccess: () => setText("") },
						)
					}
				>
					{t("thread.comment.submit")}
				</Button>
			</div>
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
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	const current: Tab =
		tab ??
		(d?.category === "plan_review"
			? "plan"
			: d?.category === "impl_review"
				? "report"
				: "request");
	const openQs = d?.questions.filter((q) => q.state === "open").length ?? 0;
	const status = p.project.statuses.find((s) => s.id === d?.issue.statusId);
	const onTabKey = (e: KeyboardEvent, i: number) => {
		const n = TABS.length;
		const to =
			e.key === "ArrowRight"
				? (i + 1) % n
				: e.key === "ArrowLeft"
					? (i + n - 1) % n
					: e.key === "Home"
						? 0
						: e.key === "End"
							? n - 1
							: -1;
		if (to < 0) return;
		e.preventDefault();
		setTab(TABS[to] ?? current);
		tabs.current[to]?.focus();
	};
	const review = d && canReview(d, p.me);
	const gate =
		d &&
		review &&
		current === "plan" &&
		d.category === "plan_review" &&
		d.plans.length ? (
			<Gate
				issueRef={d.ref}
				approve={{ label: t("plan.approve"), path: "/plan/approve" }}
				reject={{
					label: t("plan.reject"),
					placeholder: t("plan.note"),
					path: "/plan/reject",
				}}
			/>
		) : d &&
			review &&
			current === "report" &&
			d.category === "impl_review" &&
			d.reports.length ? (
			<Gate
				issueRef={d.ref}
				approve={{ label: t("report.complete"), path: "/complete" }}
				reject={{
					label: t("report.return"),
					placeholder: t("report.note"),
					path: "/report/return",
				}}
			/>
		) : null;
	return (
		<>
			{/* the backdrop exists only where the panel overlays the list */}
			<div
				aria-hidden
				onClick={p.onClose}
				className="fixed inset-0 z-20 bg-ink/25 xl:hidden"
			/>
			<aside
				aria-label={p.refId}
				className="panel fixed inset-y-0 right-0 z-30 flex w-[540px] max-w-full flex-col border-l border-line bg-surface shadow-float xl:static xl:z-auto xl:shrink-0 xl:shadow-none"
			>
				<header className="px-4 pt-3 pb-1">
					<div className="flex items-start gap-2">
						<div className="min-w-0 flex-1">
							<span className="num text-xs font-medium text-nezumi">
								{p.refId}
							</span>
							<h2 className="line-clamp-2 text-lg leading-snug font-semibold">
								{d?.issue.title ?? <Skeleton className="mt-1 h-5 w-2/3" />}
							</h2>
						</div>
						<IconButton
							icon={X}
							label={t("panel.close")}
							onClick={p.onClose}
							className="-mr-1.5"
						/>
					</div>
					{d && (
						<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
							<span className="inline-flex items-center gap-1.5 text-sm">
								{status && <StatusDot category={status.category} />}
								{d.statusName}
							</span>
							<TurnBadge
								turn={turnOf(
									{ ...d.issue, openQuestions: d.openQuestions },
									p.project.statuses,
									p.me.id,
								)}
							/>
							{d.labels.map((l) => (
								<Chip key={l}>{l}</Chip>
							))}
						</div>
					)}
				</header>
				<div
					role="tablist"
					aria-label={p.refId}
					className="mt-2 flex border-b border-line px-2"
				>
					{TABS.map((k, i) => (
						<button
							key={k}
							ref={(el) => {
								tabs.current[i] = el;
							}}
							id={`tab-${k}`}
							type="button"
							role="tab"
							aria-selected={current === k}
							aria-controls="panel-body"
							tabIndex={current === k ? 0 : -1}
							onClick={() => setTab(k)}
							onKeyDown={(e) => onTabKey(e, i)}
							className={cx(
								"-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm pointer-coarse:min-h-11",
								current === k
									? "border-ai-indigo font-medium text-ai-indigo"
									: "border-transparent text-nezumi hover:text-ink",
							)}
						>
							{t(`tab.${k}`)}
							{k === "thread" && openQs > 0 && (
								<span className="num inline-flex items-center gap-1 text-xs font-medium text-sash">
									<span aria-hidden className="size-1.5 rounded-full bg-sash" />
									<span aria-hidden>{openQs}</span>
									<span className="sr-only">
										{t("thread.openCount", { n: openQs })}
									</span>
								</span>
							)}
						</button>
					))}
				</div>
				<div
					role="tabpanel"
					id="panel-body"
					aria-labelledby={`tab-${current}`}
					className="min-h-0 flex-1 overflow-auto px-4 py-4"
				>
					{isLoading && (
						<div aria-busy="true" className="space-y-3">
							<Skeleton className="h-4 w-1/3" />
							<Skeleton className="h-9 w-full" />
							<Skeleton className="h-4 w-1/4" />
							<Skeleton className="h-32 w-full" />
						</div>
					)}
					{isError && (
						<p role="alert" className="text-sm text-sash">
							{t("panel.error")}
						</p>
					)}
					{d && current === "request" && (
						<RequestTab d={d} project={p.project} />
					)}
					{d && current === "plan" && <PlanTab d={d} />}
					{d && current === "report" && <ReportTab d={d} />}
					{d && current === "thread" && <ThreadTab d={d} project={p.project} />}
				</div>
				{gate}
			</aside>
		</>
	);
}
