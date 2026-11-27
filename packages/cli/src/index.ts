#!/usr/bin/env bun
import { run } from "./main";

if (import.meta.main) {
	const code = await run(Bun.argv.slice(2));
	// `serve` returns undefined: keep running. Everything else exits with its code.
	if (code !== undefined) process.exit(code);
}
