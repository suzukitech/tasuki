import { parseArgs } from "node:util";
import type { ServeOpts, startServer } from "@tasuki/server/start";
import pkg from "../../../package.json" with { type: "json" };
import { agentSetup, mcpAddHint } from "./agent-setup";
import { backup } from "./backup";
import { exportData } from "./export";
import { insecureRemote, mcpUrl, runRelay } from "./mcp";

export const HELP = `tasuki ${pkg.version} - Redmineに代わる、AIネイティブなチケット管理

使い方: tasuki <コマンド> [オプション]

  serve         [--data DIR] [--port N]            サーバーを起動する
  backup        [--data DIR] [--out FILE]          オンラインのスナップショットを取る
  export        --format md|json [--data DIR] [--out DIR|FILE] [--project KEY]
                                                   全データを書き出す（データDIRへのファイルアクセスが要る。トークンは不要）
  mcp           --url URL [--token TOKEN]          stdio→HTTP の MCP 中継。URL はサーバーのURL（/mcp は省略可）。
                                                   トークンは環境変数 TASUKI_TOKEN で渡す（--token は ps に見える）。TASUKI_URL も可
  agent-setup   [--dir .] [--url URL]              CLAUDE.md と AGENTS.md に作業手順を書く
  healthcheck   [--port N]                         /health を確認する（Docker 用）

環境変数: TASUKI_DATA, PORT, TASUKI_BASE_URL, TASUKI_TRUST_PROXY, TASUKI_WEBHOOK_ALLOW_PRIVATE
`;

const OPTIONS = {
	data: { type: "string" },
	port: { type: "string" },
	out: { type: "string" },
	format: { type: "string" },
	project: { type: "string" },
	url: { type: "string" },
	token: { type: "string" },
	dir: { type: "string" },
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
} as const;

type Server = ReturnType<typeof startServer>;

export type Embedded = ServeOpts["embedded"];

/** A valid TCP port from --port / PORT / 3000, or undefined (the caller reports it). */
const parsePort = (v: string) =>
	/^\d+$/.test(v) && Number(v) <= 65535 ? Number(v) : undefined;

/** Returns an exit code, or the running server when `serve` took over (the caller must not exit). */
export async function run(
	argv: string[],
	embedded?: Embedded,
	io: { out: (s: string) => void; err: (s: string) => void } = {
		out: (s) => console.log(s),
		err: (s) => console.error(s),
	},
): Promise<number | Server> {
	let parsed: ReturnType<
		typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
	>;
	try {
		parsed = parseArgs({
			args: argv,
			options: OPTIONS,
			allowPositionals: true,
		});
	} catch (e) {
		io.err(`${(e as Error).message}\n\n${HELP}`);
		return 2;
	}
	const { values: v, positionals } = parsed;
	const [cmd] = positionals;
	if (v.version) {
		io.out(pkg.version);
		return 0;
	}
	if (v.help || !cmd || cmd === "help") {
		io.out(HELP);
		return cmd || v.help ? 0 : 2;
	}
	const data = v.data ?? process.env.TASUKI_DATA ?? "./tasuki-data";
	const rawPort = v.port ?? process.env.PORT ?? "3000";
	const port =
		cmd === "serve" || cmd === "healthcheck" ? parsePort(rawPort) : 0;
	if (port === undefined) {
		io.err(`--port が不正です: ${rawPort}`);
		return 2;
	}
	try {
		switch (cmd) {
			case "serve": {
				const { startServer } = await import("@tasuki/server/start");
				return startServer({ data, port, embedded });
			}
			case "backup":
				io.out(`バックアップを作成しました: ${backup(data, v.out)}`);
				return 0;
			case "export": {
				if (v.format !== "md" && v.format !== "json") {
					io.err("--format md か --format json を指定してください");
					return 2;
				}
				const r = exportData({
					data,
					format: v.format,
					out: v.out,
					project: v.project,
				});
				// json to stdout must stay machine-readable
				if (r.target !== "stdout")
					io.out(`${r.files} 件を書き出しました: ${r.target}`);
				return 0;
			}
			case "mcp": {
				const url = v.url ?? process.env.TASUKI_URL;
				const token = v.token ?? process.env.TASUKI_TOKEN;
				if (!url || !token) {
					io.err(
						"--url と --token（または TASUKI_URL / TASUKI_TOKEN）が必要です",
					);
					return 2;
				}
				const target = mcpUrl(url);
				if (insecureRemote(target))
					io.err(
						"警告: http:// でトークンを平文で送ります。ループバック以外では https:// を使ってください",
					);
				await runRelay(target, token);
				return 0;
			}
			case "agent-setup": {
				for (const f of agentSetup(v.dir ?? "."))
					io.out(
						`${f.changed ? (f.created ? "作成" : "更新") : "変更なし"}: ${f.path}`,
					);
				io.out(
					`\nClaude Code への接続例:\n${mcpAddHint(v.url ?? "https://<your-host>")}`,
				);
				return 0;
			}
			case "healthcheck": {
				const r = await fetch(`http://127.0.0.1:${port}/health`, {
					signal: AbortSignal.timeout(3000),
				}).catch(() => undefined);
				return r?.ok ? 0 : 1;
			}
			default:
				io.err(`不明なコマンド: ${cmd}\n\n${HELP}`);
				return 2;
		}
	} catch (e) {
		// never echo option values: --token must not reach the output
		io.err(`エラー: ${(e as Error).message}`);
		return 1;
	}
}
