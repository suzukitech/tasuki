import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../lib/api";
import { Button, inputCls } from "./ui";

function Card({
	title,
	lead,
	children,
}: {
	title: string;
	lead?: string;
	children: ReactNode;
}) {
	return (
		<main className="mx-auto mt-16 w-full max-w-sm px-4">
			<h1 className="mb-2 text-xl font-bold">{title}</h1>
			{lead && <p className="mb-4 text-nezumi">{lead}</p>}
			{children}
		</main>
	);
}

function Field({
	label,
	...p
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<label className="mb-3 block text-sm font-bold">
			{label}
			<input {...p} className={`${inputCls} mt-1 font-normal`} required />
		</label>
	);
}

function useAuthForm(
	run: (f: FormData) => Promise<void>,
	failKey: "auth.login.fail" | "auth.invite.fail",
) {
	const qc = useQueryClient();
	const nav = useNavigate();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await run(new FormData(e.currentTarget));
			await qc.invalidateQueries({ queryKey: ["me"] });
			await nav({ to: "/" });
		} catch (x) {
			setError(
				x instanceof ApiError && x.status === 429 ? t("auth.rate") : t(failKey),
			);
		} finally {
			setBusy(false);
		}
	};
	return { submit, error, busy };
}

const login = async (f: FormData) => {
	await api("POST", "/auth/login", {
		email: f.get("email"),
		password: f.get("password"),
	});
};

function Form(p: {
	submit: (e: FormEvent<HTMLFormElement>) => void;
	error: string;
	busy: boolean;
	name?: boolean;
	label: string;
}) {
	return (
		<form onSubmit={p.submit}>
			<Field
				label={t("auth.email")}
				name="email"
				type="email"
				autoComplete="username"
			/>
			{p.name && (
				<Field label={t("auth.name")} name="name" autoComplete="name" />
			)}
			<Field
				label={t("auth.password")}
				name="password"
				type="password"
				minLength={p.name ? 8 : undefined}
				autoComplete={p.name ? "new-password" : "current-password"}
			/>
			{p.error && (
				<p role="alert" className="mb-3 text-sash">
					{p.error}
				</p>
			)}
			<Button type="submit" kind="primary" disabled={p.busy}>
				{p.label}
			</Button>
		</form>
	);
}

export function LoginPage() {
	const status = useQuery({
		queryKey: ["setup"],
		queryFn: () => api<{ needsSetup: boolean }>("GET", "/setup/status"),
	});
	const f = useAuthForm(login, "auth.login.fail");
	if (status.data?.needsSetup) return <Navigate to="/setup" />;
	return (
		<Card title={t("auth.login.title")}>
			<Form {...f} label={t("auth.login")} />
		</Card>
	);
}

export function SetupPage() {
	const status = useQuery({
		queryKey: ["setup"],
		queryFn: () => api<{ needsSetup: boolean }>("GET", "/setup/status"),
	});
	const f = useAuthForm(async (d) => {
		await api("POST", "/setup", {
			email: d.get("email"),
			name: d.get("name"),
			password: d.get("password"),
		});
		await login(d);
	}, "auth.login.fail");
	if (status.isLoading) return null;
	if (!status.data?.needsSetup)
		return (
			<Card title={t("auth.setup.title")} lead={t("auth.setup.done")}>
				<Link to="/login" className="text-ai-indigo underline">
					{t("auth.login.title")}
				</Link>
			</Card>
		);
	return (
		<Card title={t("auth.setup.title")} lead={t("auth.setup.lead")}>
			<Form {...f} name label={t("auth.setup.submit")} />
		</Card>
	);
}

export function InvitePage() {
	const { token } = useParams({ strict: false }) as { token: string };
	const f = useAuthForm(async (d) => {
		await api("POST", "/invites/accept", {
			token,
			email: d.get("email"),
			name: d.get("name"),
			password: d.get("password"),
		});
		await login(d);
	}, "auth.invite.fail");
	return (
		<Card title={t("auth.invite.title")}>
			<Form {...f} name label={t("auth.invite.submit")} />
		</Card>
	);
}
