import { useQueryClient } from "@tanstack/react-query";
import {
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import {
	ChevronsUpDown,
	Columns3,
	Inbox,
	List,
	LogOut,
	Plus,
	Search,
	Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api } from "../lib/api";
import {
	useLiveUpdates,
	useMe,
	useProject,
	useProjects,
	useReviewQueue,
} from "../lib/queries";
import { CommandPalette } from "./CommandPalette";
import { Avatar, cx, IconButton, iconProps, Kbd, Menu } from "./ui";

const link =
	"flex min-h-8 items-center gap-2 rounded-control px-2 text-sm text-ink hover:bg-row-hover pointer-coarse:min-h-11 [&.active]:bg-selection [&.active]:font-medium [&.active]:text-ai-indigo [&.active]:shadow-[inset_2px_0_0_var(--indigo)]";

function Nav({
	projectKey,
	onPalette,
}: {
	projectKey?: string;
	onPalette: () => void;
}) {
	const qc = useQueryClient();
	const nav = useNavigate();
	const projects = useProjects();
	const me = useMe();
	const project = useProject(projectKey ?? "");
	const queue = useReviewQueue(projectKey ?? "", project.data, me.data);
	const view = (useSearch({ strict: false }) as { view?: string }).view;
	const inView = view === "review" || view === "board";
	const cur = projects.data?.find((p) => p.key === projectKey);
	const waiting = queue.items.length;
	return (
		<nav
			aria-label={t("nav.main")}
			className="flex flex-wrap items-center gap-1 border-b border-line bg-surface p-2 md:h-full md:w-56 md:shrink-0 md:flex-col md:items-stretch md:gap-0.5 md:border-r md:border-b-0 md:p-3"
		>
			<div className="flex flex-1 items-center gap-2 md:mb-2 md:flex-none md:flex-col md:items-stretch md:gap-3">
				<span className="px-2 text-lg font-semibold tracking-tight text-ai-indigo">
					{t("app.name")}
				</span>
				<Menu
					label={t("nav.project")}
					value={projectKey ?? ""}
					options={(projects.data ?? []).map((p) => ({
						value: p.key,
						label: `${p.key}　${p.name}`,
					}))}
					onChange={(key) => nav({ to: "/p/$key", params: { key } })}
					className="min-h-8 w-full min-w-0 border border-line-strong bg-surface px-2 text-sm md:justify-between"
				>
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="num font-medium text-nezumi">
							{cur?.key ?? "—"}
						</span>
						<span className="truncate">{cur?.name ?? t("nav.project")}</span>
					</span>
					<ChevronsUpDown
						{...iconProps}
						className="ml-auto shrink-0 text-nezumi"
					/>
				</Menu>
			</div>
			{/* the user block sits on the first row on a phone, at the bottom on desktop */}
			<div className="flex items-center gap-1 md:order-last md:mt-auto md:border-t md:border-line md:px-1 md:pt-3">
				{me.data && <Avatar id={me.data.id} name={me.data.name} size={24} />}
				<span className="max-w-24 truncate text-sm max-md:hidden md:max-w-none md:flex-1">
					{me.data?.name}
				</span>
				<IconButton
					icon={LogOut}
					label={t("nav.logout")}
					onClick={async () => {
						await api("POST", "/auth/logout");
						qc.clear();
						nav({ to: "/login" });
					}}
				/>
			</div>
			<div className="flex flex-wrap gap-1 max-md:basis-full md:flex-col md:gap-0.5">
				{projectKey && (
					<>
						<Link
							to="/p/$key"
							params={{ key: projectKey }}
							search={{ view: "review" }}
							className={link}
							activeOptions={{ includeSearch: true }}
							activeProps={{ className: "active" }}
						>
							<Inbox {...iconProps} />
							{t("nav.review")}
							<span
								className={cx(
									"num ml-auto rounded-full px-1.5 text-xs leading-5",
									waiting > 0
										? "bg-sash-tint font-medium text-sash"
										: "text-nezumi",
								)}
							>
								<span aria-hidden>{waiting}</span>
								<span className="sr-only">
									{t("nav.review.count", { n: waiting })}
								</span>
							</span>
						</Link>
						<Link
							to="/p/$key"
							params={{ key: projectKey }}
							search={{}}
							className={link}
							// the list entry is "current" only outside the review view (one aria-current)
							activeOptions={{ includeSearch: inView, exact: true }}
							activeProps={{ className: "active" }}
						>
							<List {...iconProps} />
							{t("nav.list")}
						</Link>
						<Link
							to="/p/$key"
							params={{ key: projectKey }}
							search={{ view: "board" }}
							className={link}
							activeOptions={{ includeSearch: true }}
							activeProps={{ className: "active" }}
						>
							<Columns3 {...iconProps} />
							{t("nav.board")}
						</Link>
					</>
				)}
				<button
					type="button"
					onClick={onPalette}
					className={cx(link, "w-full text-left")}
				>
					<Search {...iconProps} />
					{t("palette.open")}
					<span className="ml-auto">
						<Kbd>
							{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}
						</Kbd>
					</span>
				</button>
				<Link to="/new" className={link} activeProps={{ className: "active" }}>
					<Plus {...iconProps} />
					{t("nav.newProject")}
				</Link>
				<Link
					to="/settings"
					className={link}
					activeProps={{ className: "active" }}
				>
					<Settings {...iconProps} />
					{t("nav.settings")}
				</Link>
			</div>
		</nav>
	);
}

export function AppLayout() {
	const me = useMe();
	const { key } = useParams({ strict: false }) as { key?: string };
	useLiveUpdates(!!me.data);
	const [palette, setPalette] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "k" &&
				!e.isComposing
			) {
				e.preventDefault();
				setPalette((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	if (me.isLoading) return null;
	if (me.isError) return <Navigate to="/login" />;
	return (
		<div className="flex h-full flex-col md:flex-row">
			<Nav projectKey={key} onPalette={() => setPalette(true)} />
			<main className="min-h-0 min-w-0 flex-1">
				<Outlet />
			</main>
			{palette && <CommandPalette onClose={() => setPalette(false)} />}
		</div>
	);
}
