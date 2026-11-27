import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { EVENT_TYPES } from "@tasuki/schema/pure";
import { useEffect } from "react";
import { useToast } from "../components/ui";
import { t } from "../i18n";
import { api } from "./api";
import { mapPages, type Patch, projectOf } from "./cache";
import { etagOf, writeError } from "./etag";
import { turnOf } from "./turn";
import type {
	IssueDetail,
	IssueRow,
	Me,
	Page,
	Project,
	ProjectDetail,
} from "./types";

export const useMe = () =>
	useQuery({
		queryKey: ["me"],
		queryFn: () => api<Me>("GET", "/me"),
		retry: false,
	});
export const useProjects = () =>
	useQuery({
		queryKey: ["projects"],
		queryFn: () => api<Project[]>("GET", "/projects"),
	});
export const useProject = (key: string) =>
	useQuery({
		queryKey: ["project", key.toUpperCase()],
		queryFn: () =>
			api<ProjectDetail>("GET", `/projects/${encodeURIComponent(key)}`),
		enabled: !!key,
	});

export const issueQuery = (ref: string) => ({
	queryKey: ["issue", ref],
	queryFn: () => api<IssueDetail>("GET", `/issues/${encodeURIComponent(ref)}`),
});
export const useIssue = (ref: string) => useQuery(issueQuery(ref));

export function useIssues(key: string, q: string) {
	return useInfiniteQuery({
		queryKey: ["issues", key.toUpperCase(), q],
		initialPageParam: undefined as number | undefined,
		queryFn: ({ pageParam }) => {
			const p = new URLSearchParams({ q, limit: "50" });
			if (pageParam) p.set("cursor", String(pageParam));
			return api<Page>(
				"GET",
				`/projects/${encodeURIComponent(key)}/issues?${p}`,
			);
		},
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: !!key,
	});
}

// plan / report reviews, plus any issue with an unanswered question
const REVIEW_QUERIES = [
	"status:plan_review",
	"status:impl_review",
	"question:open",
] as const;

/**
 * Issues waiting on this user: plan / report reviews where it is their turn.
 * Own key root ("review"), so list-cache edits never touch these plain Pages.
 */
export function useReviewQueue(key: string, project?: ProjectDetail, me?: Me) {
	const res = useQueries({
		queries: REVIEW_QUERIES.map((s) => ({
			queryKey: ["review", key.toUpperCase(), s],
			queryFn: () =>
				api<Page>(
					"GET",
					`/projects/${encodeURIComponent(key)}/issues?q=${s}&limit=200`,
				),
			enabled: !!key,
		})),
	});
	// an issue can match two queries: key by id
	const byId = new Map(
		res.flatMap((r) => r.data?.items ?? []).map((i) => [i.id, i]),
	);
	const items: IssueRow[] =
		project && me
			? [...byId.values()]
					.filter((i) => turnOf(i, project.statuses, me.id) === "you")
					.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) // longest waiting first
			: [];
	return {
		items,
		loading: res.some((r) => r.isLoading),
		error: res.find((r) => r.error)?.error ?? null,
		/** the server had more than one page: some waiting issues are not shown */
		truncated: res.some((r) => r.data?.nextCursor != null),
	};
}

/** Refresh everything an issue change can touch: the issue, its project's lists and review queue. */
export function refreshIssue(qc: QueryClient, ref: string) {
	const key = projectOf(ref);
	return Promise.all([
		qc.invalidateQueries({ queryKey: ["issue", ref] }),
		qc.invalidateQueries({ queryKey: ["issues", key] }),
		qc.invalidateQueries({ queryKey: ["review", key] }),
	]);
}

/** Show the toast for a failed write; on 412 the stale issue data is refetched. */
export function useWriteFailure() {
	const toast = useToast();
	const qc = useQueryClient();
	return (e: unknown) => {
		const w = writeError(e);
		toast(w.detail ? `${t(w.key)}${w.detail}` : t(w.key));
		if (w.conflict)
			for (const k of ["issue", "issues", "review"])
				qc.invalidateQueries({ queryKey: [k] });
	};
}

/** Inline edit from the list: optimistic, rolled back on error, If-Match for field edits. */
export function useInlineEdit(key: string, onFail?: (e: unknown) => void) {
	const qc = useQueryClient();
	const writeFail = useWriteFailure();
	const fail = onFail ?? writeFail;
	const root = ["issues", key.toUpperCase()];
	return useMutation({
		mutationFn: ({ row, patch }: { row: IssueRow; patch: Patch }) =>
			patch.statusId
				? api("POST", `/issues/${encodeURIComponent(row.ref)}/move`, {
						statusId: patch.statusId,
						rank: patch.rank,
					})
				: api("PATCH", `/issues/${encodeURIComponent(row.ref)}`, patch, {
						"if-match": etagOf(row.updatedAt),
					}),
		onMutate: async ({ row, patch }) => {
			await qc.cancelQueries({ queryKey: root });
			const snap = qc.getQueriesData({ queryKey: root });
			qc.setQueriesData({ queryKey: root }, (d) => mapPages(d, row.ref, patch));
			return snap;
		},
		onError: (e, _v, snap) => {
			for (const [k, d] of snap ?? []) qc.setQueryData(k, d);
			fail(e);
		},
		onSettled: (_d, _e, { row }) => refreshIssue(qc, row.ref),
	});
}

/** One EventSource for the whole app; an event refreshes its issue and that project's lists. */
export function useLiveUpdates(enabled: boolean) {
	const qc = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		const es = new EventSource("/api/v1/events");
		const on = (ev: MessageEvent) => {
			try {
				const { ref } = JSON.parse(ev.data) as { ref?: string };
				if (ref) return void refreshIssue(qc, ref);
			} catch {}
			qc.invalidateQueries();
		};
		for (const name of EVENT_TYPES) es.addEventListener(name, on);
		return () => es.close();
	}, [enabled, qc]);
}
