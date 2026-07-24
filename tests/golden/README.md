# ゴールデンテスト

空耳生成アルゴリズム(`frontend/src/lib/`)の出力を期待値として固定する回帰テスト。
トークナイザは本番と同じ kuromoji で、完全オフラインで動く。

## 実行

```sh
cd frontend && npm ci && cd ..   # 初回のみ(kuromojiと辞書の取得)
node tests/golden/run.cjs
```

- ネットワーク不要
- 出力が期待値とずれると失敗し、`expected/<case>.actual.json` に実際の出力が書き出される
- CI(`.github/workflows/golden-test.yaml`)でPRごとに実行される

## 期待値の再記録

アルゴリズムの挙動を**意図して**変えたときだけ実行する:

```sh
node tests/golden/run.cjs --record
```

## 構成

- `harness-lib.mjs` — `frontend/src/lib/` (ES modules) をこのテストのインターフェースで動かす配線
- `cases.cjs` — テストケース定義(歌詞 × 単語リスト × 本番デフォルトパラメータ)
- `expected/*.json` — 期待値(ゴールデン)

## 履歴メモ

かつてはMeCab API(旧VPS)の応答をフィクスチャ再生するMeCab版ゴールデンも併存していたが、
本番がkuromojiに一本化されAPIも使わなくなったため撤去した(MeCabとの品質比較(2026-07)では
3ケース中2ケースが完全一致、残り1ケースも同等品質の別解だった)。
