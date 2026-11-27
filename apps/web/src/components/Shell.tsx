import { useQueryClient } from "@tanstack/react-query";
import {
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { t } from "../i18n";
import { api } from "../lib/api";
import {
	useLiveUpdates,
	useMe,
	useProject,
	useProjects,
	useReviewQueue,
} from "../lib/queries";
import { cx } from "./ui";

const link =
	"block rounded px-2 py-1.5 text-base text-ink hover:bg-paper [&.active]:bg-paper [&.active]:font-bold [&.active]:text-ai-indigo";

function Nav({ projectKey }: { projectKey?: string }) {
	const qc = useQueryClient();
	const nav = useNavigate();
	const projects = useProjects();
	const me = useMe();
	const project = useProject(projectKey ?? "");
	const queue = useReviewQueue(projectKey ?? "", project.data, me.data);
	const inReview =
		(useSearch({ strict: false }) as { view?: string }).view === "review";
	return (
		<nav className="flex flex-wrap items-center gap-1 border-b border-line bg-surface p-2 md:h-full md:w-56 md:shrink-0 md:flex-col md:items-stretch md:border-r md:border-b-0 md:p-3">
			<div className="flex items-center gap-2 md:mb-3 md:flex-col md:items-stretch">
				<span className="px-2 text-lg font-bold text-ai-indigo">
					{t("app.name")}
				</span>
				<select
					aria-label={t("nav.project")}
					className="rounded border border-line bg-surface px-2 py-1 text-base"
					value={projectKey ?? ""}
					onChange={(e) =>
						nav({ to: "/p/$key", params: { key: e.target.value } })
					}
				>
					{!projectKey && <option value="" />}
					{projects.data?.map((p) => (
						<option key={p.id} value={p.key}>
							{p.key} {p.name}
						</option>
					))}
				</select>
			</div>
			{projectKey && (
				<>
					<Link
						to="/p/$key"
						params={{ key: projectKey }}
						search={{ view: "review" }}
						className={cx(link, "flex justify-between")}
						activeOptions={{ includeSearch: true }}
						activeProps={{ className: "active" }}
					>
						{t("nav.review")}
						<span className="num text-nezumi">{queue.items.length}</span>
					</Link>
					<Link
						to="/p/$key"
						params={{ key: projectKey }}
						search={{}}
						className={link}
						// the list entry is "current" only outside the review view (one aria-current)
						activeOptions={{ includeSearch: inReview, exact: true }}
						activeProps={{ className: "active" }}
					>
						{t("nav.list")}
					</Link>
					<Link
						to="/p/$key/board"
						params={{ key: projectKey }}
						className={link}
					>
						{t("nav.board")}
					</Link>
				</>
			)}
			<Link to="/new" className={link}>
				{t("nav.newProject")}
			</Link>
			<Link to="/settings" className={link}>
				{t("nav.settings")}
			</Link>
			<div className="ml-auto text-sm text-nezumi md:mt-auto md:ml-0 md:px-2">
				{me.data?.name}
				<button
					type="button"
					className="ml-2 text-ai-indigo underline md:ml-0 md:block"
					onClick={async () => {
						await api("POST", "/auth/logout");
						qc.clear();
						nav({ to: "/login" });
					}}
				>
					{t("nav.logout")}
				</button>
			</div>
		</nav>
	);
}

export function AppLayout() {
	const me = useMe();
	const { key } = useParams({ strict: false }) as { key?: string };
	useLiveUpdates(!!me.data);
	if (me.isLoading) return null;
	if (me.isError) return <Navigate to="/login" />;
	return (
		<div className="flex h-full flex-col md:flex-row">
			<Nav projectKey={key} />
			<div className="min-h-0 min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}
