import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const noop = () => {};

/**
 * Forward every JSON-RPC message both ways. `local` faces the agent (stdio), `remote` the
 * server. When a request cannot be delivered, the agent gets a JSON-RPC error instead of
 * waiting forever. Error text never includes request headers (the token).
 */
export function relay(
	local: Transport,
	remote: Transport,
	onClose: () => void,
) {
	local.onmessage = (m) => {
		remote.send(m).catch(() => {
			if ("id" in m && "method" in m)
				void local
					.send({
						jsonrpc: "2.0",
						id: m.id,
						error: {
							code: -32000,
							message: "tasuki: could not reach the server",
						},
					})
					.catch(noop);
		});
	};
	remote.onmessage = (m) => void local.send(m).catch(onClose);
	local.onclose = onClose;
	remote.onclose = onClose;
	local.onerror = remote.onerror = noop;
}

/** stdio <-> Streamable HTTP `/mcp` with a Bearer token. Resolves when stdin closes. */
export async function runRelay(
	url: string,
	token: string,
	local: Transport = new StdioServerTransport(),
) {
	const remote = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers: {
				authorization: `Bearer ${token}`,
				"x-tasuki-client": "tasuki-cli",
			},
		},
	});
	const done = Promise.withResolvers<void>();
	relay(local, remote, done.resolve);
	// the stdio transport does not notice the agent hanging up
	if (local instanceof StdioServerTransport)
		process.stdin.once("end", done.resolve);
	await remote.start();
	await local.start();
	await done.promise;
	await remote.close().catch(noop);
}
