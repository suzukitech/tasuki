import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Navigate,
	Outlet,
	redirect,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { isIssueRef, isProjectKey } from "@tasuki/schema/pure";
import { InvitePage, LoginPage, SetupPage } from "./components/AuthPages";
import { NewProject } from "./components/NewProject";
import { type ListSearch, ProjectView } from "./components/ProjectView";
import { SettingsPage, type SettingsSearch } from "./components/Settings";
import { AppLayout } from "./components/Shell";
import { t } from "./i18n";
import { useProjects } from "./lib/queries";

const root = createRootRoute({ component: Outlet });

const setup = createRoute({
	getParentRoute: () => root,
	path: "/setup",
	component: SetupPage,
});
const login = createRoute({
	getParentRoute: () => root,
	path: "/login",
	component: LoginPage,
});
const invite = createRoute({
	getParentRoute: () => root,
	path: "/invite/$token",
	component: InvitePage,
});
const app = createRoute({
	getParentRoute: () => root,
	id: "app",
	component: AppLayout,
});

function Home() {
	const projects = useProjects();
	if (projects.isLoading) return null;
	const first = projects.data?.[0];
	if (first)
		return <Navigate to="/p/$key" params={{ key: first.key }} replace />;
	return <NewProject lead={t("home.empty")} />;
}
const home = createRoute({
	getParentRoute: () => app,
	path: "/",
	component: Home,
});

const list = createRoute({
	getParentRoute: () => app,
	path: "/p/$key",
	validateSearch: (s: Record<string, unknown>): ListSearch => ({
		issue: isIssueRef(s.issue) ? s.issue : undefined,
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		view: s.view === "review" || s.view === "board" ? s.view : undefined,
	}),
	component: function List() {
		const { key } = useParams({ from: "/app/p/$key" });
		const search = useSearch({ from: "/app/p/$key" });
		return <ProjectView projectKey={key} search={search} />;
	},
});
// v0.1 early builds linked the board as /p/KEY/board
const oldBoard = createRoute({
	getParentRoute: () => app,
	path: "/p/$key/board",
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/p/$key",
			params: { key: params.key },
			search: { view: "board" },
			replace: true,
		});
	},
});
const newProject = createRoute({
	getParentRoute: () => app,
	path: "/new",
	component: () => <NewProject />,
});
const settings = createRoute({
	getParentRoute: () => app,
	path: "/settings",
	validateSearch: (s: Record<string, unknown>): SettingsSearch => ({
		section: s.section === "project" ? "project" : undefined,
		project: isProjectKey(s.project) ? s.project : undefined,
	}),
	component: function Settings() {
		return <SettingsPage search={useSearch({ from: "/app/settings" })} />;
	},
});

const tree = root.addChildren([
	setup,
	login,
	invite,
	app.addChildren([home, newProject, list, oldBoard, settings]),
]);
function NotFound() {
	return (
		<main className="mx-auto max-w-md px-5 py-16">
			<h1 className="mb-2 text-xl font-semibold">{t("notfound.title")}</h1>
			<p className="mb-4 text-sm text-nezumi">{t("notfound.body")}</p>
			<Link
				to="/"
				className="rounded-control text-sm font-medium text-ai-indigo underline"
			>
				{t("notfound.back")}
			</Link>
		</main>
	);
}
export const router = createRouter({
	routeTree: tree,
	defaultNotFoundComponent: NotFound,
});
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
