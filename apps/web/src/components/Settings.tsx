import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, CircleAlert, Copy, UserMinus } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useMe, useProject, useProjects } from "../lib/queries";
import { expiryIso, type TokenRow, tokenView } from "../lib/settings";
import type { Project, ProjectDetail, Role } from "../lib/types";
import { Field } from "./Form";
import {
	Avatar,
	Button,
	Chip,
	cx,
	EmptyState,
	IconButton,
	iconProps,
	inputCls,
	Menu,
	StatusDot,
	useToast,
} from "./ui";

export type SettingsSearch = { section?: "project"; project?: string };

const card = "rounded-panel border border-line bg-surface p-4 max-md:p-3";
const H3 = ({ children }: { children: ReactNode }) => (
	<h3 className="mb-2 text-sm font-semibold">{children}</h3>
);
const ROLES: Role[] = ["manager", "member", "viewer"];
const roleOptions = () =>
	ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }));

/** Run a write: toast the server's words on failure, refetch the given queries on success. */
function useRun() {
	const toast = useToast();
	const qc = useQueryClient();
	return async (
		fn: () => Promise<unknown>,
		ok?: string,
		refetch: string[][] = [],
	) => {
		try {
			await fn();
			await Promise.all(
				refetch.map((k) => qc.invalidateQueries({ queryKey: k })),
			);
			if (ok) toast(ok, "success");
			return true;
		} catch (e) {
			toast(
				e instanceof ApiError
					? `${t("settings.fail")}${e.message}`
					: t("toast.network"),
			);
			return false;
		}
	};
}

/** Text the user will paste elsewhere, with a copy button. */
function CopyField({ label, value }: { label: string; value: string }) {
	const id = useId();
	const toast = useToast();
	const [done, setDone] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setDone(true);
			setTimeout(() => setDone(false), 2000);
		} catch {
			toast(t("settings.copy.fail"));
		}
	};
	return (
		<div className="mb-3">
			<label htmlFor={id} className="mb-1 block text-sm font-medium">
				{label}
			</label>
			<div className="flex gap-2 max-sm:flex-col">
				<input
					id={id}
					readOnly
					value={value}
					onFocus={(e) => e.currentTarget.select()}
					className={cx(
						inputCls,
						"num h-9 min-w-0 flex-1 font-mono text-xs pointer-coarse:h-11",
					)}
				/>
				<Button onClick={copy} aria-live="polite">
					{done ? <Check {...iconProps} /> : <Copy {...iconProps} />}
					{done ? t("settings.copied") : t("settings.copy")}
				</Button>
			</div>
		</div>
	);
}

/** Two-step action done in the page: the button swaps for "really?" + yes / no. */
function Confirm(p: {
	label: string;
	ask: string;
	yes: string;
	onYes: () => void;
	icon?: boolean;
}) {
	const [asking, setAsking] = useState(false);
	if (!asking)
		return p.icon ? (
			<IconButton
				icon={UserMinus}
				label={p.label}
				onClick={() => setAsking(true)}
			/>
		) : (
			<Button kind="danger" onClick={() => setAsking(true)}>
				{p.label}
			</Button>
		);
	return (
		<span className="flex flex-wrap items-center gap-2">
			<span role="alert" className="text-xs text-nezumi">
				{p.ask}
			</span>
			<Button
				kind="danger"
				onClick={() => {
					setAsking(false);
					p.onYes();
				}}
			>
				{p.yes}
			</Button>
			<Button onClick={() => setAsking(false)}>{t("gate.cancel")}</Button>
		</span>
	);
}

/* ---------- personal: access tokens ---------- */

type Issued = { id: string; token: string; claudeMcpAdd: string; name: string };

function Tokens() {
	const run = useRun();
	const projects = useProjects().data ?? [];
	const tokens = useQuery({
		queryKey: ["tokens"],
		queryFn: () => api<TokenRow[]>("GET", "/me/tokens"),
	});
	const [issued, setIssued] = useState<Issued | null>(null);
	const [name, setName] = useState("");
	const [write, setWrite] = useState(true);
	const [only, setOnly] = useState("");
	const [expires, setExpires] = useState("");
	const [busy, setBusy] = useState(false);
	const toast = useToast();
	const tokensKey = ["tokens"];

	const issue = async (e: FormEvent) => {
		e.preventDefault();
		if (busy || !name.trim()) return;
		setBusy(true);
		try {
			const r = await api<Omit<Issued, "name">>("POST", "/me/tokens", {
				name: name.trim(),
				scopes: write ? ["read", "write"] : ["read"],
				projectIds: only ? [only] : null,
				expiresAt: expiryIso(expires),
			});
			setIssued({ ...r, name: name.trim() });
			setName("");
			setExpires("");
			await tokens.refetch();
		} catch (x) {
			toast(
				x instanceof ApiError
					? `${t("settings.fail")}${x.message}`
					: t("toast.network"),
			);
		} finally {
			setBusy(false);
		}
	};
	const projectName = (id: string) =>
		projects.find((p) => p.id === id)?.key ?? id;
	return (
		<section aria-labelledby="tok" className="max-w-2xl space-y-4">
			<div>
				<h2 id="tok" className="mb-1 text-lg font-semibold">
					{t("tokens.title")}
				</h2>
				<p className="text-sm leading-relaxed text-nezumi">
					{t("tokens.lead")}
				</p>
			</div>

			{issued && (
				<section
					aria-label={t("tokens.issued.title", { name: issued.name })}
					className={cx(card, "border-ai-indigo")}
				>
					<H3>{t("tokens.issued.title", { name: issued.name })}</H3>
					<p className="mb-3 flex items-start gap-1.5 text-sm font-medium">
						<CircleAlert
							{...iconProps}
							className="mt-0.5 shrink-0 text-ai-indigo"
						/>
						{t("tokens.once")}
					</p>
					<CopyField label={t("tokens.plain")} value={issued.token} />
					<CopyField label={t("tokens.mcp")} value={issued.claudeMcpAdd} />
					<Button onClick={() => setIssued(null)}>{t("tokens.done")}</Button>
				</section>
			)}

			<form onSubmit={issue} className={card}>
				<H3>{t("tokens.new")}</H3>
				<Field
					label={t("tokens.name")}
					hint={t("tokens.name.hint")}
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={100}
					required
				/>
				<fieldset className="mb-4 min-w-0 border-0 p-0">
					<legend className="mb-1 text-sm font-medium">
						{t("tokens.scope")}
					</legend>
					{(
						[
							[true, "tokens.scope.write"],
							[false, "tokens.scope.read"],
						] as const
					).map(([v, k]) => (
						<label
							key={k}
							className="flex min-h-8 items-center gap-2 text-sm pointer-coarse:min-h-11"
						>
							<input
								type="radio"
								name="scope"
								checked={write === v}
								onChange={() => setWrite(v)}
							/>
							{t(k)}
						</label>
					))}
				</fieldset>
				<div className="mb-4 flex flex-wrap items-end gap-4">
					<div>
						<span className="mb-1 block text-sm font-medium">
							{t("tokens.project")}
						</span>
						<Menu
							label={t("tokens.project")}
							value={only}
							options={[
								{ value: "", label: t("tokens.project.all") },
								...projects.map((p) => ({
									value: p.id,
									label: `${p.key}　${p.name}`,
								})),
							]}
							onChange={setOnly}
							className="min-h-9 w-56 justify-between border border-line-strong bg-surface px-2.5 text-sm"
						/>
					</div>
					<Field
						label={t("tokens.expires")}
						type="date"
						value={expires}
						onChange={(e) => setExpires(e.target.value)}
						min={new Date().toISOString().slice(0, 10)}
						className="w-44"
					/>
				</div>
				<Button kind="primary" type="submit" disabled={busy || !name.trim()}>
					{t("tokens.create")}
				</Button>
			</form>

			<div>
				<H3>{t("tokens.list")}</H3>
				{tokens.isLoading ? null : (tokens.data?.length ?? 0) === 0 ? (
					<EmptyState icon={CircleAlert}>{t("tokens.empty")}</EmptyState>
				) : (
					<ul className="divide-y divide-line rounded-panel border border-line bg-surface">
						{[...(tokens.data ?? [])]
							.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
							.map((row) => {
								const v = tokenView(row);
								return (
									<li
										key={row.id}
										className={cx(
											"flex flex-wrap items-center gap-x-4 gap-y-2 p-3",
											v.state !== "active" && "text-nezumi",
										)}
									>
										<div className="min-w-0 flex-1 basis-56">
											<div className="flex flex-wrap items-center gap-2">
												<span className="truncate font-medium">{row.name}</span>
												<Chip>
													{t(
														v.write
															? "tokens.scope.write.short"
															: "tokens.scope.read.short",
													)}
												</Chip>
												<Chip>
													{v.projectIds
														? v.projectIds.map(projectName).join(", ")
														: t("tokens.project.all")}
												</Chip>
												{v.state !== "active" && (
													<Chip tone="sash">
														{t(`tokens.state.${v.state}`)}
													</Chip>
												)}
											</div>
											<p className="num mt-1 text-xs text-nezumi">
												{row.lastUsedAt
													? t("tokens.lastUsed", {
															when: relativeTime(row.lastUsedAt),
														})
													: t("tokens.neverUsed")}
												{row.expiresAt &&
													`　${t("tokens.expiresOn", { date: new Date(row.expiresAt).toLocaleDateString("ja-JP") })}`}
											</p>
										</div>
										{v.state === "active" && (
											<Confirm
												label={t("tokens.revoke")}
												ask={t("tokens.revoke.ask", { name: row.name })}
												yes={t("tokens.revoke.yes")}
												onYes={() =>
													run(
														() => api("DELETE", `/me/tokens/${row.id}`),
														t("tokens.revoked"),
														[tokensKey],
													)
												}
											/>
										)}
									</li>
								);
							})}
					</ul>
				)}
			</div>
		</section>
	);
}

/* ---------- project ---------- */

function Basics({
	project,
	canEdit,
}: {
	project: ProjectDetail;
	canEdit: boolean;
}) {
	const run = useRun();
	const [name, setName] = useState(project.name);
	const [description, setDescription] = useState(project.description);
	const descId = useId();
	const patch = {
		...(name.trim() !== project.name && { name: name.trim() }),
		...(description !== project.description && { description }),
	};
	const dirty = Object.keys(patch).length > 0;
	return (
		<form
			className={card}
			onSubmit={async (e) => {
				e.preventDefault();
				if (dirty)
					await run(
						() => api("PATCH", `/projects/${project.key}`, patch),
						t("settings.saved"),
						[["project", project.key], ["projects"]],
					);
			}}
		>
			<H3>{t("project.basics")}</H3>
			<Field
				label={t("project.new.name")}
				value={name}
				onChange={(e) => setName(e.target.value)}
				maxLength={100}
				required
				disabled={!canEdit}
			/>
			<div className="mb-4">
				<label htmlFor={descId} className="mb-1 block text-sm font-medium">
					{t("project.description")}
				</label>
				<textarea
					id={descId}
					rows={3}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					maxLength={4000}
					disabled={!canEdit}
					className={cx(inputCls, "resize-y leading-relaxed")}
				/>
			</div>
			{canEdit && (
				<Button kind="primary" type="submit" disabled={!dirty || !name.trim()}>
					{t("settings.save")}
				</Button>
			)}
		</form>
	);
}

function Members({
	project,
	canEdit,
}: {
	project: ProjectDetail;
	canEdit: boolean;
}) {
	const run = useRun();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("member");
	const refetch = [["project", project.key]];
	return (
		<div className={card}>
			<H3>{t("project.members")}</H3>
			<ul className="divide-y divide-line">
				{project.members.map((m) => (
					<li key={m.id} className="flex flex-wrap items-center gap-3 py-2">
						<Avatar id={m.id} name={m.name} size={24} />
						<span className="min-w-0 flex-1 basis-32 truncate font-medium">
							{m.name}
						</span>
						{canEdit ? (
							<>
								<Menu
									label={t("project.member.role", { name: m.name })}
									value={m.role}
									options={roleOptions()}
									onChange={(r) =>
										run(
											() =>
												api(
													"PATCH",
													`/projects/${project.key}/members/${m.id}`,
													{ role: r },
												),
											t("settings.saved"),
											refetch,
										)
									}
									className="min-h-8 border border-line-strong bg-surface px-2 text-sm"
								/>
								<Confirm
									icon
									label={t("project.member.remove", { name: m.name })}
									ask={t("project.member.remove.ask", { name: m.name })}
									yes={t("project.member.remove.yes")}
									onYes={() =>
										run(
											() =>
												api(
													"DELETE",
													`/projects/${project.key}/members/${m.id}`,
												),
											t("project.member.removed"),
											refetch,
										)
									}
								/>
							</>
						) : (
							<Chip>{t(`role.${m.role}`)}</Chip>
						)}
					</li>
				))}
			</ul>
			{canEdit && (
				<form
					className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
					onSubmit={async (e) => {
						e.preventDefault();
						if (
							await run(
								() =>
									api("POST", `/projects/${project.key}/members`, {
										email,
										role,
									}),
								t("project.member.added"),
								refetch,
							)
						)
							setEmail("");
					}}
				>
					<div className="min-w-56 flex-1">
						<Field
							label={t("project.member.add")}
							hint={t("project.member.add.hint")}
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
					</div>
					<div className="mb-[calc(1rem+1.2em)] max-sm:mb-4">
						<Menu
							label={t("project.member.newRole")}
							value={role}
							options={roleOptions()}
							onChange={(r) => setRole(r as Role)}
							className="min-h-9 border border-line-strong bg-surface px-2.5 text-sm"
						/>
					</div>
					<Button
						type="submit"
						className="mb-[calc(1rem+1.2em)] max-sm:mb-4"
						disabled={!email.trim()}
					>
						{t("project.member.submit")}
					</Button>
				</form>
			)}
		</div>
	);
}

function Invite() {
	const run = useRun();
	const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
		null,
	);
	return (
		<div className={card}>
			<H3>{t("invite.title")}</H3>
			<p className="mb-3 text-sm leading-relaxed text-nezumi">
				{t("invite.lead")}
			</p>
			<Button
				onClick={async () => {
					await run(async () => setLink(await api("POST", "/invites")));
				}}
			>
				{t("invite.create")}
			</Button>
			{link && (
				<div className="mt-4">
					<CopyField label={t("invite.link")} value={link.url} />
					<p className="num text-xs text-nezumi">
						{t("invite.expires", {
							date: new Date(link.expiresAt).toLocaleDateString("ja-JP"),
						})}
					</p>
				</div>
			)}
		</div>
	);
}

function StatusRow({
	project,
	status,
	canEdit,
}: {
	project: ProjectDetail;
	status: ProjectDetail["statuses"][number];
	canEdit: boolean;
}) {
	const run = useRun();
	const [name, setName] = useState(status.name);
	const id = useId();
	const dirty = name.trim() !== status.name && name.trim() !== "";
	return (
		<form
			className="flex flex-wrap items-center gap-3 py-2"
			onSubmit={async (e) => {
				e.preventDefault();
				if (dirty)
					await run(
						() =>
							api("PATCH", `/projects/${project.key}/statuses/${status.id}`, {
								name: name.trim(),
							}),
						t("settings.saved"),
						[["project", project.key], ["issue"]],
					);
			}}
		>
			<StatusDot category={status.category} />
			<label htmlFor={id} className="sr-only">
				{t("project.status.name", {
					category: t(`category.${status.category}`),
				})}
			</label>
			<input
				id={id}
				value={name}
				onChange={(e) => setName(e.target.value)}
				maxLength={50}
				disabled={!canEdit}
				className={cx(inputCls, "h-9 max-w-64 flex-1 pointer-coarse:h-11")}
			/>
			<span className="text-xs text-nezumi">
				{t(`category.${status.category}`)}
			</span>
			{canEdit && dirty && <Button type="submit">{t("settings.save")}</Button>}
		</form>
	);
}

function ProjectSettings({ search }: { search: SettingsSearch }) {
	const nav = useNavigate();
	const me = useMe().data;
	const projects = useProjects().data ?? [];
	const cur: Project | undefined =
		projects.find((p) => p.key === search.project) ?? projects[0];
	const detail = useProject(cur?.key ?? "").data;
	if (!cur)
		return <EmptyState icon={CircleAlert}>{t("home.empty")}</EmptyState>;
	const canEdit = cur.role === "manager";
	return (
		<section aria-labelledby="prj" className="max-w-2xl space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<h2 id="prj" className="mr-auto text-lg font-semibold">
					{t("project.title")}
				</h2>
				<Menu
					label={t("nav.project")}
					value={cur.key}
					options={projects.map((p) => ({
						value: p.key,
						label: `${p.key}　${p.name}`,
					}))}
					onChange={(project) =>
						nav({ to: "/settings", search: { section: "project", project } })
					}
					className="min-h-9 w-64 justify-between border border-line-strong bg-surface px-2.5 text-sm"
				/>
			</div>
			{!canEdit && (
				<p className="text-sm text-nezumi">{t("project.readonly")}</p>
			)}
			{detail && (
				<>
					{/* remount when the saved values change so the form shows what the server holds */}
					<Basics
						key={`${detail.key}${detail.name}${detail.description}`}
						project={detail}
						canEdit={canEdit}
					/>
					<Members project={detail} canEdit={canEdit} />
					{me?.role === "admin" && <Invite />}
					<div className={card}>
						<H3>{t("project.statuses")}</H3>
						<p className="mb-2 text-sm text-nezumi">
							{t("project.statuses.lead")}
						</p>
						{detail.statuses.map((s) => (
							<StatusRow
								key={`${s.id}${s.name}`}
								project={detail}
								status={s}
								canEdit={canEdit}
							/>
						))}
					</div>
					<p className="text-xs text-nezumi">{t("project.templates.later")}</p>
				</>
			)}
		</section>
	);
}

export function SettingsPage({ search }: { search: SettingsSearch }) {
	const tab = search.section === "project" ? "project" : "tokens";
	return (
		<div className="h-full overflow-auto px-5 pt-4 pb-10 max-md:px-3">
			<h1 className="mb-3 text-xl font-semibold">{t("nav.settings")}</h1>
			<nav
				aria-label={t("settings.sections")}
				className="mb-5 flex gap-1 border-b border-line"
			>
				{(
					[
						["tokens", "settings.personal"],
						["project", "settings.project"],
					] as const
				).map(([id, k]) => (
					<Link
						key={id}
						to="/settings"
						search={
							id === "project"
								? { section: "project", project: search.project }
								: {}
						}
						aria-current={tab === id ? "page" : undefined}
						className={cx(
							"-mb-px flex min-h-9 items-center border-b-2 px-3 text-sm pointer-coarse:min-h-11",
							tab === id
								? "border-ai-indigo font-medium text-ai-indigo"
								: "border-transparent text-nezumi hover:text-ink",
						)}
					>
						{t(k)}
					</Link>
				))}
			</nav>
			{tab === "tokens" ? <Tokens /> : <ProjectSettings search={search} />}
		</div>
	);
}
