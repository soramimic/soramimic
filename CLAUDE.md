# CLAUDE.md

空耳歌詞生成サービス Soramimic。構成・開発手順は [README.md](./README.md)、進行状況は [Issue #4](https://github.com/soramimic/soramimic/issues/4)(トラッキング)を参照。

## 鉄則

1. **`frontend/src/lib/` のアルゴリズムロジックを変更しない**(旧実装から出力一致保証付きで移植)。必要ならIssueで相談し、ゴールデンテストで出力不変を証明する
2. `tests/golden/expected*/` の期待値変更は「意図した挙動変更」のときだけ(`--record` で再記録)
3. ブランチは dev から feature/* 、**PRのbaseは dev**。main へは release ワークフロー経由のみ(直接コミット・直接PRは緊急修正だけ。その場合は即本番デプロイされる)
4. dev向けPRは**CI全通過で automerge が自動マージ**され、[preview.soramimic.pages.dev](https://preview.soramimic.pages.dev) が更新される。本番(soramimic.com)へは release ワークフロー(週次月曜朝 + 手動)が dev→main をマージしてデプロイ。automerge を止めたいときは `no-automerge` ラベルかドラフト。コミットメッセージは日本語

## テスト

```sh
node tests/golden/run.cjs                       # ゴールデン(kuromoji・オフライン)
node tests/editor-api.mjs                       # 編集ツールAPI
node tests/small-kana.mjs                       # 小書きカナの吸収
node tests/format-kana.mjs                      # formatKanaの英字カナ化
node tests/unit-weights.mjs                     # ユニット位置別の重み付きスコアリング
node tests/ruby.mjs                             # ルビ記法(｜表層《よみ》)
node tests/wordlist-csv.mjs                     # 自作リストの正規化CSV(csvText契約)
node tests/filler.mjs                           # filler(万能候補)で行が空にならないこと
cd frontend && npm run test:smoke               # 実ブラウザスモーク
```

## ハマりどころ

- vite dev/preview は `.gz` を再圧縮するため、kuromoji辞書は `vite.config.js` のプラグインが直接配信(触らない)
- wordlists のCSVパーサは空行を無視する。正規化CSVの出力は末尾改行なしで統一する
