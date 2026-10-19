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

PRの必須チェック `golden` では、通常生成（重複あり・なし）、長音を含む生成、
優先単語つきの12行生成の処理時間も変更前後で比較する。同じマシンで実行順を交互に変え、
各版を5回ずつ計測して中央値を取る。各回の直前には同じ処理でウォームアップする。
実時間またはCPU時間が30％超悪化し、
その増加が実時間100ms・CPU時間50msの許容幅も超えると失敗する。
各回の計測値と比較結果はCIのSummaryと `generation-performance` artifactで確認できる。
対象は辞書読み込み後の生成処理で、ブラウザ描画・通信・起動時間は含まない。

手元では、比較元の別チェックアウトにも `frontend` の依存をインストールして実行する。
両版に同じ固定単語リスト・入力を渡すため、比較元には本リポジトリの
`tests/golden/harness-lib.mjs` が必要となる。

```sh
node tests/performance/compare.test.mjs
node tests/performance/run.mjs --base /path/to/base-checkout --report /tmp/performance-results.json
```

## ライセンス

[Apache License 2.0](./LICENSE)。同梱・利用しているサードパーティソフトウェア・データの
表示は [NOTICE](./NOTICE) を参照(kuromoji.js / mecab-ipadic 辞書のライセンスファイルは
ビルド時に配信物 `frontend/public/kuromoji/` にもコピーされる)。

### 歌詞入りMIDIの取り込み

`?midi` 付きのURLで表示される「MIDIから取り込み」は、XF MIDIと標準の歌詞入りMIDIに対応します。
標準MIDIの歌詞はUTF-8またはShift_JISで読み込みます。音符に対応する歌詞がないMIDIは取り込めません。
