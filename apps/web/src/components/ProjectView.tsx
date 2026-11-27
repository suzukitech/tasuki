import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	CircleCheck,
	Columns3,
	FilePlus2,
	List,
	Plus,
	Search,
	SearchX,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../i18n";
import { api } from "../lib/api";
import { moveError } from "../lib/board";
import { absoluteDate, relativeDue } from "../lib/format";
import { keyAction } from "../lib/keys";
import { PRIORITY_KEYS } from "../lib/priority";
import {
	issueQuery,
	useInlineEdit,
	useIssues,
	useMe,
	useProject,
	useReviewQueue,
	useWriteFailure,
} from "../lib/queries";
import { buildCreate, previewQuick } from "../lib/quick";
import { turnOf } from "../lib/turn";
import type { IssueRow, Me, ProjectDetail } from "../lib/types";
import { Board } from "./Board";
import { IssuePanel } from "./Panel";
import {
	Avatar,
	Button,
	Chip,
	cx,
	EmptyState,
	FlowToggle,
	iconProps,
	Kbd,
	Menu,
	memberOptions,
	NoAvatar,
	PriorityGlyph,
	priorityOptions,
	Skeleton,
	StatusDot,
	TurnBadge,
	useToast,
} from "./ui";

export type ListSearch = {
	issue?: string;
	q?: string;
	view?: "review" | "board";
};

type Col = "status" | "assignee" | "priority";
const COLS = [
	"ref",
	"title",
	"status",
	"assignee",
	"priority",
	"due",
	"turn",
] as const;

const bare =
	"bare min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-nezumi ";

function Row(p: {
	row: IssueRow;
	project: ProjectDetail;
	me: Me;
	selected: boolean;
	open: boolean;
	onOpen: () => void;
	onEdit: ReturnType<typeof useInlineEdit>["mutate"];
}) {
	const { row, project } = p;
	const qc = useQueryClient();
	const ref = useRef<HTMLTableRowElement>(null);
	useEffect(() => {
		if (p.selected) ref.current?.scrollIntoView({ block: "nearest" });
	}, [p.selected]);
	const status = project.statuses.find((s) => s.id === row.statusId);
	const assignee = project.members.find((m) => m.id === row.assigneeId);
	const due = row.dueDate ? relativeDue(row.dueDate) : null;
	const priority = row.priority ?? 0;
	// one line per cell on desktop; on a phone each row stacks (ref + title, then the small facts)
	const cell =
		"whitespace-nowrap border-b border-line px-3 align-middle max-md:border-0 max-md:p-0 max-md:text-xs";
	const edit = (col: Col) => {
		if (col === "status")
			return {
				label: t("col.status"),
				options: project.statuses.map((s) => ({
					value: s.id,
					label: s.name,
					icon: <StatusDot category={s.category} />,
				})),
				value: row.statusId,
				apply: (v: string) => p.onEdit({ row, patch: { statusId: v } }),
			};
		if (col === "assignee")
			return {
				label: t("col.assignee"),
				options: memberOptions(project.members),
				value: row.assigneeId ?? "",
				apply: (v: string) =>
					p.onEdit({ row, patch: { assigneeId: v || null } }),
			};
		return {
			label: t("col.priority"),
			options: priorityOptions(),
			value: String(priority),
			apply: (v: string) => p.onEdit({ row, patch: { priority: Number(v) } }),
		};
	};
	const menu = (col: Col, children: React.ReactNode) => {
		const e = edit(col);
		return (
			<Menu
				label={e.label}
				value={e.value}
				options={e.options}
				onChange={e.apply}
				className="-mx-1.5 min-h-7 px-1.5"
			>
				{children}
			</Menu>
		);
	};
	return (
		<tr
			ref={ref}
			aria-selected={p.selected}
			data-open={p.open}
			onMouseEnter={() =>
				qc.prefetchQuery({ ...issueQuery(row.ref), staleTime: 10_000 })
			}
			className="row h-10 bg-surface max-md:flex max-md:h-auto max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:border-b max-md:border-line max-md:px-1 max-md:py-2.5"
		>
			<td className={cx(cell, "num font-medium text-nezumi md:w-0")}>
				{row.ref}
			</td>
			<td
				className={cx(
					cell,
					"w-full max-w-0 max-md:min-w-0 max-md:grow max-md:basis-0 max-md:max-w-none max-md:text-sm",
				)}
			>
				<div className="flex min-w-0 items-center gap-2">
					<button
						type="button"
						className="min-w-0 truncate rounded-chip text-left font-medium text-ink hover:text-ai-indigo max-md:whitespace-normal pointer-coarse:min-h-11"
						onClick={p.onOpen}
					>
						{row.title}
					</button>
					{row.labels.map((l) => (
						<Chip key={l} className="max-md:hidden @max-[760px]:hidden">
							{l}
						</Chip>
					))}
				</div>
			</td>
			{/* line break between the two lines of the stacked (phone) row */}
			<td aria-hidden className="hidden max-md:block max-md:basis-full" />
			<td className={cell}>
				{menu(
					"status",
					<>
						{status && <StatusDot category={status.category} />}
						<span>{status?.name}</span>
					</>,
				)}
			</td>
			<td className={cell}>
				{menu(
					"assignee",
					<>
						{assignee ? (
							<Avatar id={assignee.id} name={assignee.name} />
						) : (
							<NoAvatar />
						)}
						<span
							className={cx("@max-[760px]:hidden", !assignee && "text-nezumi")}
						>
							{assignee?.name ?? (row.assigneeId ? "?" : t("assignee.none"))}
						</span>
					</>,
				)}
			</td>
			<td className={cell}>
				{menu(
					"priority",
					<PriorityGlyph
						level={priority}
						label={t(PRIORITY_KEYS[priority] ?? "priority.none")}
					/>,
				)}
			</td>
			<td
				className={cx(
					cell,
					"num max-md:empty:hidden",
					due?.late && "font-medium text-sash",
				)}
				title={row.dueDate ? absoluteDate(row.dueDate) : undefined}
			>
				{due?.text}
			</td>
			<td className={cell}>
				<TurnBadge turn={turnOf(row, project.statuses, p.me.id)} />
			</td>
		</tr>
	);
}

function SkeletonRows() {
	return (
		<div aria-busy="true" className="space-y-px">
			<span className="sr-only">{t("list.loading")}</span>
			{[0, 1, 2, 3, 4, 5, 6].map((n) => (
				<div
					key={n}
					className="flex h-10 items-center gap-4 border-b border-line px-3"
				>
					<Skeleton className="h-3 w-14" />
					<Skeleton className="h-3 flex-1" />
					<Skeleton className="h-3 w-20 max-md:hidden" />
					<Skeleton className="size-5 rounded-full max-md:hidden" />
					<Skeleton className="h-3 w-12 max-md:hidden" />
				</div>
			))}
		</div>
	);
}

const SEARCH_EXAMPLES = [
	["status:plan_review", "ex.status"],
	["assignee:me priority:>=high", "ex.mine"],
	["label:bug due:<2026-12-31", "ex.due"],
] as const;

export function ProjectView({
	projectKey,
	search,
}: {
	projectKey: string;
	search: ListSearch;
}) {
	const nav = useNavigate();
	const fail = useWriteFailure();
	const qc = useQueryClient();
	const me = useMe().data;
	const project = useProject(projectKey).data;
	const q = search.q ?? "";
	const review = search.view === "review";
	const board = search.view === "board";
	const list = useIssues(projectKey, q);
	const queue = useReviewQueue(projectKey, project, me);
	const toast = useToast();
	const edit = useInlineEdit(projectKey);
	const move = useInlineEdit(projectKey, (e) => toast(moveError(e)));
	const rows = useMemo(
		() =>
			review ? queue.items : (list.data?.pages.flatMap((p) => p.items) ?? []),
		[review, queue.items, list.data],
	);
	// the board shows whole columns: keep loading until the list is complete
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
	useEffect(() => {
		if (board && hasNextPage && !isFetchingNextPage) fetchNextPage();
	}, [board, hasNextPage, isFetchingNextPage, fetchNextPage]);
	const [sel, setSel] = useState(-1);
	const [ai, setAi] = useState(true);
	const [draft, setDraft] = useState("");
	const [searching, setSearching] = useState(false);
	const createRef = useRef<HTMLInputElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const go = useCallback(
		(s: Partial<ListSearch>) =>
			nav({
				to: "/p/$key",
				params: { key: projectKey },
				search: (prev: ListSearch) => ({ ...prev, ...s }),
			}),
		[nav, projectKey],
	);

	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const a = keyAction({
				key: e.key,
				isComposing: e.isComposing,
				metaKey: e.metaKey,
				ctrlKey: e.ctrlKey,
				altKey: e.altKey,
				target: e.target as HTMLElement | null,
			});
			if (!a) return;
			if (board && (a === "next" || a === "prev" || a === "open")) return;
			e.preventDefault();
			if (a === "create") createRef.current?.focus();
			else if (a === "search") searchRef.current?.focus();
			else if (a === "next") setSel((i) => Math.min(i + 1, rows.length - 1));
			else if (a === "prev") setSel((i) => Math.max(i - 1, 0));
			else if (a === "open") rows[sel] && go({ issue: rows[sel].ref });
			else if (a === "close" && search.issue) go({ issue: undefined });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rows, sel, search.issue, go, board]);

	const creating = useRef(false);
	const onCreate = async (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") e.currentTarget.blur();
		if (e.key !== "Enter" || e.nativeEvent.isComposing || !project) return;
		if (creating.current) return; // one POST at a time: a second Enter must not duplicate
		const body = buildCreate(draft, ai, project.members);
		if (!body) return;
		creating.current = true;
		const sent = draft;
		setDraft(""); // cleared before the await; restored on failure
		try {
			await api("POST", `/projects/${projectKey}/issues`, body);
			qc.invalidateQueries({ queryKey: ["issues", projectKey] });
		} catch (x) {
			setDraft((now) => now || sent);
			fail(x);
		} finally {
			creating.current = false;
		}
	};
	const onSearch = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") e.currentTarget.blur();
		if (e.key === "Enter" && !e.nativeEvent.isComposing)
			go({ q: e.currentTarget.value.trim() || undefined });
	};

	if (!project || !me) return null;
	const loading = review ? queue.loading : list.isLoading;
	const error = review ? queue.error : list.error;
	const parsed = previewQuick(draft, project.members);
	const chips: [string, string][] = [
		...(parsed.assignee
			? [[t("chip.assignee"), parsed.assignee.name] as [string, string]]
			: []),
		...parsed.labels.map((l): [string, string] => [t("chip.label"), l]),
		...(parsed.priority
			? [
					[
						t("chip.priority"),
						t(PRIORITY_KEYS[parsed.priority] ?? "priority.none"),
					] as [string, string],
				]
			: []),
	];
	return (
		<div className="flex h-full">
			<section className="flex min-w-0 flex-1 flex-col">
				<div className="space-y-3 px-5 pt-4 pb-3 max-md:px-3">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="mr-auto text-xl font-semibold">
							{review ? (
								t("nav.review")
							) : (
								<>
									<span className="num mr-2 font-medium text-nezumi">
										{project.key}
									</span>
									{project.name}
								</>
							)}
						</h1>
						{!review && (
							<fieldset className="m-0 flex min-w-0 rounded-control border-0 bg-paper p-0.5">
								<legend className="sr-only">{t("view.switch")}</legend>
								{(
									[
										[false, List, "nav.list"],
										[true, Columns3, "nav.board"],
									] as const
								).map(([b, Icon, k]) => (
									<button
										key={k}
										type="button"
										aria-pressed={board === b}
										onClick={() => go({ view: b ? "board" : undefined })}
										className={cx(
											"inline-flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs leading-6 whitespace-nowrap pointer-coarse:min-h-10",
											board === b
												? "bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--line-strong)]"
												: "text-nezumi hover:text-ink",
										)}
									>
										<Icon {...iconProps} />
										{t(k)}
									</button>
								))}
							</fieldset>
						)}
						{!review && (
							<div className="relative w-72 max-md:w-full">
								<Search
									{...iconProps}
									className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-nezumi"
								/>
								<input
									ref={searchRef}
									key={q}
									defaultValue={q}
									type="search"
									aria-label={t("list.search")}
									placeholder={t("list.search")}
									onFocus={() => setSearching(true)}
									onBlur={() => setSearching(false)}
									onKeyDown={onSearch}
									className="h-8 w-full rounded-control border border-line-strong bg-surface pr-8 pl-8 text-sm placeholder:text-nezumi pointer-coarse:h-11"
								/>
								<span className="absolute top-1/2 right-2 -translate-y-1/2">
									<Kbd>/</Kbd>
								</span>
								{searching && (
									<div className="pop absolute top-full right-0 z-30 mt-1.5 w-80 max-w-full rounded-panel border border-line bg-surface p-3 shadow-float">
										<p className="mb-2 text-xs font-medium text-nezumi">
											{t("search.help")}
										</p>
										<ul className="space-y-1.5">
											{SEARCH_EXAMPLES.map(([ex, k]) => (
												<li key={ex} className="flex flex-col gap-0.5">
													<button
														type="button"
														// keep the input focused so the popover stays
														onMouseDown={(e) => {
															e.preventDefault();
															if (searchRef.current)
																searchRef.current.value = ex;
														}}
														className="w-fit rounded-chip text-left"
													>
														<Chip className="text-ink">{ex}</Chip>
													</button>
													<span className="text-xs text-nezumi">{t(k)}</span>
												</li>
											))}
										</ul>
									</div>
								)}
							</div>
						)}
					</div>
					<div className="relative">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-line-strong bg-surface px-2.5 py-1 focus-within:border-ai-indigo focus-within:shadow-[0_0_0_3px_var(--focus)] pointer-coarse:py-0.5">
							<Plus {...iconProps} className="shrink-0 text-nezumi" />
							<input
								ref={createRef}
								data-quick-create
								aria-label={t("list.create.placeholder")}
								placeholder={t("list.create.placeholder")}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={onCreate}
								className={cx(bare, "h-8 min-w-48 pointer-coarse:h-11")}
							/>
							<Kbd>C</Kbd>
							<FlowToggle
								value={ai}
								onChange={setAi}
								label={t("list.create.flow")}
							/>
						</div>
						{chips.length > 0 && (
							<div
								aria-live="polite"
								className="pop absolute top-full left-0 z-30 mt-1.5 flex max-w-full flex-wrap items-center gap-1.5 rounded-panel border border-line bg-surface px-2 py-1.5 shadow-float"
							>
								{chips.map(([k, v]) => (
									<Chip
										key={`${k}${v}`}
										className="gap-1 border-ai-indigo/30 bg-selection"
									>
										<span>{k}</span>
										<span className="font-medium text-ink">{v}</span>
									</Chip>
								))}
								<span className="ml-1 flex items-center gap-1 text-xs text-nezumi">
									<Kbd>Enter</Kbd>
									{t("list.create.hint")}
								</span>
							</div>
						)}
					</div>
				</div>
				<div
					className={cx(
						"@container min-h-0 flex-1 px-5 max-md:px-3",
						// the board scrolls sideways inside this frame only; the page never does
						board && !loading && rows.length > 0
							? "overflow-x-auto overflow-y-hidden pb-4"
							: "overflow-auto pb-6",
					)}
				>
					{loading ? (
						<SkeletonRows />
					) : error && rows.length === 0 ? (
						<p role="alert" className="py-8 text-sm text-sash">
							{t("list.error")}
							{error.message}
						</p>
					) : rows.length === 0 ? (
						review ? (
							<EmptyState
								icon={CircleCheck}
								action={
									<Button onClick={() => go({ view: undefined })}>
										{t("review.toList")}
									</Button>
								}
							>
								{t("review.empty")}
							</EmptyState>
						) : q ? (
							<EmptyState
								icon={SearchX}
								action={
									<Button onClick={() => go({ q: undefined })}>
										{t("list.clearSearch")}
									</Button>
								}
							>
								{t("list.noMatch")}
							</EmptyState>
						) : (
							<EmptyState
								icon={FilePlus2}
								action={
									<Button
										kind="primary"
										onClick={() => createRef.current?.focus()}
									>
										{t("list.createFirst")}
									</Button>
								}
							>
								{t("list.empty")}
							</EmptyState>
						)
					) : board ? (
						<Board
							project={project}
							me={me}
							rows={rows}
							openRef={search.issue}
							onOpen={(ref) => go({ issue: ref })}
							onMove={(row, to) => move.mutate({ row, patch: to })}
						/>
					) : (
						<table className="w-full border-collapse text-sm max-md:block">
							<thead className="max-md:hidden">
								<tr className="text-left text-xs text-nezumi">
									{COLS.map((c) => (
										<th
											key={c}
											scope="col"
											className={cx(
												"sticky top-0 z-10 whitespace-nowrap border-b border-line-strong bg-paper px-3 py-2 font-medium",
												c === "title" && "w-full",
											)}
										>
											{t(`col.${c}`)}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="max-md:block">
								{rows.map((row, i) => (
									<Row
										key={row.id}
										row={row}
										project={project}
										me={me}
										selected={i === sel}
										open={row.ref === search.issue}
										onOpen={() => {
											setSel(i);
											go({ issue: row.ref });
										}}
										onEdit={edit.mutate}
									/>
								))}
							</tbody>
						</table>
					)}
					{review && queue.truncated && (
						<p className="mt-3 text-xs text-nezumi">{t("review.truncated")}</p>
					)}
					{!review && !board && list.hasNextPage && (
						<Button
							className="mt-3"
							onClick={() => list.fetchNextPage()}
							disabled={list.isFetchingNextPage}
						>
							{t("list.more")}
						</Button>
					)}
					<p
						className={cx(
							"mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs text-nezumi max-md:hidden pointer-coarse:hidden",
							board && "hidden",
						)}
					>
						{(
							[
								[["C"], "key.create"],
								[["J", "K"], "key.move"],
								[["Enter"], "key.open"],
								[["Esc"], "key.close"],
								[["/"], "key.search"],
							] as const
						).map(([keys, k]) => (
							<span key={k} className="flex items-center gap-1.5">
								<span className="flex gap-0.5">
									{keys.map((x) => (
										<Kbd key={x}>{x}</Kbd>
									))}
								</span>
								{t(k)}
							</span>
						))}
					</p>
				</div>
			</section>
			{search.issue && (
				<IssuePanel
					key={search.issue}
					refId={search.issue}
					project={project}
					me={me}
					onClose={() => go({ issue: undefined })}
				/>
			)}
		</div>
	);
}
