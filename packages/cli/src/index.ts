#!/usr/bin/env bun
import { run } from "./main";

if (import.meta.main) {
	const code = await run(Bun.argv.slice(2));
	// `serve` returns the running server: keep running. Everything else exits with its code.
	if (typeof code === "number") process.exit(code);
}
