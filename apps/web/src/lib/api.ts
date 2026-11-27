export class ApiError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, detail: string) {
		super(detail);
		this.status = status;
		this.code = code;
	}
}

export const csrfToken = () =>
	/(?:^|; )tasuki_csrf=([^;]*)/.exec(
		typeof document === "undefined" ? "" : document.cookie,
	)?.[1];

/** JSON request to /api/v1. Errors arrive as problem+json and become ApiError. */
export async function api<T>(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<T> {
	const h: Record<string, string> = { ...headers };
	if (body !== undefined) h["content-type"] = "application/json";
	const token = csrfToken();
	if (token && method !== "GET") h["x-tasuki-csrf"] = token;
	const res = await fetch(`/api/v1${path}`, {
		method,
		headers: h,
		body: body === undefined ? undefined : JSON.stringify(body),
		credentials: "same-origin",
	});
	if (res.status === 204) return undefined as T;
	const data = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new ApiError(
			res.status,
			String(data.code ?? "error"),
			String(data.detail ?? res.statusText),
		);
	return data as T;
}
