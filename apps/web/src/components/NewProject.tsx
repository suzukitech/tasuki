import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../lib/api";
import type { Project } from "../lib/types";
import { Button, inputCls } from "./ui";

/** Minimal create form: key + name. Core decides who may (any signed-in user with write access). */
export function NewProject({ lead }: { lead?: string }) {
	const qc = useQueryClient();
	const nav = useNavigate();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		setBusy(true);
		setError("");
		try {
			const p = await api<Project>("POST", "/projects", {
				key: String(f.get("key")).trim().toUpperCase(),
				name: String(f.get("name")).trim(),
			});
			await qc.invalidateQueries({ queryKey: ["projects"] });
			await nav({ to: "/p/$key", params: { key: p.key } });
		} catch (x) {
			setError(
				x instanceof ApiError
					? `${t("project.new.fail")}${x.message}`
					: t("project.new.fail"),
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<main className="mx-auto mt-10 w-full max-w-sm px-4">
			<h1 className="mb-2 text-xl font-bold">{t("project.new.title")}</h1>
			{lead && <p className="mb-4 text-nezumi">{lead}</p>}
			<form onSubmit={submit}>
				<label className="mb-3 block text-sm font-bold">
					{t("project.new.key")}
					<input
						name="key"
						required
						pattern="[A-Za-z]{2,10}"
						className={`${inputCls} num mt-1 font-normal uppercase`}
					/>
				</label>
				<label className="mb-3 block text-sm font-bold">
					{t("project.new.name")}
					<input
						name="name"
						required
						maxLength={100}
						className={`${inputCls} mt-1 font-normal`}
					/>
				</label>
				{error && (
					<p role="alert" className="mb-3 text-sash">
						{error}
					</p>
				)}
				<Button kind="primary" type="submit" disabled={busy}>
					{t("project.new.submit")}
				</Button>
			</form>
		</main>
	);
}
