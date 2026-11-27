import {
	createRootRoute,
	createRoute,
	createRouter,
	Navigate,
	Outlet,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { InvitePage, LoginPage, SetupPage } from "./components/AuthPages";
import { NewProject } from "./components/NewProject";
import { type ListSearch, ProjectView } from "./components/ProjectView";
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
		issue: typeof s.issue === "string" ? s.issue : undefined,
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		view: s.view === "review" ? "review" : undefined,
	}),
	component: function List() {
		const { key } = useParams({ from: "/app/p/$key" });
		const search = useSearch({ from: "/app/p/$key" });
		return <ProjectView projectKey={key} search={search} />;
	},
});
const Soon = ({ k }: { k: "board.soon" | "settings.soon" }) => (
	<p className="p-6 text-nezumi">{t(k)}</p>
);
const newProject = createRoute({
	getParentRoute: () => app,
	path: "/new",
	component: () => <NewProject />,
});
const board = createRoute({
	getParentRoute: () => app,
	path: "/p/$key/board",
	component: () => <Soon k="board.soon" />,
});
const settings = createRoute({
	getParentRoute: () => app,
	path: "/settings",
	component: () => <Soon k="settings.soon" />,
});

const tree = root.addChildren([
	setup,
	login,
	invite,
	app.addChildren([home, newProject, list, board, settings]),
]);
export const router = createRouter({ routeTree: tree });
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
