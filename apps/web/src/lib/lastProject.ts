import { useEffect } from "react";
import { useProjects } from "./queries";

const STORE = "tasuki:lastProject";
const read = () => {
	try {
		return localStorage.getItem(STORE);
	} catch {
		return null;
	}
};

/**
 * The project the screen is about. Pages outside /p/$key (settings) have no project in the URL, so
 * fall back to the last one visited, then the first. A visited `key` is remembered.
 */
export function useCurrentProject(key?: string) {
	const projects = useProjects().data;
	const known = !!key && !!projects?.some((p) => p.key === key);
	useEffect(() => {
		if (!known || !key) return;
		try {
			localStorage.setItem(STORE, key);
		} catch {}
	}, [known, key]);
	if (key && (known || !projects)) return key; // an unknown key falls back like no key
	const last = read();
	return projects?.find((p) => p.key === last)?.key ?? projects?.[0]?.key;
}
