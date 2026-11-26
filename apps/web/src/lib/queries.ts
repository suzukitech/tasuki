import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { useToast } from "../components/ui";
import { t } from "../i18n";
import { api } from "./api";
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
		queryKey: ["project", key],
		queryFn: () => api<ProjectDetail>("GET", `/projects/${key}`),
	});

export const issueQuery = (ref: string) => ({
	queryKey: ["issue", ref],
	queryFn: () => api<IssueDetail>("GET", `/issues/${ref}`),
});
export const useIssue = (ref: string) => useQuery(issueQuery(ref));

export function useIssues(key: string, q: string) {
	return useInfiniteQuery({
		queryKey: ["issues", key, q],
		initialPageParam: undefined as number | undefined,
		queryFn: ({ pageParam }) => {
			const p = new URLSearchParams({ q, limit: "50" });
			if (pageParam) p.set("cursor", String(pageParam));
			return api<Page>("GET", `/projects/${key}/issues?${p}`);
		},
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
}

/** Issues waiting on this user: plan / report reviews where it is their turn. */
export function useReviewQueue(key: string, project?: ProjectDetail, me?: Me) {
	const res = useQueries({
		queries: ["plan_review", "impl_review"].map((s) => ({
			queryKey: ["issues", key, `review:${s}`],
			queryFn: () =>
				api<Page>("GET", `/projects/${key}/issues?q=status:${s}&limit=200`),
		})),
	});
	const items: IssueRow[] =
		project && me
			? res
					.flatMap((r) => r.data?.items ?? [])
					.filter((i) => turnOf(i, project.statuses, me.id) === "you")
					.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) // longest waiting first
			: [];
	return { items, loading: res.some((r) => r.isLoading) };
}

/** Show the toast for a failed write; on 412 the caller's data is refetched. */
export function useWriteFailure() {
	const toast = useToast();
	const qc = useQueryClient();
	return (e: unknown) => {
		const w = writeError(e);
		toast(w.detail ? `${t(w.key)}${w.detail}` : t(w.key));
		if (w.conflict) qc.invalidateQueries();
	};
}

type Patch = {
	statusId?: string;
	assigneeId?: string | null;
	priority?: number | null;
};
const mapPages = (
	d: InfiniteData<Page> | undefined,
	ref: string,
	patch: Patch,
): InfiniteData<Page> | undefined =>
	d && {
		...d,
		pages: d.pages.map((p) => ({
			...p,
			items: p.items.map((i) => (i.ref === ref ? { ...i, ...patch } : i)),
		})),
	};

/** Inline edit from the list: optimistic, rolled back on error, If-Match for field edits. */
export function useInlineEdit(key: string) {
	const qc = useQueryClient();
	const fail = useWriteFailure();
	return useMutation({
		mutationFn: ({ row, patch }: { row: IssueRow; patch: Patch }) =>
			patch.statusId
				? api("POST", `/issues/${row.ref}/move`, { statusId: patch.statusId })
				: api("PATCH", `/issues/${row.ref}`, patch, {
						"if-match": etagOf(row.updatedAt),
					}),
		onMutate: async ({ row, patch }) => {
			await qc.cancelQueries({ queryKey: ["issues", key] });
			const snap = qc.getQueriesData<InfiniteData<Page>>({
				queryKey: ["issues", key],
			});
			qc.setQueriesData<InfiniteData<Page>>(
				{ queryKey: ["issues", key] },
				(d) => mapPages(d, row.ref, patch),
			);
			return snap;
		},
		onError: (e, _v, snap) => {
			for (const [k, d] of snap ?? []) qc.setQueryData(k, d);
			fail(e);
		},
		onSettled: (_d, _e, { row }) => {
			qc.invalidateQueries({ queryKey: ["issues", key] });
			qc.invalidateQueries({ queryKey: ["issue", row.ref] });
		},
	});
}

const EVENTS = [
	"issue.created",
	"issue.updated",
	"issue.deleted",
	"issue.moved",
	"issue.started",
	"issue.completed",
	"issue.commented",
	"plan.submitted",
	"plan.approved",
	"criteria.updated",
	"evidence.recorded",
	"report.submitted",
	"report.returned",
	"question.asked",
	"question.answered",
];

/** One EventSource for the whole app; every event refreshes the affected issue and the lists. */
export function useLiveUpdates(enabled: boolean) {
	const qc = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		const es = new EventSource("/api/v1/events");
		const on = (ev: MessageEvent) => {
			try {
				const { ref } = JSON.parse(ev.data) as { ref?: string };
				if (ref) qc.invalidateQueries({ queryKey: ["issue", ref] });
			} catch {}
			qc.invalidateQueries({ queryKey: ["issues"] });
		};
		for (const name of EVENTS) es.addEventListener(name, on);
		return () => es.close();
	}, [enabled, qc]);
}
