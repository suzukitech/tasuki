import { ja, type Key } from "./ja";

export type { Key };

export function t(key: Key, params?: Record<string, string | number>): string {
	const s: string = ja[key];
	return params
		? s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""))
		: s;
}
