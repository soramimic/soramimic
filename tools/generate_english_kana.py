#!/usr/bin/env python3
"""data/english-kana.json を CMUdict + e2k から事前生成するスクリプト。

## 背景

`js/English.js` は英単語をカナに変換するのに `data/english-kana.json`
(旧 `data/bep-eng.json`) を実行時にそのまま辞書引きしている。
`bep-eng.json` は GPL-2.0 の bep-eng.dic 由来でライセンス上好ましくないため、
寛容ライセンスの CMUdict (発音) + e2k (Unlicense, 音素→カナのモデル) から
静的な辞書 JSON をビルド時に事前生成し、差し替える。
(soramimic/soramimic#38, soramimic/soramimi-yomi#1 と同方針)

辞書キーは大文字化した単語とし、アポストロフィは保持する。1文字語に異形発音が
ある場合は、アルファベットの読みとして使う異形を優先する。

## 生成手順 (再生成する場合)

1. CMUdict の生データを取得する (BSD類似の寛容ライセンス。PyPIの `cmudict`
   パッケージは GPL-3.0 ラッパーのため使わないこと):

       curl -o tools/cmudict.dict \
         https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict
       curl -o tools/cmudict_LICENSE \
         https://raw.githubusercontent.com/cmusphinx/cmudict/master/LICENSE

2. Python 3.9+ に `e2k` をインストールする:

       pip install e2k

3. このスクリプトを実行する:

       python3 tools/generate_english_kana.py \
         --cmudict tools/cmudict.dict \
         --output data/english-kana.json \
         --license-output data/english-kana.LICENSE \
         --cmudict-license tools/cmudict_LICENSE

   動作確認だけしたい場合は `--limit 100` などで対象語彙を絞れる。

4. 生成された `data/english-kana.json` と `data/english-kana.LICENSE` を
   コミットする。`tools/cmudict.dict` 自体はリポジトリには含めない
   (手順1で都度取得する)。

## 上書き辞書

`tools/english_overrides.csv` に「機械変換の結果が明らかにおかしい」
頻出語を word,kana 形式で列挙している (soramimic/soramimi-yomi の
`english_overrides.csv` と同内容)。この辞書の内容は生成結果より
常に優先される。
"""

from __future__ import annotations

import argparse
import csv
import json
import multiprocessing
import re
import sys
import time
from pathlib import Path

_TOOLS_DIR = Path(__file__).parent
_DEFAULT_CMUDICT = _TOOLS_DIR / "cmudict.dict"
_DEFAULT_CMUDICT_LICENSE = _TOOLS_DIR / "cmudict_LICENSE"
_DEFAULT_OVERRIDES = _TOOLS_DIR / "english_overrides.csv"
_DEFAULT_OUTPUT = _TOOLS_DIR.parent / "data" / "english-kana.json"
_DEFAULT_LICENSE_OUTPUT = _TOOLS_DIR.parent / "data" / "english-kana.LICENSE"

# 対象語彙: 英字とアポストロフィのみからなる語 (数字・ハイフン・ピリオド等を含む
# 語 -- "a.m.", "ad-hoc" のようなものはスキップする)。
_WORD_RE = re.compile(r"^[A-Za-z']+$")
# CMUdict の異形発音エントリ ("word(2)" 等)
_ALT_PRON_RE = re.compile(r"^(.*)\((\d+)\)$")


def parse_cmudict(path: Path) -> dict[str, tuple[str, ...]]:
    """cmudict.dict をパースして word(小文字) -> 音素列 の辞書を返す。

    - ``;;;`` で始まる行はコメントとしてスキップ
    - 行末の `` # ...`` コメントを除去
    - ``word(2)`` のような異形(第2発音以降)は主発音を優先するためスキップする。
      ただし1文字語 (アルファベット単体) だけは例外で、異形発音があれば
      そちらを採用する (モジュールdocstring参照。文字の読み方を優先するため)。
    """
    primary: dict[str, tuple[str, ...]] = {}
    single_letter_alt: dict[str, tuple[str, ...]] = {}

    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith(";;;"):
                continue
            line = line.split("#", 1)[0].rstrip()
            if not line:
                continue
            parts = line.split()
            word, phonemes = parts[0], tuple(parts[1:])
            if not phonemes:
                continue

            alt_match = _ALT_PRON_RE.match(word)
            if alt_match:
                base_word = alt_match.group(1)
                if len(base_word) == 1 and _WORD_RE.match(base_word):
                    # 1文字語の異形発音は候補として保持 (最初に見つかったものを採用)
                    single_letter_alt.setdefault(base_word.lower(), phonemes)
                continue

            if not _WORD_RE.match(word):
                continue

            primary[word.lower()] = phonemes

    for letter, phonemes in single_letter_alt.items():
        primary[letter] = phonemes

    return primary


def load_overrides(path: Path) -> dict[str, str]:
    """word,kana 形式のCSVを読み込む。キーは小文字化した単語。"""
    overrides: dict[str, str] = {}
    if not path.exists():
        return overrides
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            word = (row.get("word") or "").strip()
            kana = (row.get("kana") or "").strip()
            if word and kana:
                overrides[word.lower()] = kana
    return overrides


# --- multiprocessing ---------------------------------------------------

_worker_p2k = None


def _init_worker() -> None:
    """ワーカープロセスごとに e2k.P2K を1回だけ初期化する。

    e2k は内部で TensorFlow を使っており、何もしないとプロセスごとに
    複数スレッドで演算しようとする。ワーカーをプロセス単位で並列化している
    のに各プロセスが更にスレッドで並列化しようとすると、CPUコア数に対して
    大幅にオーバーサブスクライブして逆に遅くなる (実測で1桁以上悪化する)
    ため、各ワーカーはシングルスレッドに固定する。
    """
    global _worker_p2k
    import os

    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    os.environ["OMP_NUM_THREADS"] = "1"

    import tensorflow as tf

    tf.config.threading.set_intra_op_parallelism_threads(1)
    tf.config.threading.set_inter_op_parallelism_threads(1)

    from e2k import P2K

    _worker_p2k = P2K()


def _convert_one(item: tuple[str, tuple[str, ...]]) -> tuple[str, str]:
    word, phonemes = item
    assert _worker_p2k is not None
    kana = _worker_p2k(list(phonemes))
    return word, kana


def convert_all(
    entries: list[tuple[str, tuple[str, ...]]],
    workers: int,
    log_path: Path | None,
    log_interval: int,
) -> dict[str, str]:
    result: dict[str, str] = {}
    total = len(entries)
    start = time.time()

    log_file = log_path.open("a", encoding="utf-8") if log_path else None

    def log(msg: str) -> None:
        print(msg)
        if log_file:
            log_file.write(msg + "\n")
            log_file.flush()

    log(f"[generate_english_kana] start converting {total} words with {workers} workers")

    with multiprocessing.Pool(processes=workers, initializer=_init_worker) as pool:
        for i, (word, kana) in enumerate(pool.imap(_convert_one, entries, chunksize=64), 1):
            result[word] = kana
            if i % log_interval == 0 or i == total:
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                remaining = (total - i) / rate if rate > 0 else float("inf")
                log(
                    f"[generate_english_kana] {i}/{total} "
                    f"({elapsed:.1f}s elapsed, {rate:.1f} words/s, "
                    f"ETA {remaining:.0f}s)"
                )

    if log_file:
        log_file.close()

    return result


def build_license_text(cmudict_license_path: Path) -> str:
    header = (
        "data/english-kana.json は cmusphinx/cmudict (cmudict.dict) の発音情報を"
        "元に、e2k (Unlicense) の P2K モデルでカナ化して生成した静的辞書です。"
        "生成スクリプトは tools/generate_english_kana.py を参照してください。"
        "以下は元データである CMUdict のライセンス全文です。\n\n"
    )
    license_body = cmudict_license_path.read_text(encoding="utf-8")
    return header + license_body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cmudict", type=Path, default=_DEFAULT_CMUDICT)
    parser.add_argument("--cmudict-license", type=Path, default=_DEFAULT_CMUDICT_LICENSE)
    parser.add_argument("--overrides", type=Path, default=_DEFAULT_OVERRIDES)
    parser.add_argument("--output", type=Path, default=_DEFAULT_OUTPUT)
    parser.add_argument("--license-output", type=Path, default=_DEFAULT_LICENSE_OUTPUT)
    parser.add_argument("--workers", type=int, default=multiprocessing.cpu_count())
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="動作確認用: 先頭N語だけ変換する (アルファベット順ソート前の順序)",
    )
    parser.add_argument("--log", type=Path, default=None, help="進捗ログの出力先ファイル")
    parser.add_argument("--log-interval", type=int, default=500)
    args = parser.parse_args()

    if not args.cmudict.exists():
        sys.exit(
            f"cmudict.dict が見つかりません: {args.cmudict}\n"
            "スクリプト冒頭のdocstringの手順1を参照して取得してください。"
        )

    cmudict = parse_cmudict(args.cmudict)
    entries = sorted(cmudict.items())
    if args.limit is not None:
        entries = entries[: args.limit]

    kana_by_word = convert_all(entries, args.workers, args.log, args.log_interval)

    overrides = load_overrides(args.overrides)
    for word, kana in overrides.items():
        kana_by_word[word] = kana

    result = {word.upper(): kana for word, kana in kana_by_word.items()}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    if args.cmudict_license.exists():
        license_text = build_license_text(args.cmudict_license)
        args.license_output.parent.mkdir(parents=True, exist_ok=True)
        args.license_output.write_text(license_text, encoding="utf-8")
    else:
        print(
            f"警告: {args.cmudict_license} が見つからないため "
            f"{args.license_output} は生成しませんでした",
            file=sys.stderr,
        )

    print(f"[generate_english_kana] wrote {len(result)} entries to {args.output}")


if __name__ == "__main__":
    main()
