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
node tests/small-kana.mjs                    # 小書きカナ(ハァ/ウッセェ)の吸収
node tests/unit-weights.mjs                  # ユニット位置別の重み付きスコアリング
cd frontend && npm run test:smoke            # UIスモークテスト(実ブラウザ)
```

## デプロイ

開発・公開候補・本番を分けた3段構え:

- **dev（開発・動作確認）**: 開発PRを集約し、未承認のワードリストも含めて
  [dev.soramimic.pages.dev](https://dev.soramimic.pages.dev) で確認する
- **preview（次回公開候補）**: 通常は最新previewからpromotionブランチを作り、公開するdevの
  コミットだけをcherry-pickしてPRにする。devの全変更を公開候補にするときはdevから直接PRしてもよい。
  非ドラフトの同一repository PRは必須チェック成功後に自動マージされ、
  [preview.soramimic.pages.dev](https://preview.soramimic.pages.dev) に自動反映される
- **main（本番）**: preview→mainのrelease PRだけを、固定SHAの再テストと人間の明示承認後に
  マージする。mainの内容がそのまま
  [soramimic.pages.dev](https://soramimic.pages.dev)（soramimic.com）へデプロイされる

devまたはpreview向けの非ドラフト・同一repository PRは、必須チェック成功後に自動マージされ、
それぞれの固定環境へ自動デプロイされる。forkからのPR、`no-automerge`または`emergency`ラベル付き
PRは対象外。main向けPRは自動マージせず、人間が明示的に確認・マージする。
名字・学校名・市区町村・流行など品質確認中のリストはdevで試し、承認するまでpromotionへ
含めない。

promotion例:

```sh
git fetch origin dev preview
git switch -c promote/example origin/preview
git cherry-pick <dev PRで取り込んだcommit>
git push -u origin promote/example
# promote/example → preview のPRを作る（必須チェック成功後に自動マージ・デプロイ）
# devの全変更を昇格する場合は dev → preview のPRでもよい
```

週次または手動の`release` workflowはpreviewのSHAを固定して再テストし、成功時に
preview→main PRの作成リンクをjob summaryへ出す。release PRも自動マージせず、現在のhead
SHAのチェックとpreview環境を確認してから人間が手動マージする。

3ブランチ方式へ初めて移行するときは、次の順序でbootstrapする。

1. 旧release workflowを停止し、現在のmainからpreviewを作る
2. main/previewのrulesetでPR必須、削除・force-push禁止、bypassなしを設定する
3. 新workflowをdevへ入れ、そのworkflow変更だけをpreviewへpromotionする
4. 初回だけ安全に新workflowをmainへ入れ、以後はpreview→main release PRだけを使う
5. preview workflowを`ref=preview`で手動実行し、旧dev成果物が残る固定aliasを上書きする
6. devの設定に品質確認中の4リストがあり、preview/mainにはないことを実URLで確認する

mainへ緊急修正を直接入れた場合は、公開後すぐに最新mainから同期ブランチを作り、preview、
devの順に同期PRをマージする。main自体をheadとして直接pushせず、次回release候補から修正が
欠落しないようにする。

## メンテナンス

### 更新

- devからfeatureブランチを切り、pushしてプルリク(baseはdev)。CIが全通過すると automerge が自動でマージされ、dev環境が更新される
- 公開する変更をpreview向けPRにし、必須チェック後の自動マージ・自動デプロイを待つ。全変更を昇格するときはdev→previewのPRでもよい。preview確認後にActionsのreleaseを実行する（または週次実行を待つ）
- releaseが検証したSHAと現在のpreviewが一致することを確認してpreview→main PRを作り、人間が手動マージする
- github actionsからtag更新(セマンティックバージョニング)
- 更新履歴は [frontend/index.html](./frontend/index.html) の「更新履歴」セクション(サイトの「サイトについて」タブ)で管理する

### 単語リストの更新
[soramimic-wordlists](https://github.com/soramimic/soramimic-wordlists) 側で更新する(手順は同リポジトリのREADME参照)。
本リポジトリのsubmodule pinは bump-wordlists ワークフロー(週次月曜朝+Actionsから手動実行可)が
devだけを自動追従させる。更新内容をpreview/mainへ出すときは、他の変更と同じpromotionで
submodule pinのコミットを明示的に昇格する。

## ライセンス

[Apache License 2.0](./LICENSE)。同梱・利用しているサードパーティソフトウェア・データの
表示は [NOTICE](./NOTICE) を参照(kuromoji.js / mecab-ipadic 辞書のライセンスファイルは
ビルド時に配信物 `frontend/public/kuromoji/` にもコピーされる)。
