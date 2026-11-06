# Original lyric and reading alignment

Editing files keep the `soramimic-editor/1` format. The optional
`originalReadingAlignments` array associates each displayed lyric line with the
confirmed original reading in `unitsList`. It does not describe the replacement
lyrics or change the conversion input.

Each array entry is either `null` or an object:

```json
{
  "format": "soramimic-lyric-alignment/1",
  "text": "あ、空",
  "reading": "アソラ",
  "spans": [
    { "surface": [0, 2], "reading": [0, 1], "exact": true },
    { "surface": [2, 3], "reading": [1, 3], "exact": true }
  ]
}
```

- `text` is the displayed `originalLines` entry, falling back to `phrases`.
- `reading` is the concatenation of that line's original-unit pronunciations.
- All span offsets are UTF-16 code units with an inclusive start and exclusive
  end. Surface spans must not split a surrogate pair.
- Spans are ordered and nonoverlapping on both axes. A span may cover multiple
  written characters and multiple reading characters. Silent text can have an
  empty reading range with `exact: false`.
- `exact: true` identifies an aligned reading span. Estimated subtitle positions
  have `exact: false` and must not be presented as exact search highlights.

Consumers check the format, ranges, text and complete reading before using a map.
Changing either text or reading invalidates it. Reading-alignment edits also
invalidate the derived map. An absent, invalid, stale or unknown-format map does
not invalidate the editing file; consumers can regenerate it or use their
existing display behavior. Unmapped portions are not highlighted by guessing
character positions.

Older files require no conversion. Older applications can read the existing
fields of new files, but may discard this optional extension when saving. It
contains derived display information, so losing it does not lose the lyrics,
confirmed reading or selected replacement words.

Soramimic Video uses the same span format for caption pagination and editor
exports. Video stores imported maps with its project and checks their text and
reading again before reusing them for captions.
