# ADR

このディレクトリでは、Soramimic 本体の重要な設計判断を Architecture Decision
Record (ADR) として管理します。判断の背景・結論・見直し履歴を、人とエージェントの
両方が追える形で残すことを目的とします。

## 命名規則

- ファイル名は `NNNNN-short-kebab-case.md` 形式にします
- `NNNNN` は5桁の連番です
- 採番は時系列順に増やし、欠番は再利用しません
- 新規追加前に、同じ番号・ファイル名が存在しないことを確認します

## ステータス

各 ADR の先頭には次のメタデータを置きます。

```md
# ADR 00001: Title

- Status: accepted
- Date: 2026-08-13
- Supersedes: none
- Superseded by: none
```

ステータスは `proposed`（提案中）、`accepted`（現在有効）、`superseded`
（後続ADRに置換）の3つです。既存ADRを置き換える場合も削除せず、古いADRの
`Superseded by` と新しいADRの `Supersedes` から相互参照します。

## テンプレート

```md
# ADR NNNNN: Title

- Status: proposed
- Date: YYYY-MM-DD
- Supersedes: none
- Superseded by: none

## Context

この判断が必要になった背景を書く。

## Decision

採用する判断を簡潔に書く。

## Consequences

得られる利点、受け入れるトレードオフ、見直し条件を書く。
```
