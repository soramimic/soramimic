// 重複なし生成のstreaming exact検索の回帰テスト。
// 実行: node tests/streaming-exact.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import { buildApp } from "./golden/harness-lib.mjs";

const print=console.log.bind(console);
const h=await buildApp();
const {soramimiMaker,textAnalyzer,wordList}=h.app;
const PARAM={VOWEL_RATIO:0.8,VARIATION_COST:16,SAME_PHRASE_BREAK_REWARD:0,
	MID_PHRASE_BREAK_PENALTY:20,WORD_NUMBER_PENALTY:20,DUPLICATE:false};
const generate=(phrases,db,param=PARAM,weights=null)=>h.generate(phrases,db,param,weights);
const fromTokens=(tokens,db,param,locks=null,weights=null)=>new Promise(resolve=>{
	soramimiMaker.generateFromTokens(tokens,db,param,null,resolve,locks,weights);
});
const units=(kana)=>textAnalyzer.yomiToSyllable(kana);
const entry=(id,surface,kana)=>({id:String(id),surface,original:surface,kana,
	pronunciation:units(kana),vcost:0});

// 通常Objectのキー列挙と同じ同点順: 数値IDは昇順で非数値IDより先。
const tieDb={1:[entry("10","数値10","カ"),entry("z","非数値先","カ"),
	entry("2","数値2先","カ"),entry("01","先頭ゼロ","カ"),
	entry("2","数値2後","カ"),entry("a","非数値後","カ")]};
const tied=await generate(Array(5).fill("カ"),tieDb);
assert.deepEqual(tied.map(line=>line[0].id),["2","10","z","01","a"]);
assert.equal(tied[0][0].surface,"数値2後","同一ID・同scoreのentryは後勝ち");
print("[ok] 数値・非数値IDのexact同点順を維持");

// 同一IDの複数読みは最小scoreへ集約し、使用後は全読みをまとめて除外する。
const readingDb={1:[entry("7","同IDの悪い読み","キ"),entry("7","同ID完全一致先","カ"),
	entry("7","同ID完全一致後","カ"),entry("8","別ID完全一致","カ")]};
const reading=await generate(["カ","カ"],readingDb);
assert.equal(reading[0][0].surface,"同ID完全一致後");
assert.equal(reading[1][0].id,"8");
print("[ok] 同一IDの複数読みを最小scoreへ集約し、使用後は全読みを除外");

// 行をまたぐ使用済みIDを検索前に除き、次のexact候補へ進む。
const reuseDb={1:[entry("2","第一候補","カ"),entry("10","第二候補","カ")]};
const noReuse=await generate(["カ","カ"],reuseDb);
assert.deepEqual(noReuse.map(line=>line[0].id),["2","10"]);
print("[ok] 全曲の使用済みIDを検索前に除外");

// 未来のlockも最初から使用済み。前gapではlock IDを避け、固定語を保持する。
const tokens=textAnalyzer.tokenizeTogether(["カカカ"]);
const locked={...entry("2","固定語","カ"),sim:0,score:0,period:[1,2],originalkana:"カ"};
const lockDb={1:[entry("2","固定候補","カ"),entry("10","前gap候補","カ"),
	entry("11","後gap候補","カ")]};
const withLock=await fromTokens(tokens,lockDb,PARAM,[[locked]]);
assert.equal(withLock[0][0].id,"10","前gapで未来のlock IDを除外");
assert.equal(withLock[0][1].id,"2","lockをそのまま保持");
assert.equal(withLock[0][2].id,"11","後gapで前gapの採用IDを除外");
print("[ok] locksの未来IDとgap採用語を重複させない");

// streaming経路でも位置別重みとVOWEL_RATIOをexact距離へ反映する。
const weightedDb={2:[entry("0","前一致","カキ"),entry("1","後一致","キカ")]};
const weightedTokens=textAnalyzer.tokenizeTogether(["カカ"]);
for(const [positionWeights,expected] of [[[1.5,0.5],"前一致"],[[0.5,1.5],"後一致"]]){
	const result=await fromTokens(weightedTokens,weightedDb,PARAM,null,[positionWeights]);
	assert.equal(result[0][0].surface,expected,`位置重み ${positionWeights}`);
}
const ratioDb={1:[entry("0","母音一致","サ"),entry("1","子音一致","キ")]};
for(const [ratio,expected] of [[0.2,"1"],[0.5,"0"],[0.8,"0"]]){
	const result=await generate(["カ"],ratioDb,
		{...PARAM,VOWEL_RATIO:ratio,VARIATION_COST:20*ratio});
	assert.equal(result[0][0].id,expected,`VOWEL_RATIO=${ratio}`);
}
print("[ok] 位置別重みとVOWEL_RATIOをstreaming exactへ反映");

// ン・ッ・ーを1操作で除いた変種は、指定した変種コストでexact採点する。
const shortDb={2:[entry("0","短縮候補","カカ")]};
for(const variant of ["カンカ","カッカ","カーカ"]){
	const result=await generate([variant],shortDb,PARAM);
	assert.equal(result[0][0].surface,"短縮候補",variant);
	assert.equal(result[0][0].sim,16,`${variant} の変種コスト`);
}
print("[ok] ン・ッ・ー変種のexact scoreを維持");

// APPROX_CANDIDATESは重複なし生成に影響しない。位置重みとン・ッ・ー変種もexactで一致。
const variationDb=await wordList.parsePlain([
	"候補A,ゴメンネ","候補B,サンタサン","候補C,ホッケー",
	"候補D,ゴネネ","候補E,サタサ","候補F,ホケ",
].join("\n"));
const phrase="ゴメンネ サンタサン ホッケー";
const phraseTokens=textAnalyzer.tokenizeTogether([phrase]);
const count=textAnalyzer.getYomiAndPhraseBreak(phraseTokens[0]).length;
const weights=[Array.from({length:count},(_,i)=>i%3===0?0:1+i%2)];
const exact=await fromTokens(phraseTokens,variationDb,{...PARAM,APPROX_CANDIDATES:0},null,weights);
for(const k of [1,2,512]){
	const result=await fromTokens(phraseTokens,variationDb,{...PARAM,APPROX_CANDIDATES:k},null,weights);
	assert.deepEqual(result,exact,`APPROX_CANDIDATES=${k}`);
}
print("[ok] 重複なしはKに依存せず、位置重み・ンッー変種もexact一致");

// 重複可生成と編集APIは従来経路を維持する。
const duplicate=await generate(["カ","カ"],reuseDb,{...PARAM,DUPLICATE:true,APPROX_CANDIDATES:1});
assert.deepEqual(duplicate.map(line=>line[0].id),["2","2"]);
let bucketScans=0;
const cachedBucket=new Proxy([entry("2","共有候補","カ")],{
	get(target,key,receiver){
		if(key===Symbol.iterator)bucketScans++;
		return Reflect.get(target,key,receiver);
	},
});
await generate(["カ","カ"],{1:cachedBucket},{...PARAM,DUPLICATE:true,APPROX_CANDIDATES:0});
assert.equal(bucketScans,1,"重複可の同一targetはGS cacheを共有");
const candidates=soramimiMaker.getCandidates(reuseDb,units("カ"),
	{...PARAM,APPROX_CANDIDATES:1},2);
assert.deepEqual(candidates.map(word=>word.id),["2","10"]);
print("[ok] 重複可のGS共有cache・編集APIの上位Nを維持");

print("streaming exact検索: 全テスト通過");
