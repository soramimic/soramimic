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
- `tests/smoke.mjs` — 実ブラウザのスモークテスト(#5)。`npm run test:smoke`

```sh
npm install
npm run dev    # 開発サーバ
npm run build  # ビルド
```

アルゴリズムに触れたら `node ../tests/golden/run.cjs` でゴールデンテストの出力一致を確認すること。

## 読み推定API(オプション)

`conf/setting.json` の `yomiApi.url` に [soramimic-yomi](https://github.com/soramimic/soramimic-yomi) のURLを設定すると、
歌詞のトークナイズをAPI(pyopenjtalk-plus、数字・ユーザー辞書対応)に任せる。
未設定・API停止時は自動でkuromojiにフォールバックする(完全静的でも動く)。
ローカル確認: soramimic-yomi で `uv run uvicorn api.main:app --port 8123` を起動し、urlに `http://localhost:8123` を設定。
