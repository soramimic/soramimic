# Soramimic

空耳歌詞(替え歌)を自動生成するサービス「[Soramimic](https://soramimic.com/)」のリポジトリ。

## 構成

- `frontend/` — Webフロントエンド(Vite + 素のJavaScript)。空耳生成アルゴリズムは `frontend/src/lib/` に実装
- `wordlists/`([soramimic-wordlists](https://github.com/soramimic/soramimic-wordlists) のsubmodule) — 野球選手名などの単語リスト本体
- `data/` — 発音類似度・かな変換などのアルゴリズム用辞書データ
- `conf/` — 単語リストの設定ファイル
- `tests/golden/` — 空耳生成アルゴリズムの出力を固定して検証する回帰テスト

## 開発

### クローン

単語リストは別リポジトリ([soramimic-wordlists](https://github.com/soramimic/soramimic-wordlists))のsubmoduleなので `--recursive` が必要:
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
node tests/streaming-exact.mjs               # 重複なし生成の省メモリexact検索
cd frontend && npm run test:smoke            # UIスモークテスト(実ブラウザ)
```

## ライセンス

[Apache License 2.0](./LICENSE)。同梱・利用しているサードパーティソフトウェア・データの
表示は [NOTICE](./NOTICE) を参照(kuromoji.js / mecab-ipadic 辞書のライセンスファイルは
ビルド時に配信物 `frontend/public/kuromoji/` にもコピーされる)。
