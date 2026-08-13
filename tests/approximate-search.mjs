// 粗い音素署名で候補IDを絞り、上位だけを正確距離で再採点する検索の回帰テスト。
// 実行: node tests/approximate-search.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { buildApp } from "./golden/harness-lib.mjs";

const print = console.log.bind(console);
const h = await buildApp();
const { textAnalyzer, soramimiMaker, wordList } = h.app;

const BASE = {
	SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20,
	WORD_NUMBER_PENALTY: 20,
};
const exactParam = (extra={}) => ({...BASE,APPROX_CANDIDATES:0,...extra});
const approxParam = (extra={}) => ({...BASE,APPROX_CANDIDATES:512,...extra});
const compact = (results) => results.map(line=>line.map(word=>({
	id:word.id,
	surface:word.surface,
	pronunciation:[...word.pronunciation],
	sim:word.sim,
	start:word.start,
	end:word.end,
})));
const compareGenerate = async (label,phrases,db,param,weights=null) => {
	const startExact=performance.now();
	const exact=await h.generate(phrases,db,exactParam(param),weights);
	const exactMs=performance.now()-startExact;
	const startApprox=performance.now();
	const approx=await h.generate(phrases,db,approxParam(param),weights);
	const approxMs=performance.now()-startApprox;
	assert.deepEqual(compact(approx),compact(exact),`${label}: 近似検索と正確検索の出力`);
	print(`[ok] ${label}: exact ${exactMs.toFixed(1)}ms / approx ${approxMs.toFixed(1)}ms`);
};

// 本番規模のリストで、母音寄り・中央・子音寄りの全プリセットを比較する。
const baseball=await h.buildWordlist({
	file:"tests/golden/fixtures/wordlists/baseball.csv",
	dbtype:"tidy",
	where:"type=family or type=registered or type=full",
});
const lyrics=["もしもし かめよ かめさんよ","せかいの うちで おまえほど"];
for(const ratio of [0.2,0.5,0.8]){
	await compareGenerate(`実リスト VOWEL_RATIO=${ratio}`,lyrics,baseball,{
		VOWEL_RATIO:ratio,
		VARIATION_COST:20*ratio,
		DUPLICATE:false,
	});
}

// 位置別重みは、変種のsrcIndexを介して粗検索にも反映される。0を含む極端な
// 重みと、ン・ッ・ーを含み変種の長さが変わる入力の双方を実リストで比較する。
for(const [label,phrase,makeWeights] of [
	["位置別重み(実ノート相当)","もしもし かめよ",n=>Array.from({length:n},(_,i)=>1+(i%4)*0.25)],
	["位置別重み(0を含む)","もしもし かめよ",n=>Array.from({length:n},(_,i)=>i%3===0?0:1)],
	["位置別重み(ン・ッ・ー変種)","ゴメンネ サンタサン ホッケー",n=>Array.from({length:n},(_,i)=>i%2?0.5:1.5)],
]){
	const units=textAnalyzer.getYomiAndPhraseBreak(textAnalyzer.tokenizeTogether([phrase])[0]);
	for(const ratio of [0.2,0.5,0.8]){
		await compareGenerate(`${label} VOWEL_RATIO=${ratio}`,[phrase],baseball,{
			VOWEL_RATIO:ratio,
			VARIATION_COST:20*ratio,
			DUPLICATE:true,
		},[makeWeights(units.length)]);
	}
}

// 同じIDに多数の読みがあっても、重複禁止のstreaming exactではID単位で集約され、
// 後半行まで別IDの候補を選べる。
const repeatedReadings=[
	["多読語",...Array(12).fill("カカ")].join(","),
	...Array.from({length:24},(_,i)=>`別語${i},カカ`),
].join("\n");
const repeatedDb=await wordList.parsePlain(repeatedReadings);
const repeatedPhrases=Array(4).fill("カカ");
const repeatedExact=await h.generate(repeatedPhrases,repeatedDb,exactParam({
	VOWEL_RATIO:0.8,VARIATION_COST:0,DUPLICATE:false,
}));
const repeatedApprox=await h.generate(repeatedPhrases,repeatedDb,{
	...BASE,VOWEL_RATIO:0.8,VARIATION_COST:0,DUPLICATE:false,APPROX_CANDIDATES:2,
});
assert.deepEqual(compact(repeatedApprox),compact(repeatedExact),
	"同一IDの複数読みを集約するstreaming exactが設定Kに依存しない");
assert.equal(new Set(repeatedApprox.flat().map(w=>w.id)).size,4,"4行で異なる単語IDを選べる");
print("[ok] 同一IDの複数読みを集約し、重複なしではstreaming exactを使用");

// 編集APIも近似を使い、要求件数よりKを小さくしない。length=0の既存契約も維持。
const target=textAnalyzer.yomiToSyllable("カカ");
const candidateDb=await wordList.parsePlain([
	"前一致,カキ","後一致,キカ","完全一致,カカ","別1,ササ","別2,タタ","別3,ナナ",
].join("\n"));
const candidateExact=soramimiMaker.getCandidates(candidateDb,target,exactParam(),3,[2,0]);
const candidateApprox=soramimiMaker.getCandidates(candidateDb,target,{
	...BASE,APPROX_CANDIDATES:1,VOWEL_RATIO:0.8,
},3,[2,0]);
assert.deepEqual(candidateApprox,candidateExact,"getCandidatesの位置重み付き上位3件");
assert.deepEqual(soramimiMaker.getCandidates(candidateDb,target,approxParam(),0),[],
	"getCandidates(length=0)は空配列");
print("[ok] 編集APIの要求件数下限・位置別重み・length=0");

// 問題になった「ピョン」反復。kana2phononを使わず文字から母音を推測すると、
// 拗音ピョやンを誤分類して「子どもの森」を粗候補から落としていた。実学校リストの
// 先頭1.2万行で、正確・近似とも「子どもの森」が先頭になることを固定する。
const schoolLines=fs.readFileSync("wordlists/school.csv","utf8").split(/\r?\n/);
const schoolSample=[schoolLines[0],...schoolLines.slice(1,12001)].join("\n");
const schoolDb=await wordList.parseTidy(schoolSample,"",10);
const pyon=textAnalyzer.yomiToSyllable("ピョン".repeat(6));
const pyonParam={...BASE,VOWEL_RATIO:0.8,VARIATION_COST:0};
const pyonExact=soramimiMaker.getCandidates(schoolDb,pyon,exactParam(pyonParam),30);
const pyonApprox=soramimiMaker.getCandidates(schoolDb,pyon,approxParam(pyonParam),30);
assert.deepEqual(pyonApprox,pyonExact,"ピョン反復の近似上位30件");
assert.deepEqual(soramimiMaker.getCandidates(schoolDb,pyon,approxParam(pyonParam),30),pyonApprox,
	"同点を含む近似候補順が決定的");
assert.equal(pyonApprox[0].surface,"子どもの森","母音o主体の子どもの森が先頭候補");
print("[ok] ピョン×6でも拗音・ンを正しく署名化し「子どもの森」を保持");

print("近似候補検索: 全テスト通過");
