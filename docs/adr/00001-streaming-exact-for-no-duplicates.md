# ADR 00001: 重複なし生成では streaming exact 検索を使用する

- Status: accepted
- Date: 2026-08-13
- Supersedes: none
- Superseded by: none
- Related: PR #79

## Context

PR #79 では、母音・子音の位置署名で粗い上位K IDを選び、そのIDの全読みをexact距離で
再採点する近似候補検索を導入した。重複なし生成では、後半でも未使用候補へ到達できるよう
Kを全歌詞ユニット数から広げていたため、長い曲では粗採点・ID Map・候補cacheの費用が
exact全件検索を上回る場合があった。

学校名5,677 ID・76,385発音entryに「初音ミクの消失」のXF MIDI読み1,150ユニットを
入力した測定では、現行exactのpeak RSSが約1,458 MiB、現行近似が約1,515 MiBだった。
一方、DPが各subspanで実際に採る候補は、全曲の使用済みIDと現在のprefixで使用したIDを
除いたexact最良1 IDだけである。

行単位の動的Kと、使用済みIDを検索前に除くstreaming exactを、童謡・J-POP・複数の
単語リストで比較した。J-POP歌詞は公開read APIから検証中だけ取得し、本文を保存しなかった。
14組の比較ではstreaming exactのpeak RSSが11組で小さく、2組では1〜3 MiB大きく、
1組は同値だった。速度は10組でstreaming exact、4組で動的Kが速かった。出力ID列・score・
filler数は、同点順の互換処理を含めて全組でexact基準と一致した。

最終的なstreaming実装では、候補オブジェクトMap・順位配列・GS候補cacheを作らず、
発音entryを1走査して使用可能な最良1件だけを保持する。非数値IDでは従来の同点順を
再現するため、IDと初出順だけの軽量Mapを使用する。「初音ミクの消失」のXF MIDI読みでは、
ウォームアップ後3回の中央値38.46秒、peak RSS約826 MiBとなり、現行exactの出力を
維持しながらメモリを約43%削減した。動画生成・歌声合成を含む全体パイプラインでは数秒の変換速度差より
メモリ使用量と実装の単純さを優先する。

## Decision

- `DUPLICATE=false` の生成DPは、使用済みID、固定語ID、現在のDP prefixで使用したIDを
  検索前に除外し、exact距離の最良1 IDだけをstreamingで求める。
- 同一IDの複数読みとン・ッ・ー変種はID単位の最小scoreとして扱う。同scoreの読みは
  従来どおり後勝ちとする。
- ID間の同点順は従来の通常Objectキー列挙順を維持する。配列index形式のIDは数値昇順で
  非数値IDより先、それ以外のIDは初出順とする。
- `DUPLICATE=false` の生成では `APPROX_CANDIDATES` の値にかかわらず近似候補検索を使わない。
- `DUPLICATE=true` の生成は、禁止集合が変化せず共有cacheの効果があるため、PR #79の
  近似候補検索とGS共有cacheを維持する。
- 複数候補を返す編集用 `getCandidates` APIも従来の上位N検索を維持する。
- 行単位動的K、段階的K拡張、モード自動判定は導入しない。

## Consequences

- 重複なしの長曲で、候補配列とGS cacheが占めていたメモリを削減できる。
- 粗順位に依存しないため、候補不足だけでなくexact基準との一致を保てる。
- locks、filler、位置別重み、複数読み、変種を同じexact経路で扱える。
- 反復するsubspanの多い一部入力では、動的Kと共有cacheより遅くなる。検証では
  「もし亀」16行＋野球選手、PPAP＋野球選手などで動的Kが速かった。
- 速度がパイプライン全体の主要なボトルネックになった場合は、単純な行重複率ではなく、
  subspanごとの再利用回数・変種数・関連発音entry数とcacheの推定メモリ量を測って、
  動的Kまたは索引の再導入を新しいADRで検討する。
