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
- `tests/editor-smoke.mjs` / `tests/editor-settings.mjs` / `tests/editor-setup.mjs` /
  `tests/editor-song.mjs` / `tests/editor-lyrics.mjs` — 編集ツールのE2E。
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
- 任意フィールド: `wordlist` / `param` / `where`(初期選択)、`weightsList`(汎用の位置別重み)、
  `noteLengthRawList`(α=1のノート長生重み) / `noteLengthAlpha`(既定0.25、0でオフ)、
  `song: {title, id}`(セットアップ画面に出す現在の曲。`id` は下の `host.songs` と対応させる)
- `noteLengthRawList` があれば「変換のしかた」にノート長αを表示し、変換時に
  `raw ** alpha` を計算する。設定はUndo/RedoとJSON書き出し・再読込の対象になる

### 元歌詞(字幕用)

埋め込み元(soramimic-video 等)は元歌詞を字幕に使う。エディタのセットアップ画面に
「元歌詞(字幕用)」の入力欄を出し、行ごとの対応づけまで済ませて返す。
**変換の入力には使わない**(変換の入力は従来どおり `phrases`)。

- ホスト → エディタ: `lyrics: "<元歌詞の生テキスト>"`(任意)。初期値として欄に入る
- エディタ → ホスト: `lyrics`(編集後の生テキスト)と
  `originalLines: ["<phrases[0]に対応する元歌詞>", ...]`
  — **`phrases` と同じ長さ**で、対応づかなかった行は空文字。
  対応づけはMIDI取り込みと同じ `src/xfAlign.js`(`alignLyricsToLines`)で行う
- 読み込み直後・入力のたび・曲の差し替え後に作り直して書き戻す。
  書き出しJSONにも(持っていれば)両方載る
- 入力欄を出すのは `host` があるか `lyrics` を渡されたときだけ。
  どちらも無い環境(soramimic.com 単体)では欄ごと出ない

### 曲の選択(埋め込み元=ホストとのやりとり)

soramimic はMIDIの実体も解析も持たないので、セットアップ画面で曲を替えるときは
曲データを持っているホスト(soramimic-video 等)に依頼する。同じ
sessionStorage を共有しているだけでイベントは飛ばないので、双方ポーリングで見張る。

- ホスト → エディタ(起動時にホストが書く任意フィールド)
  - `host.songs: [{id, title}, ...]` — あればセットアップ画面に曲のselectを出す
  - `host.canUploadSong: true` — あれば「自分のMIDIを使う」ボタンを出す
- エディタ → ホスト(依頼。書いたらエディタは待機状態に入り、画面の操作を止める)
  - `hostRequest: {type: "song", id, nonce}` — カタログから曲を選んだ
  - `hostRequest: {type: "song-upload", nonce}` — 自分のMIDIを使いたい
- ホストの応答: 依頼を処理して `phrases` / `song` / `noteLengthRawList`
  (旧版互換では `weightsList` も可)と、元歌詞を持っていれば `lyrics` を
  新しい曲のものに差し替え、`results` / `tokensList` / `unitsList` /
  `originalLines` を削除して未変換に戻し、`hostRequest` を削除して書き戻す。
  キャンセル(ファイル選択をやめた等)は `phrases` を変えずに `hostRequest` だけ削除する
- エディタは `hostRequest` の消滅を1.5秒ごとに見張り、`phrases` が変わっていれば
  新しい曲でセットアップ画面を描き直す(単語リスト・パラメータの選択は維持)。
  変わっていなければ待機解除だけ。30秒応答が無ければ依頼を取り下げて待機解除する
- `host` / `hostRequest` はホスト固有の一時情報なので、書き出しJSONには載らない。
  どちらも無い環境(soramimic.com 単体)では曲名の読み取り専用表示のまま

## 読み推定API(オプション)

`conf/setting.json` の `yomiApi.url` に [soramimic-yomi](https://github.com/soramimic/soramimic-yomi) のURLを設定すると、
歌詞のトークナイズをAPI(pyopenjtalk-plus、数字・ユーザー辞書対応)に任せる。
未設定・API停止時は自動でkuromojiにフォールバックする(完全静的でも動く)。
ローカル確認: soramimic-yomi で `uv run uvicorn api.main:app --port 8123` を起動し、urlに `http://localhost:8123` を設定。
