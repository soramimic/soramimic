# kanasim monophone 距離データ(出自)

このディレクトリの CSV は [kanasim](https://github.com/jiroshimaya/kanasim)
(ユーザー本人のリポジトリ、Apache License 2.0)から取り込んだ
**monophone(単音素)距離テーブル**です。

- `distance_vowels_mono_hmm.csv` — 母音コア音素間の距離
- `distance_consonants_mono_hmm.csv` — 子音コア音素間の距離
- 取り込み元コミット: `jiroshimaya/kanasim@4c0d92f`
  (`src/kanasim/data/monophone/distance_{vowels,consonants}_mono_hmm.csv`)
- 形式: `phonome1,phonome2,distance` のヘッダ付き CSV。距離は**非対称**
  (`d[p1][p2]` と `d[p2][p1]` が異なりうる)

## `mono_hmm` を採用した理由(#102)

kanasim には monophone 距離が2系統ある:

- `mono_avg` — biphone(文脈依存)距離テーブルを単音素ごとに平均したもの。
  soramimic 既存の `data/simVowelsSimple.json` / `simConsonantsSimple.json`
  (= kanasim biphone 表)と同一系統
- `mono_hmm` — Julius dictation-kit の monophone GMM-HMM から、状態整列した
  モンテカルロ交差エントロピーで直接計算した距離

`mono_avg` は文脈平均のアーティファクト(sp/q(無音系)が母音に不当に近い、
s→y など摩擦音 vs 接近音の差が潰れる 等)を持つため、音響モデルから直接導出した
`mono_hmm` の方が方法論的に筋が良い。実測(#102)でも生成品質は同水準だった。

## 用途

`tools/build-mono-similarity.mjs` がこの CSV を読み、soramimic 本番の
類似度行列(`data/simVowelsMonoTie.json` / `data/simConsonantsMonoTie.json`)を
生成する。詳細はそのスクリプトのヘッダコメントを参照。
