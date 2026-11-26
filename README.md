# Tasuki

**Redmineに代わる、AIネイティブなチケット管理。** An AI-native, self-hosted alternative to Redmine.

> npm の `tasuki`（別のマルチエージェント基盤）とは無関係です。このプロジェクトは `@suzukitech/tasuki` として配布します。

Tasuki は、Claude Code などのコーディングエージェントが実装と検証を担う前提で作る、チーム向けのチケット管理ツールです。人間の仕事は「何を作るかを書く」「AIの計画を承認する」「結果レポートを確かめる」の3つに絞り、承認と完了はサーバーが人間にしか許しません。

- 自社サーバーにコンテナ1つ。SQLite ファイル1つでバックアップ
- MCP サーバー内蔵。Tasuki 自身は LLM を呼ばない（API キー不要）
- MIT ライセンス

**ステータス: 開発中（v0.1 未リリース）。** 設計は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## 開発

```sh
bun install
bun run check   # lint + 型チェック + テスト
```
