'use strict';
// 本番「バランス」プリセット(app.js)相当のデフォルトパラメータ。
// monophoneタイブレーク行列(#102)に合わせ、SAME_VOWEL/CONSONANT_REWARD の
// 掛け算ハックは撤廃(未指定=lib既定1で無効)。母音/子音の重みは VOWEL_RATIO で表す。
//   VOWEL_RATIO 0.8       ← 「音の合わせ方」スライダー(母音ロック・子音タイブレーク)
//   MID_PHRASE_BREAK_PENALTY 20 ← 文節スライダー 1(×20。MIDスイープ実測に基づく再較正)
//   WORD_NUMBER_PENALTY 20      ← 単語長スライダー 2(×10)
//   SAME_PHRASE_BREAK_REWARD 0  ← 報酬方式は廃し、文節はペナルティ方式(#98)
//   VARIATION_COST 16           ← ン/ッ/ーの1変換操作コスト(=20×VOWEL_RATIO。#105)
const DEFAULT_PARAM = {
  VOWEL_RATIO: 0.8,
  VARIATION_COST: 20 * 0.8, // =16。本番配線(app.js)と同じく VOWEL_RATIO に連動
  SAME_PHRASE_BREAK_REWARD: 0,
  MID_PHRASE_BREAK_PENALTY: 20,
  WORD_NUMBER_PENALTY: 20,
  DUPLICATE: true,
};

// wordlist の指定は conf/setting.json のエントリに準拠
module.exports = [
  {
    name: 'moshikame_baseball',
    lyric: 'sample_lyric/moshikame.txt',
    maxLines: 4,
    wordlist: {
      file: 'tests/golden/fixtures/wordlists/baseball.csv',
      dbtype: 'tidy',
      where: 'type=family or type=registered or type=full',
    },
    param: DEFAULT_PARAM,
  },
  {
    name: 'momotaro_nations',
    lyric: 'sample_lyric/momotaro.txt',
    maxLines: 2,
    wordlist: { file: 'tests/golden/fixtures/wordlists/nations.csv', dbtype: 'tidy' },
    param: DEFAULT_PARAM,
  },
  {
    name: 'furusato_pokemon',
    lyric: 'sample_lyric/furusato.txt',
    maxLines: 4,
    wordlist: { file: 'tests/golden/fixtures/wordlists/pokemon.csv', dbtype: 'tidy' },
    param: { ...DEFAULT_PARAM, DUPLICATE: false },
  },
	{
		// 対称な入力+重複ありは対称な出力になるはず(決定性の回帰テスト)
		// 1行スペース区切り入力はDPが単語境界をまたいで分割しうるケースでもある
		name: 'kanada_pokemon_dup',
		inlinePhrases: ['カナダ カナダ カナダ カナダ'],
		wordlist: { file: 'tests/golden/fixtures/wordlists/pokemon.csv', dbtype: 'tidy' },
		param: DEFAULT_PARAM,
	},
	{
		// 文節内で単語が切れることへのペナルティ(#98)の最大値ケース。
		// スライダー再較正(×5→×20)で文節重視プリセット=スライダー上限8=内部160。
		// MIDスイープ実測で MID=160 が3入力とも文節内切断ゼロの飽和点(母音の犠牲は
		// 最大-7pt)。UIの上限=160(文節重視プリセット相当)で回帰を取る
		name: 'moshikame_baseball_midphrase',
		lyric: 'sample_lyric/moshikame.txt',
		maxLines: 4,
		wordlist: {
			file: 'tests/golden/fixtures/wordlists/baseball.csv',
			dbtype: 'tidy',
			where: 'type=family or type=registered or type=full',
		},
		param: {
			...DEFAULT_PARAM,
			MID_PHRASE_BREAK_PENALTY: 160,
		},
	},
	{
		// 「音の合わせ方」を子音ロック側(VOWEL_RATIO 0.2)に振ったケース(#102)。
		// 既定 0.8 の鏡像で、子音一致を優先する。歌詞・単語リストは moshikame_baseball と同じ
		name: 'moshikame_baseball_vr02',
		lyric: 'sample_lyric/moshikame.txt',
		maxLines: 4,
		wordlist: {
			file: 'tests/golden/fixtures/wordlists/baseball.csv',
			dbtype: 'tidy',
			where: 'type=family or type=registered or type=full',
		},
		param: { ...DEFAULT_PARAM, VOWEL_RATIO: 0.2, VARIATION_COST: 20 * 0.2 },
	},
	{
		// 「音の合わせ方」を中央(VOWEL_RATIO 0.5)にしたケース(#102)。母音/子音を
		// 等重みにした中間挙動の回帰。歌詞・単語リストは moshikame_baseball と同じ
		name: 'moshikame_baseball_vr05',
		lyric: 'sample_lyric/moshikame.txt',
		maxLines: 4,
		wordlist: {
			file: 'tests/golden/fixtures/wordlists/baseball.csv',
			dbtype: 'tidy',
			where: 'type=family or type=registered or type=full',
		},
		param: { ...DEFAULT_PARAM, VOWEL_RATIO: 0.5, VARIATION_COST: 20 * 0.5 },
	},
	{
		// ン・ッ・ーの濃い入力(#105)。撥音・促音・長音の変種コストと正規化廃止で
		// これらを保持する候補が正しく勝つことの回帰(ゴメンネ→デデンネ 等)。
		// ポケモンリストで再現でき、母音ロック(VOWEL_RATIO 0.8)下の挙動を取る
		name: 'nqbar_pokemon',
		inlinePhrases: ['ゴメンネ サンタサン ホッケー'],
		wordlist: { file: 'tests/golden/fixtures/wordlists/pokemon.csv', dbtype: 'tidy' },
		param: { ...DEFAULT_PARAM, DUPLICATE: false },
	},
];
