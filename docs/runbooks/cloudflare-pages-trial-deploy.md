# Cloudflare Pages お試しデプロイ手順(Mac + Claude in Chrome)

frontend(mainブランチ=トランク)を Cloudflare Pages の**お試しURL**(`*.pages.dev`)に立てる手順。本番ドメイン(soramimic.com)には触れない。

## 前提

- Claude in Chrome 拡張 + `claude --chrome`(ブラウザ操作用)
- Mac に git / Node.js 20以上 / npm(なければ `brew install node gh`)
- GitHub認証済み(`gh auth login`。リポジトリはprivate)

## 1. Cloudflareアカウント作成(人間と協働)

- https://dash.cloudflare.com/sign-up で **Freeプラン**アカウントを作成(クレジットカード不要)。サインアップ自体は人間が実施(CAPTCHA対策)
- ドメイン追加ウィザードが出たらすべてスキップ

## 2. APIトークン作成(Claude in Chromeで可)

- ダッシュボード右上アイコン → My Profile → API Tokens → Create Token
- テンプレート「Cloudflare Pages — Edit」があれば使用。なければ Custom Token: **Account / Cloudflare Pages / Edit**
- トークンは画面上のCopyボタンでクリップボードにコピーし、環境変数として使う。チャット・issue・ログには絶対に書かない
  ```sh
  CLOUDFLARE_API_TOKEN=$(pbpaste) npx wrangler@latest pages ...
  ```
- Account IDはダッシュボードURL(`https://dash.cloudflare.com/<ACCOUNT_ID>/home/overview`)から取得できる。`wrangler`がアカウントID自動取得に失敗する場合は `CLOUDFLARE_ACCOUNT_ID` を明示的に渡す

## 3. ビルドとデプロイ(ターミナル)

```sh
git clone --recursive https://github.com/soramimic/soramimic.git
cd soramimic
git submodule update --init  # クローン既定の main がトランク
cd frontend
npm install
npm run build           # prebuildでkuromoji辞書がpublic/へコピーされる
CLOUDFLARE_API_TOKEN=$(pbpaste) CLOUDFLARE_ACCOUNT_ID=<account_id> \
  npx wrangler@latest pages project create soramimic --production-branch main
CLOUDFLARE_API_TOKEN=$(pbpaste) CLOUDFLARE_ACCOUNT_ID=<account_id> \
  npx wrangler@latest pages deploy dist --project-name soramimic
```

最後に表示されるURL(例: `https://xxxx.soramimic.pages.dev` / `https://soramimic.pages.dev`)を控える。

## 4. 検証(重要な順)

1. **kuromoji辞書の配信チェック**(過去にvite previewで二重解凍問題があった箇所):
   ```sh
   curl -sI https://<URL>/kuromoji/dict/base.dat.gz | grep -iE "^(HTTP|content-encoding|content-length)"
   ```
   期待: HTTP 200。`content-length`が約3956825なら素通し(正常)。`content-encoding: gzip`が付いていても、次のブラウザテストが通れば問題なし。CloudflareはHEADで`content-length`を返さないことがあるため、その場合は実際にダウンロードしてバイト数を確認する
2. **ブラウザで基本導線**: URLを開き、初期化完了(ボタンが「変換」になる。辞書DLで数秒〜十数秒)→サンプル歌詞「海」→変換→1行目が「隅田 広島 大北」になること
3. **読み推定API(クロスオリジン)**: 入力欄に「夕焼小焼の赤とんぼ」、出力形式を「替え歌読み/元歌詞読み」にして変換→元歌詞読みに**ユウヤケコヤケ**が含まれればAPI連携OK(「ユーヤキショーショー」ならフォールバック動作=CORS等の問題ありなので、ブラウザのコンソールエラーを添えて報告)
4. ポケモン・駅名など単語リスト切り替えが動くこと

## 自動デプロイ(GitHub Actions)

`main` への push(= PRの自動マージ)ごとに `.github/workflows/deploy.yaml` が
frontend をビルドして Cloudflare Pages にデプロイする。編集ツール(editor.html)も
同じ dist に含まれるので一緒に反映される。

有効化に必要な設定(**人間が一度だけ**。Settings → Secrets and variables → Actions):

```sh
# Cloudflareダッシュボードで作った API Token(Account / Cloudflare Pages / Edit)を
# クリップボードにコピーしてから:
gh secret set CLOUDFLARE_API_TOKEN  --repo soramimic/soramimic --body "$(pbpaste)"
# アカウントID(ダッシュボードURLの一部)を:
gh secret set CLOUDFLARE_ACCOUNT_ID --repo soramimic/soramimic --body "<account_id>"
```

- Secret が未設定の間、deployワークフローはスキップして成功終了する(devを赤にしない)
- **Cloudflare Pages側の Production branch も `main` にする**(Pages → プロジェクト → Settings → Builds & deployments)。でないと `--branch main` の deploy が preview 扱いになり本番URLが更新されない
- 設定後は次の main への push(自動マージ)から自動デプロイ。手動起動は Actions → deploy → Run workflow(または `gh workflow run deploy.yaml`)

## 備考

- GA4はpages.devでは発火しない設計(本番ドメイン限定)なので計測は汚れない
- 失敗しても本番(soramimic.com)には一切影響なし
- 本番ドメイン(soramimic.com)の切り替えは別issueで設計する

## 実施ログ

| 日付 | 実施者/エージェント | URL | 結果 |
| --- | --- | --- | --- |
| 2026-07-04 | Claude Code (Mac) | https://soramimic.pages.dev | 検証1〜4すべてOK([#31](https://github.com/soramimic/soramimic/issues/31)参照) |
