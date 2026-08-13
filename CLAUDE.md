# CLAUDE.md

空耳歌詞生成サービス Soramimic。構成・開発手順は [README.md](./README.md)、進行状況は [Issue #4](https://github.com/soramimic/soramimic/issues/4)(トラッキング)を参照。

## 鉄則

1. **`frontend/src/lib/` のアルゴリズムロジックを変更しない**(旧実装から出力一致保証付きで移植)。必要ならIssueで相談し、ゴールデンテストで出力不変を証明する
2. `tests/golden/expected*/` の期待値変更は「意図した挙動変更」のときだけ(`--record` で再記録)
3. ブランチは dev から feature/* 、**開発PRのbaseは dev**。公開する変更だけをpreviewへ選択昇格し、mainへはpreviewからのみ昇格する(直接コミット・直接PRは緊急修正だけ)
4. dev向けPRは**CI全通過で automerge が自動マージ**され、[dev.soramimic.pages.dev](https://dev.soramimic.pages.dev) が更新される。preview/main向けPRは自動マージせず、開発者の明示承認後に手動マージする。previewは[preview.soramimic.pages.dev](https://preview.soramimic.pages.dev)、mainは本番(soramimic.com)へ対応する。コミットメッセージは日本語

## テスト

```sh
node tests/golden/run.cjs                       # ゴールデン(kuromoji・オフライン)
node tests/editor-api.mjs                       # 編集ツールAPI
node tests/small-kana.mjs                       # 小書きカナの吸収
node tests/unit-weights.mjs                     # ユニット位置別の重み付きスコアリング
cd frontend && npm run test:smoke               # 実ブラウザスモーク
```

## ハマりどころ

- vite dev/preview は `.gz` を再圧縮するため、kuromoji辞書は `vite.config.js` のプラグインが直接配信(触らない)
- wordlists のCSVは**末尾改行なし**(パーサが最終空行で落ちる)
