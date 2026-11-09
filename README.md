# shiro

shiro は Bun で動くローカル向けの AI チャット／コーディングエージェントです。ブラウザーから会話し、ファイル操作やシェルコマンドの実行を依頼できます。会話履歴は SQLite に保存されます。

## 必要なもの

- [Bun](https://bun.sh/)（このリポジトリでは Bun 1.4 系を使用）
- OpenAI Codex を利用できるアカウント（初回ログイン時にブラウザーで認証）

## セットアップと起動

```bash
bun install
bun run index.ts
```

`http://localhost:3000/` を開き、画面からログインしてください。ポートは `SHIRO_PORT` で変更できます。Web サーバーは `127.0.0.1` のみで待ち受けます。OAuth のコールバックにはローカルのポート `1455` を使用します。

## 主な機能

- ストリーミング形式のチャット。モデルと推論の強さを会話ごとに選択できます。
- 画像添付、Markdown 表示、会話の編集・再生成。
- SQLite による会話履歴の保存。
- エージェント用ツール：ファイルの読み書き・編集（`read_file`、`write_file`、`edit_file`）とシェル実行（`bash`）。
- シェルコマンドは通常、実行前に画面で承認します。`TYPESAFE_API_KEY` を設定し、会話の「コマンドの自動承認」を有効にすると、Jev が読み取り専用または安全性・依頼との関連性を認めたコマンドを自動実行できます。危険とみなすコマンドはルールで除外され、Jev の判定に失敗した場合もユーザー確認に戻ります。
- `PARALLEL_API_KEY` を設定すると Web 検索ツールが有効になります。検索結果の URL を回答に含めるようエージェントに指示します。

## 設定（環境変数）

| 変数 | 用途 | 既定値 |
| --- | --- | --- |
| `SHIRO_PORT` | Web サーバーのポート | `3000` |
| `SHIRO_MODEL` | 新しい会話で使う既定モデル | `gpt-6.1-sol`（`shared.ts` のモデル一覧の先頭） |
| `SHIRO_CODEX_URL` | Codex API の接続先 | `https://chatgpt.com/backend-api/codex` |
| `SHIRO_DB` | SQLite データベースのパス | `~/.shiro/shiro.db` |
| `SHIRO_AUTH_FILE` | OAuth 認証情報ファイルのパス | `~/.shiro/auth.json` |
| `PARALLEL_API_KEY` | 設定すると Web 検索を有効化 | 未設定（無効） |
| `SHIRO_PARALLEL_URL` | Web 検索 API の接続先 | `https://api.parallel.ai/v1/search` |
| `TYPESAFE_API_KEY` | 設定すると Jev によるコマンド判定を利用可能 | 未設定（無効） |
| `SHIRO_JEV_URL` | Jev API の接続先 | `https://api.typesafe.ai/v1/systemone` |
| `SHIRO_JEV_MODEL` | Jev の判定モデル | `jev-latest` |

Bun は `.env` を自動で読み込みます。API キーなどの秘密情報は `.env` に置き、共有・コミットしないでください。OAuth 認証情報ファイルは `0600` の権限で保存されます。

## 開発・確認

```bash
bun check     # 型チェック
bun test      # テスト
```

## リポジトリ構成

```text
.
├── README.md          # 概要、セットアップ、設定、構成の説明
├── CLAUDE.md          # 開発時の Bun 利用・実装方針
├── .gitignore         # 依存関係、生成物、ローカル設定などの除外
├── package.json       # 依存パッケージとスクリプト
├── bun.lock           # Bun の依存関係ロックファイル
├── tsconfig.json      # TypeScript の設定
├── index.ts           # Bun サーバー、API、会話とモデル応答の処理
├── auth.ts            # OpenAI Codex OAuth と認証情報管理
├── approve.ts         # シェルコマンドの安全性判定・Jev 連携
├── search.ts          # Parallel Web Search 連携
├── tools.ts           # エージェントに公開するツールと実行処理
├── store.ts           # SQLite による会話の永続化
├── shared.ts          # 共通の型、モデル設定、会話イベント処理
├── index.test.ts      # Bun のテスト
└── web/
    ├── index.html     # 画面の HTML エントリーポイント
    ├── app.tsx        # React のチャット UI
    └── style.css      # UI スタイル
```

`index.ts` が `web/index.html` を読み込み、HTML から React と CSS を Bun がバンドルするため、フロントエンド用の別ビルドサーバーは不要です。`.env` と `node_modules/` はローカルで使うもので、リポジトリには含めません。

## 安全上の注意

サーバーはループバックアドレスで待ち受けますが、エージェントはこのプロセスのユーザー権限でファイルを読み書きし、シェルコマンドを実行します。作業ディレクトリ内だけに制限するサンドボックスではありません。自動承認を有効にする場合も、信頼できる環境で利用してください。
