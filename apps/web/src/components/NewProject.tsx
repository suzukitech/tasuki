import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../lib/api";
import type { Project } from "../lib/types";
import { Column, Field } from "./Form";
import { Button } from "./ui";

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
		<Column title={t("project.new.title")} lead={lead}>
			<form onSubmit={submit}>
				<Field
					label={t("project.new.key")}
					hint={t("project.new.key.hint")}
					name="key"
					required
					pattern="[A-Za-z]{2,10}"
					className="num uppercase"
					error={error || undefined}
				/>
				<Field
					label={t("project.new.name")}
					name="name"
					required
					maxLength={100}
				/>
				<Button
					kind="primary"
					type="submit"
					disabled={busy}
					className="mt-2 h-10 w-full"
				>
					{t("project.new.submit")}
				</Button>
			</form>
		</Column>
	);
}
