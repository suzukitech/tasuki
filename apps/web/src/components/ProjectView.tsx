import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../i18n";
import { api } from "../lib/api";
import { keyAction } from "../lib/keys";
import {
	issueQuery,
	useInlineEdit,
	useIssues,
	useMe,
	useProject,
	useReviewQueue,
	useWriteFailure,
} from "../lib/queries";
import { buildCreate } from "../lib/quick";
import { turnOf } from "../lib/turn";
import type { IssueRow, Me, ProjectDetail } from "../lib/types";
import { IssuePanel } from "./Panel";
import { Button, cx, inputCls, TurnBadge } from "./ui";

export type ListSearch = { issue?: string; q?: string; view?: "review" };

const PRIORITY_KEYS = [
	"priority.none",
	"priority.low",
	"priority.medium",
	"priority.high",
	"priority.urgent",
] as const;

type Col = "status" | "assignee" | "priority";

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
	const [editing, setEditing] = useState<Col | null>(null);
	const ref = useRef<HTMLTableRowElement>(null);
	useEffect(() => {
		if (p.selected) ref.current?.scrollIntoView({ block: "nearest" });
	}, [p.selected]);
	const assignee = project.members.find((m) => m.id === row.assigneeId);
	const cell = "border-b border-line px-2 py-1 align-middle";
	const edit = (
		col: Col,
		label: string,
		options: [string, string][],
		value: string,
		apply: (v: string) => void,
	) =>
		editing === col ? (
			<select
				// biome-ignore lint/a11y/noAutofocus: opened by the user clicking the cell / button
				autoFocus
				aria-label={label}
				className="rounded border border-ai-indigo bg-surface px-1 py-0.5 text-base"
				value={value}
				onChange={(e) => {
					setEditing(null);
					if (e.target.value !== value) apply(e.target.value);
				}}
				onBlur={() => setEditing(null)}
				onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
			>
				{options.map(([v, l]) => (
					<option key={v} value={v}>
						{l}
					</option>
				))}
			</select>
		) : (
			<button
				type="button"
				className="text-left"
				onClick={() => setEditing(col)}
			>
				{options.find(([v]) => v === value)?.[1] || " "}
			</button>
		);
	return (
		<tr
			ref={ref}
			aria-selected={p.selected}
			onMouseEnter={() =>
				qc.prefetchQuery({ ...issueQuery(row.ref), staleTime: 10_000 })
			}
			className={cx(
				"bg-surface hover:bg-paper",
				p.selected && "outline outline-2 -outline-offset-2 outline-ai-indigo",
				p.open && "bg-paper",
			)}
		>
			<td className={cx(cell, "num whitespace-nowrap text-nezumi")}>
				{row.ref}
			</td>
			<td className={cell}>
				<button
					type="button"
					className="text-left font-bold text-ai-indigo"
					onClick={p.onOpen}
				>
					{row.title}
				</button>
			</td>
			<td className={cell}>
				{edit(
					"status",
					t("col.status"),
					project.statuses.map((s) => [s.id, s.name]),
					row.statusId,
					(v) => p.onEdit({ row, patch: { statusId: v } }),
				)}
			</td>
			<td className={cell}>
				{edit(
					"assignee",
					t("col.assignee"),
					[
						["", t("assignee.none")],
						...project.members.map((m): [string, string] => [m.id, m.name]),
					],
					row.assigneeId ?? "",
					(v) => p.onEdit({ row, patch: { assigneeId: v || null } }),
				)}
				{!assignee && row.assigneeId && editing !== "assignee" ? "?" : null}
			</td>
			<td className={cell}>
				{edit(
					"priority",
					t("col.priority"),
					PRIORITY_KEYS.map((k, i): [string, string] => [String(i), t(k)]),
					String(row.priority ?? 0),
					(v) => p.onEdit({ row, patch: { priority: Number(v) } }),
				)}
			</td>
			<td className={cx(cell, "num whitespace-nowrap")}>{row.dueDate ?? ""}</td>
			<td className={cell}>
				<TurnBadge turn={turnOf(row, project.statuses, p.me.id)} />
			</td>
		</tr>
	);
}

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
	const list = useIssues(projectKey, q);
	const queue = useReviewQueue(projectKey, project, me);
	const edit = useInlineEdit(projectKey);
	const rows = useMemo(
		() =>
			review ? queue.items : (list.data?.pages.flatMap((p) => p.items) ?? []),
		[review, queue.items, list.data],
	);
	const [sel, setSel] = useState(-1);
	const [ai, setAi] = useState(true);
	const createRef = useRef<HTMLInputElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const go = (s: Partial<ListSearch>) =>
		nav({
			to: "/p/$key",
			params: { key: projectKey },
			search: (prev: ListSearch) => ({ ...prev, ...s }),
		});

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
	});

	const onCreate = async (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") e.currentTarget.blur();
		if (e.key !== "Enter" || e.nativeEvent.isComposing || !project) return;
		const body = buildCreate(e.currentTarget.value, ai, project.members);
		if (!body) return;
		const input = e.currentTarget;
		try {
			await api("POST", `/projects/${projectKey}/issues`, body);
			input.value = "";
			qc.invalidateQueries({ queryKey: ["issues", projectKey] });
		} catch (x) {
			fail(x);
		}
	};
	const onSearch = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") e.currentTarget.blur();
		if (e.key === "Enter" && !e.nativeEvent.isComposing)
			go({ q: e.currentTarget.value.trim() || undefined });
	};

	if (!project || !me) return null;
	const loading = review ? queue.loading : list.isLoading;
	return (
		<div className="flex h-full">
			<section className="min-w-0 flex-1 overflow-auto p-4">
				<div className="mb-3 flex flex-wrap items-center gap-3">
					<h1 className="mr-auto text-xl font-bold">
						{review ? t("nav.review") : `${project.key} ${project.name}`}
					</h1>
					{!review && (
						<input
							ref={searchRef}
							key={q}
							defaultValue={q}
							type="search"
							aria-label={t("list.search")}
							placeholder={t("list.search")}
							title={t("list.search.hint")}
							onKeyDown={onSearch}
							className={cx(inputCls, "w-64")}
						/>
					)}
				</div>
				<div className="mb-3 flex items-center gap-3">
					<input
						ref={createRef}
						aria-label={t("list.create.placeholder")}
						placeholder={t("list.create.placeholder")}
						onKeyDown={onCreate}
						className={inputCls}
					/>
					<label className="flex items-center gap-1 whitespace-nowrap text-sm">
						<input
							type="checkbox"
							checked={ai}
							onChange={(e) => setAi(e.target.checked)}
						/>
						{t("list.create.ai")}
					</label>
				</div>
				{loading ? (
					<p className="text-nezumi">{t("list.loading")}</p>
				) : rows.length === 0 ? (
					<p className="py-8 text-nezumi">
						{review
							? t("review.empty")
							: q
								? t("list.noMatch")
								: t("list.empty")}
					</p>
				) : (
					<table className="w-full border-collapse text-base">
						<thead>
							<tr className="text-left text-sm text-nezumi">
								{(
									[
										"ref",
										"title",
										"status",
										"assignee",
										"priority",
										"due",
										"turn",
									] as const
								).map((c) => (
									<th
										key={c}
										className="border-b border-line px-2 py-1 font-normal"
									>
										{t(`col.${c}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
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
				{!review && list.hasNextPage && (
					<Button
						className="mt-3"
						onClick={() => list.fetchNextPage()}
						disabled={list.isFetchingNextPage}
					>
						{t("list.more")}
					</Button>
				)}
				<p className="mt-6 text-xs text-nezumi">{t("key.help")}</p>
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
