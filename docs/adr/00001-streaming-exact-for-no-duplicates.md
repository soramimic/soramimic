# ADR 00001: 重複なし生成では streaming exact 検索を使用する

- Status: accepted
- Date: 2026-08-13

## Decision

- 重複を許さない生成では近似候補検索を使わず、exact候補検索を使用する。
- 同じ入力と設定に対する候補選択、score、fillerの互換性を維持する。
- 重複を許す生成と、編集用の複数候補取得APIの挙動は変更しない。
