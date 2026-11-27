import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../lib/api";
import { Column, Field } from "./Form";
import { Button } from "./ui";

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

type Errs = { email?: string; name?: string; password?: string };
/** Client-side checks, so each problem shows under its own field. */
const check = (f: FormData, register: boolean): Errs => {
	const email = String(f.get("email") ?? "").trim();
	const e: Errs = {};
	if (!/^\S+@\S+$/.test(email)) e.email = t("auth.err.email");
	if (register && !String(f.get("name") ?? "").trim())
		e.name = t("auth.err.name");
	const pw = String(f.get("password") ?? "");
	if (!pw) e.password = t("auth.err.password");
	else if (register && pw.length < 8) e.password = t("auth.err.short");
	return e;
};

function Form(p: {
	submit: (e: FormEvent<HTMLFormElement>) => void;
	error: string;
	busy: boolean;
	name?: boolean;
	label: string;
}) {
	const [errs, setErrs] = useState<Errs>({});
	return (
		<form
			noValidate
			onSubmit={(e) => {
				const found = check(new FormData(e.currentTarget), !!p.name);
				setErrs(found);
				if (Object.keys(found).length) return e.preventDefault();
				p.submit(e);
			}}
		>
			<Field
				label={t("auth.email")}
				name="email"
				type="email"
				autoComplete="username"
				error={errs.email}
			/>
			{p.name && (
				<Field
					label={t("auth.name")}
					name="name"
					autoComplete="name"
					error={errs.name}
				/>
			)}
			<Field
				label={t("auth.password")}
				name="password"
				type="password"
				hint={p.name ? t("auth.password.hint") : undefined}
				autoComplete={p.name ? "new-password" : "current-password"}
				error={errs.password ?? (p.error || undefined)}
			/>
			<Button
				type="submit"
				kind="primary"
				disabled={p.busy}
				className="mt-2 h-10 w-full"
			>
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
		<Column full title={t("auth.login.title")}>
			<Form {...f} label={t("auth.login")} />
		</Column>
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
			<Column full title={t("auth.setup.title")} lead={t("auth.setup.done")}>
				<Link to="/login" className="text-ai-indigo underline">
					{t("auth.login.title")}
				</Link>
			</Column>
		);
	return (
		<Column full title={t("auth.setup.title")} lead={t("auth.setup.lead")}>
			<Form {...f} name label={t("auth.setup.submit")} />
		</Column>
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
		<Column full title={t("auth.invite.title")}>
			<Form {...f} name label={t("auth.invite.submit")} />
		</Column>
	);
}
