# Tasuki

AIネイティブなチケット管理（Redmine の代替）。設計の正本は `docs/DESIGN.md`。

## ルール

- **設計を変える判断をしたら、先に `docs/DESIGN.md` を更新してからコードを変える。**
- ランタイム・パッケージ管理・テストはすべて Bun（`bun install` / `bun test`）。pnpm・npm・Vitest は使わない（bun:sqlite が Node で動かないため）。
- 書き込みはすべて `packages/core` のサービス関数を通す。Web・CLI・MCP から DB を直接触らない。
- 計画の承認・結果確認・完了は `actor.auth === 'session'` のときだけ許可する。トークン経由では絶対に通さない。
- 必須はタイトルだけ。新しい必須項目を増やさない。
- 主キーは `Bun.randomUUIDv7()`。パスワードは `Bun.password`（Argon2id）。
- 実装は Sonnet、フェーズごとのレビューは Opus。

## 構成

- `packages/schema` — Zod スキーマ（API・MCP・UI で共有）
- `packages/db` — Drizzle スキーマ、マイグレーション、シード
- `packages/core` — ドメインロジック、権限、ワークフロー強制、履歴、フィルタ書式
- `apps/server`・`apps/web`・`packages/mcp`・`packages/cli` は該当フェーズで追加する
- テストは各パッケージの `test/` に置く（`src/` に混ぜない）

## コマンド

- `bun run check` — biome ci + tsc + `bun test --coverage`（カバレッジ80%未満で失敗）
- `bun run format` — 整形
