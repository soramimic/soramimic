# frontend

新しいフロントエンド(#9)。Vite + 素のJavaScript。

- `src/lib/` — 空耳生成アルゴリズム。旧実装(削除済み、gitヒストリ参照)から**ロジック無改変**で移植したES modules。
  データ(JSON)と形態素解析トークナイザは `createSoramimic()` に注入する設計で、Web非依存
- `src/app.js`, `src/main.js` — UI(旧 widget/ と機能同等)
- `src/api.js` — fetchヘルパ
- `src/lib/kuromojiTokenizer.js` — kuromoji.jsをMeCabTokenizer互換にするアダプタ
- `src/convert.js` — 入出力テキスト整形(旧 ConversionArea から移植)
- `src/xfMidi.js` — XF MIDI(カラオケ歌詞入り)から歌唱行の読みカナを抽出(MIDI取り込み。
  [soramimic-video](https://github.com/soramimic/soramimic-video) の xfparse.py と同じ解析のJS移植。
  テストは `node ../tests/xfmidi.mjs`)
- `public/` — data/wordlist/歌詞/設定へのシンボリックリンク(実体はリポジトリルート)
- `src/convertControls.js` — 変換設定UI(パラメータのスライダー/プリセット・単語重複・
  ファセット絞り込み)の共有部品。生成画面と編集ツールの両方から使う(コンテナ要素を引数で受ける)
- `tests/smoke.mjs` — 実ブラウザのスモークテスト(#5)。`npm run test:smoke`
- `tests/editor-smoke.mjs` / `tests/editor-settings.mjs` / `tests/editor-setup.mjs` — 編集ツールのE2E。
  `npm run test:editor`(タッチ操作は `tests/editor-touch.mjs`・`npm run test:touch`)

```sh
npm install
npm run dev    # 開発サーバ
npm run build  # ビルド
```

アルゴリズムに触れたら `node ../tests/golden/run.cjs` でゴールデンテストの出力一致を確認すること。

## 編集ツールに渡すデータ(sessionStorage `soramimic-editor`)

生成画面の「編集ツールで開く」や外部ツール(soramimic-video 等)は、変換対象を
sessionStorage の `soramimic-editor` に入れてから `editor.html` を開く。

- **`phrases`(行ごとの歌詞)だけが必須**。`tokensList` / `unitsList` / `results` は
  編集ツールがブラウザ内で導出できる
- `results` が無い(または空の)ときは**未変換**とみなし、セットアップ画面
  (第1ステップ: 曲・単語リスト・変換のしかた)から起動して、「この設定で変換」で
  変換してから編集画面に入る
- `results` があるときは従来どおり編集画面から始まる
- `setupFirst: true` を立てると、`results` があってもセットアップ画面から始まる
- 任意フィールド: `wordlist` / `param` / `where`(初期選択)、`weightsList`(位置別重み)、
  `song: {title}`(セットアップ画面に表示するだけ)

## 読み推定API(オプション)

`conf/setting.json` の `yomiApi.url` に [soramimic-yomi](https://github.com/soramimic/soramimic-yomi) のURLを設定すると、
歌詞のトークナイズをAPI(pyopenjtalk-plus、数字・ユーザー辞書対応)に任せる。
未設定・API停止時は自動でkuromojiにフォールバックする(完全静的でも動く)。
ローカル確認: soramimic-yomi で `uv run uvicorn api.main:app --port 8123` を起動し、urlに `http://localhost:8123` を設定。
