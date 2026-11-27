# Tasuki

**Redmineに代わる、AIネイティブなチケット管理。** An AI-native, self-hosted alternative to Redmine.

> npm の `tasuki`（別のマルチエージェント基盤）とは無関係です。このプロジェクトは `@suzukitech/tasuki` として配布します。

Tasuki は、Claude Code などのコーディングエージェントが実装と検証を担う前提で作る、チーム向けのチケット管理ツールです。人間の仕事は「何を作るかを書く」「AIの計画を承認する」「結果レポートを確かめる」の3つに絞り、承認と完了はサーバーが人間にしか許しません。

- 自社サーバーにコンテナ1つ。SQLite ファイル1つでバックアップ
- MCP サーバー内蔵。Tasuki 自身は LLM を呼ばない（API キー不要）
- MIT ライセンス

**ステータス: 開発中（v0.1 未リリース）。** 設計は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## クイックスタート

どの方法でも設定ファイルは要りません。起動したら <http://localhost:3000> を開き、最初の管理者を作ります。

**Docker（チームで使う）**

```sh
docker run -d --name tasuki -p 3000:3000 -v tasuki-data:/data ghcr.io/suzukitech/tasuki:latest
```

コンテナは非rootユーザー（UID 10001）で動きます。`-v ./data:/data` のようにホストのフォルダを使うときは、先に `chown 10001 ./data` してください。

**npx（試す・個人で使う）**

```sh
npx @suzukitech/tasuki serve --data ./tasuki-data
```

Node.js 18 以上が要りますが、中身は Bun で作った実行ファイルで、Node のバージョンには左右されません（OS ごとのパッケージが `optionalDependencies` で入ります。`--no-optional` を付けないでください）。Linux は glibc のみ対応で、Alpine（musl）では動きません。

**実行ファイル**

[GitHub Releases](https://github.com/suzukitech/tasuki/releases) から OS に合うファイル（linux / darwin の x64・arm64、windows x64）と `SHA256SUMS` をダウンロードします。

```sh
sha256sum -c SHA256SUMS --ignore-missing
chmod +x tasuki-linux-x64 && ./tasuki-linux-x64 serve
```

## HTTPS（Caddy の例）

HTTPS はリバースプロキシに任せます。Caddy なら証明書の取得と更新まで自動です。

```
tasuki.example.com {
	reverse_proxy localhost:3000
}
```

```sh
docker run -d --name tasuki -p 127.0.0.1:3000:3000 -v tasuki-data:/data \
  -e TASUKI_BASE_URL=https://tasuki.example.com \
  -e TASUKI_TRUST_PROXY=1 \
  ghcr.io/suzukitech/tasuki:latest
```

`TASUKI_BASE_URL` は利用者がブラウザで開く URL です（CSRF の Origin 検査と通知のリンクに使います）。`TASUKI_TRUST_PROXY=1` は、プロキシが付けた `X-Forwarded-For` をログインのレート制限の IP に使います。**プロキシの背後でだけ**指定してください。直接公開しているときに指定すると、IP を偽装されます。

## Claude Code から使う

設定画面でアクセストークンを発行し、次の1行で接続します。

```
claude mcp add --transport http tasuki https://<your-host>/mcp --header "Authorization: Bearer tsk_..." --header "X-Tasuki-Client: claude-code"
```

計画の承認と完了はブラウザからだけです。AIは `submit_plan` が返すURLをあなたに見せて待ちます。

**HTTP に対応しない MCP クライアントには `tasuki mcp`**（標準入出力 → HTTP の中継）を使います。トークンは環境変数で渡すと `ps` に出ません。

```json
{
	"mcpServers": {
		"tasuki": {
			"command": "npx",
			"args": ["-y", "@suzukitech/tasuki", "mcp"],
			"env": {
				"TASUKI_URL": "https://<your-host>/mcp",
				"TASUKI_TOKEN": "tsk_..."
			}
		}
	}
}
```

**AI に手順を守らせる: `tasuki agent-setup`**

プロジェクトのフォルダで実行すると、`CLAUDE.md` と `AGENTS.md` に Tasuki の作業手順（着手 → 計画 → 人間の承認を待つ → 実装 → 受け入れ条件ごとの証拠 → 報告、詰まったら質問）を書き込みます。`<!-- tasuki:start -->` と `<!-- tasuki:end -->` の間だけを更新するので、何度実行しても同じ結果で、ほかの内容は触りません。

```sh
npx @suzukitech/tasuki agent-setup --url https://<your-host>
```

## バックアップとエクスポート

データは `TASUKI_DATA`（Docker では `/data`）の `tasuki.db` と `attachments/` です。

```sh
tasuki backup --data ./tasuki-data                 # ./tasuki-data/backups/tasuki-<時刻>.db に保存
tasuki backup --data ./tasuki-data --out ./b.db    # 出力先を指定
docker exec tasuki tasuki backup --out /data/backups/manual.db
```

`backup` は SQLite の `VACUUM INTO` によるオンラインのスナップショットで、サーバーを動かしたまま取れます（`attachments/` は別にコピーしてください）。マイグレーションがある新しい版で起動したときも、適用の直前に同じ形式の自動バックアップを `<data>/backups/` に作ります。古いバックアップは自動では消えません。

```sh
tasuki export --format md   --data ./tasuki-data --out ./export   # 1チケット＝1 Markdown（YAML frontmatter 付き）
tasuki export --format json --data ./tasuki-data --out all.json   # 全データ（--out 省略で標準出力）
tasuki export --format md --project WEB ...                       # プロジェクトを絞る
```

`export` はトークンではなく**データフォルダへのファイルアクセス**で動く管理者向けのツールです（サーバーが止まっていても動きます）。DB は読み取り専用で開き、書き込みや承認はできません。

## 環境変数

| 変数                           | 既定値                               | 説明                                                          |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| `TASUKI_DATA`                  | `./tasuki-data`（Docker は `/data`） | SQLite と添付ファイルの置き場所。`--data` が優先              |
| `PORT`                         | `3000`                               | 待ち受けポート。`--port` が優先                               |
| `TASUKI_BASE_URL`              | `http://localhost:3000`              | 公開 URL。CSRF の Origin 検査と通知のリンクに使う             |
| `TASUKI_TRUST_PROXY`           | 未設定                               | `1` でリバースプロキシの `X-Forwarded-For` を信用する         |
| `TASUKI_WEBHOOK_ALLOW_PRIVATE` | 未設定                               | `1` で Webhook の送信先にプライベート IP を許す（既定は拒否） |
| `TASUKI_URL` / `TASUKI_TOKEN`  | なし                                 | `tasuki mcp` の接続先とトークン                               |

## 開発

```sh
bun install
bun run check      # lint + 型チェック + テスト（カバレッジ80%）
bun run e2e        # Playwright
bun run build:bin  # dist/bin/ に5つの実行ファイル（引数で絞れる: bun run build:bin darwin-arm64）
```

## リリース（メンテナ向け）

1. 初回だけ: npm で `@suzukitech` スコープを用意し、Automation トークンを作って、GitHub のリポジトリの Settings → Secrets and variables → Actions に `NPM_TOKEN` として登録する。GHCR への公開は `GITHUB_TOKEN` で行うので設定は不要。
2. ルートの `package.json` の `version` を上げてコミット・push する（バージョンの正本はここ。タグと違うとリリースは公開前に失敗します）。
3. `git tag vX.Y.Z && git push --tags`

タグの push で `.github/workflows/release.yml` が、チェック → 5つの実行ファイルのビルド → GitHub Release（`SHA256SUMS` 付き）→ GHCR のイメージ（amd64 / arm64）→ npm（プラットフォームのパッケージ、続いて本体）の順に公開します。`0.2.0-rc.1` のようなプレリリースは `:latest` と npm の `latest` を動かしません。通常の push と PR では公開処理は動きません（CI がイメージをビルドして起動確認するだけです）。
