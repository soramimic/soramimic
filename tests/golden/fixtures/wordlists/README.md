# golden テスト用の固定 wordlist スナップショット

これらの CSV は golden テスト（`tests/golden/`）専用の**固定スナップショット**です。
`wordlists/`（soramimic-wordlists サブモジュール）は年次バッチ等で自動更新され、
そのまま golden が参照すると更新のたびに期待値がズレて壊れるため、ここに固定コピーを
置いて `tests/golden/cases.cjs` からはこちらを参照しています。

- `baseball.csv` … 元データのうち golden で使う type（family / full / registered）のみに間引き済み
- `nations.csv`, `pokemon.csv` … スナップショット時点のまま

## 意図的に更新するとき

wordlist を新しくして golden も追随させたい場合のみ、ここのファイルを更新し、
期待値を再記録する:

```sh
node tests/golden/run.cjs --record
```
