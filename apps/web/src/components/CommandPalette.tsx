import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { api } from "../lib/api";
import { projectOf } from "../lib/cache";
import { type Cmd, filterCommands, issueRefOf } from "../lib/palette";
import {
	issueQuery,
	useInlineEdit,
	useProject,
	useProjects,
} from "../lib/queries";
import type { Page } from "../lib/types";
import { cx, iconProps, Kbd } from "./ui";

/** Debounced copy of a value: the search request waits for a pause in typing. */
function useDebounced<T>(v: T, ms: number) {
	const [d, setD] = useState(v);
	useEffect(() => {
		const id = setTimeout(() => setD(v), ms);
		return () => clearTimeout(id);
	}, [v, ms]);
	return d;
}

/** Cmd/Ctrl+K: go anywhere, create, find an issue, act on the open one. Gates stay with the server. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
	const nav = useNavigate();
	const uid = useId();
	const projects = useProjects().data ?? [];
	const { key: routeKey } = useParams({ strict: false }) as { key?: string };
	const { issue: openRef } = useSearch({ strict: false }) as { issue?: string };
	const projectKey =
		routeKey ?? (openRef && projectOf(openRef)) ?? projects[0]?.key;
	// the open issue's own project decides its statuses, whatever the route says
	const issueProject = useProject(openRef ? projectOf(openRef) : "").data;
	const current = useQuery({
		...issueQuery(openRef ?? ""),
		enabled: !!openRef,
	}).data;
	const edit = useInlineEdit(openRef ? projectOf(openRef) : "");
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const before = useRef<Element | null>(document.activeElement);
	const list = useRef<HTMLDivElement>(null);

	const text = useDebounced(query.trim(), 250);
	const ref = issueRefOf(query);
	const searching = !ref && text.length >= 2 && !!projectKey;
	const found = useQuery({
		queryKey: ["palette", projectKey, text],
		queryFn: () =>
			api<Page>(
				"GET",
				`/projects/${encodeURIComponent(projectKey ?? "")}/issues?${new URLSearchParams({ q: text, limit: "10" })}`,
			),
		enabled: searching,
		staleTime: 30_000,
	});

	const close = (restore = true) => {
		onClose();
		if (restore)
			setTimeout(() => (before.current as HTMLElement | null)?.focus?.(), 0);
	};
	// run after the dialog is gone so the destination can take focus
	const openIssue = useCallback(
		(r: string) => () =>
			nav({
				to: "/p/$key",
				params: { key: projectOf(r) },
				search: (p: object) => ({ ...p, issue: r }),
			}),
		[nav],
	);

	const commands = useMemo<Cmd[]>(() => {
		const out: Cmd[] = [];
		const go = (
			id: string,
			label: string,
			to: () => unknown,
			keywords?: string,
		) =>
			out.push({
				id,
				label,
				group: "palette.group.go",
				keywords,
				run: () => void to(),
			});
		if (projectKey)
			go(
				"review",
				t("nav.review"),
				() =>
					nav({
						to: "/p/$key",
						params: { key: projectKey },
						search: { view: "review" },
					}),
				"review inbox",
			);
		for (const p of projects) {
			const label = `${p.key} ${p.name}`;
			go(
				`list:${p.key}`,
				`${label}　${t("nav.list")}`,
				() => nav({ to: "/p/$key", params: { key: p.key }, search: {} }),
				"list",
			);
			go(
				`board:${p.key}`,
				`${label}　${t("nav.board")}`,
				() =>
					nav({
						to: "/p/$key",
						params: { key: p.key },
						search: { view: "board" },
					}),
				"board kanban",
			);
		}
		go(
			"settings",
			t("nav.settings"),
			() => nav({ to: "/settings", search: {} }),
			"settings token",
		);
		go("new", t("nav.newProject"), () => nav({ to: "/new" }), "project");
		if (projectKey)
			out.push({
				id: "create",
				label: t("palette.create"),
				group: "palette.group.make",
				keywords: "new create issue ticket",
				takesFocus: true,
				run: async () => {
					await nav({ to: "/p/$key", params: { key: projectKey }, search: {} });
					setTimeout(
						() =>
							document
								.querySelector<HTMLElement>("[data-quick-create]")
								?.focus(),
						0,
					);
				},
			});
		if (openRef && issueProject && current) {
			const cur = current.issue.statusId;
			for (const s of issueProject.statuses)
				if (s.id !== cur)
					out.push({
						id: `status:${s.id}`,
						label: t("palette.status", { name: s.name }),
						group: "palette.group.issue",
						keywords: `${openRef} status move`,
						run: () =>
							edit.mutate({
								row: { ref: openRef, updatedAt: current.issue.updatedAt },
								patch: { statusId: s.id },
							}),
					});
			out.push({
				id: "closePanel",
				label: t("palette.closePanel", { ref: openRef }),
				group: "palette.group.issue",
				run: () =>
					nav({ to: ".", search: (p: object) => ({ ...p, issue: undefined }) }),
			});
		}
		return out;
	}, [projects, projectKey, issueProject, openRef, current, nav, edit.mutate]);

	const items = useMemo<Cmd[]>(() => {
		const hits: Cmd[] = [];
		if (ref)
			hits.push({
				id: `ref:${ref}`,
				label: t("palette.openRef", { ref }),
				group: "palette.group.issues",
				run: openIssue(ref),
			});
		hits.push(...filterCommands(commands, query));
		if (searching)
			for (const i of found.data?.items ?? [])
				hits.push({
					id: `issue:${i.id}`,
					label: `${i.ref} ${i.title}`,
					group: "palette.group.issues",
					run: openIssue(i.ref),
				});
		return hits;
	}, [commands, query, ref, searching, found.data, openIssue]);
	const at = Math.min(active, Math.max(items.length - 1, 0));
	const optId = (i: number) => `${uid}-${i}`;

	useEffect(() => {
		document
			.getElementById(`${uid}-${at}`)
			?.scrollIntoView({ block: "nearest" });
	}, [at, uid]);

	const choose = (c: Cmd | undefined) => {
		if (!c) return;
		close(!c.takesFocus);
		c.run();
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		const n = items.length;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (n) setActive((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
		} else if (e.key === "Enter") {
			e.preventDefault();
			choose(items[at]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === "Tab") e.preventDefault(); // one control: focus stays in the field
	};
	const status =
		searching && found.isFetching
			? t("palette.searching")
			: items.length === 0
				? t("palette.none")
				: t("palette.count", { n: items.length });

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape does the same from the keyboard
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 px-4 pt-[12vh]"
			onMouseDown={(e) => e.target === e.currentTarget && close()}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("palette.title")}
				className="pop flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-float"
			>
				<div className="flex items-center gap-2 border-b border-line px-3">
					<Search {...iconProps} className="shrink-0 text-nezumi" />
					<input
						ref={input}
						// biome-ignore lint/a11y/noAutofocus: a modal opened by a shortcut starts in its field
						autoFocus
						role="combobox"
						aria-expanded="true"
						aria-controls={`${uid}-list`}
						aria-activedescendant={items.length ? optId(at) : undefined}
						aria-autocomplete="list"
						aria-label={t("palette.title")}
						placeholder={t("palette.placeholder")}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						className="bare h-11 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-nezumi"
					/>
					<Kbd>Esc</Kbd>
				</div>
				<div
					ref={list}
					id={`${uid}-list`}
					role="listbox"
					aria-label={t("palette.title")}
					className="min-h-0 flex-1 overflow-auto p-1"
				>
					{items.map((c, i) => (
						// biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the combobox (activedescendant)
						<div
							key={c.id}
							id={optId(i)}
							role="option"
							aria-selected={i === at}
							tabIndex={-1}
							onMouseDown={(e) => e.preventDefault()}
							onPointerMove={() => setActive(i)}
							onClick={() => choose(c)}
							className={cx(
								"flex min-h-9 cursor-pointer items-center gap-3 rounded-control px-2.5 text-sm pointer-coarse:min-h-11",
								i === at && "bg-selection shadow-[inset_2px_0_0_var(--indigo)]",
							)}
						>
							<span className="min-w-0 flex-1 truncate">{c.label}</span>
							<span className="shrink-0 text-xs text-nezumi">{t(c.group)}</span>
						</div>
					))}
				</div>
				<p
					role="status"
					aria-live="polite"
					className={cx(
						"border-t border-line px-3 py-1.5 text-xs text-nezumi",
						items.length > 0 && "sr-only",
					)}
				>
					{status}
				</p>
			</div>
		</div>,
		document.body,
	);
}
