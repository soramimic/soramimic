# Soramimic

空耳歌詞(替え歌)を自動生成するサービス「Soramimic」のリポジトリ。

## 構成

- `frontend/` — Webフロントエンド(Vite + 素のJavaScript)。空耳生成アルゴリズムは `frontend/src/lib/` に実装
- `wordlists/`([soramimi-wordlists](https://github.com/soramimic/soramimi-wordlists) のsubmodule) — 野球選手名などの単語リスト本体
- `data/` — 発音類似度・かな変換などのアルゴリズム用辞書データ
- `conf/` — 単語リストの設定ファイル
- `tests/golden/` — 空耳生成アルゴリズムの出力を固定して検証する回帰テスト

## 開発

### クローン

単語リストは別リポジトリ([soramimi-wordlists](https://github.com/soramimic/soramimi-wordlists))のsubmoduleなので `--recursive` が必要:
```sh
git clone --recursive https://github.com/soramimic/soramimic.git
# 既存クローンの場合: git submodule update --init
```

### フロントエンドの起動

```sh
cd frontend
npm install
npm run dev    # 開発サーバ
npm run build  # ビルド
```

## テスト

```sh
node tests/golden/run.cjs                    # ゴールデンテスト(kuromoji・オフライン)
node tests/editor-api.mjs                    # 編集ツールlib API(getCandidates/固定再生成)
node tests/editdist.mjs                      # ン・ッ・ーの編集距離一貫性(49ペア。#105)
cd frontend && npm run test:smoke            # UIスモークテスト(実ブラウザ)
```

## デプロイ

リリーストレイン方式の2段構え:

- **dev(プレビュー)**: dev へのマージで [preview.soramimic.pages.dev](https://preview.soramimic.pages.dev) が
  自動更新される(`.github/workflows/preview.yaml`)。ここで動作確認する
- **main(本番)**: `.github/workflows/release.yaml` が週次(月曜朝)+ 手動で dev→main を
  マージし、Cloudflare Pages([soramimic.pages.dev](https://soramimic.pages.dev) = soramimic.com)へ
  デプロイする(`.github/workflows/deploy.yaml`)。main宛てPR(緊急修正)はマージで即デプロイ

## メンテナンス

### 更新

- devからfeatureブランチを切り、pushしてプルリク(baseはdev)。CIが全通過すると automerge が自動でマージし、プレビューが更新される
- 本番に出すときは Actions の release を手動実行する(または週次の自動実行を待つ)
- github actionsからtag更新(セマンティックバージョニング)
- 更新履歴は [frontend/index.html](./frontend/index.html) の「更新履歴」セクション(サイトの「サイトについて」タブ)で管理する

### 野球選手表の更新
[soramimi-wordlists](https://github.com/soramimic/soramimi-wordlists) のREADMEを参照。更新後は本リポジトリでsubmoduleを進める:
```sh
git submodule update --remote wordlists
git add wordlists && git commit
```

## ライセンス

[Apache License 2.0](./LICENSE)。同梱・利用しているサードパーティソフトウェア・データの
表示は [NOTICE](./NOTICE) を参照(kuromoji.js / mecab-ipadic 辞書のライセンスファイルは
ビルド時に配信物 `frontend/public/kuromoji/` にもコピーされる)。
