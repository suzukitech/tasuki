import { t } from "../i18n";
import { useTemplates } from "../lib/queries";
import { Menu } from "./ui";

/** Offers the project's templates; picking one hands its body to `onPick`. Hidden when there are none. */
export function TemplatePicker(p: {
	projectKey: string;
	onPick: (bodyMd: string) => void;
}) {
	const list = useTemplates(p.projectKey).data ?? [];
	if (!list.length) return null;
	return (
		<div className="mt-2">
			<Menu
				label={t("tpl.apply")}
				value=""
				options={list.map((x) => ({ value: x.id, label: x.name }))}
				onChange={(id) => {
					const x = list.find((l) => l.id === id);
					if (x) p.onPick(x.bodyTemplateMd);
				}}
				className="min-h-8 border border-line-strong bg-surface px-2 text-sm"
			>
				{t("tpl.apply")}
			</Menu>
		</div>
	);
}
