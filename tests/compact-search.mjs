// Exact and approximate search must preserve eager scoring without a target product.
// Run: node tests/compact-search.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KanaToSyllable } from "../frontend/src/lib/kanaToSyllable.js";
import { PronunciationSearch } from "../frontend/src/lib/pronunciationSearch.js";
import { SoramimiMaker } from "../frontend/src/lib/soramimic.js";

const print = console.log.bind(console);
const k2s = KanaToSyllable();
const syllables = ["ア","カ","ン","ッ","ンー","ンッ","カーン","カンッ",
	"カーッ","カー","カッ","カン","カア",null,""];
const units = ["ア","カ","カー","キ","キー","ン","ッ"];
const kanaDist = Object.fromEntries(units.map((left,i)=>[left,
	Object.fromEntries(units.map((right,j)=>[right,left===right ? 0 : (i*7+j+1)/13]))]));
const kana2phonon = {"ア":["","a"],"カ":["k","a"],"キ":["k","i"],
	"ン":["sp","N"],"ッ":["sp","q"]};

// Deliberately independent of the compact scorer's helpers. Match the old
// String.fromCharCode signatures, including 16-bit conversion and missing units.
function featuresFor(phonemes){
	const vowels = new Map(), consonants = new Map();
	const code = (map,value)=>{
		if(!map.has(value))map.set(value,map.size);
		return map.get(value);
	};
	return unit=>{
		const phoneme = phonemes[unit] || phonemes[unit.replace(/ー+$/g,"")];
		return (code(vowels,phoneme ? phoneme[1].slice(-1) : unit)<<8)
			| code(consonants,phoneme ? phoneme[0].split("+")[0] : unit);
	};
}
const unitFeature = featuresFor(kana2phonon);
const weightAt = (variation,index,weights)=>{
	const value = weights && weights[variation.srcIndex[index]];
	return typeof value === "number" ? value : 1;
};
function eagerExact(variations,pronunciation,cost=0,wordCost=0,weights=null,dist=kanaDist){
	let best = Infinity;
	for(const variation of variations){
		if(variation.length!==pronunciation.length)continue;
		let score = 0;
		for(let i=0;i<variation.length;i++){
			if(!(variation[i] in dist) || !(pronunciation[i] in dist)){
				score = Infinity;
				break;
			}
			const value = dist[variation[i]][pronunciation[i]];
			score += weights ? value*weightAt(variation,i,weights) : value;
		}
		best = Math.min(best,score+((variation.vcost||0)+wordCost)*cost);
	}
	return best;
}
function eagerCoarse(variations,pronunciation,ratio=.8,cost=1,wordCost=0,weights=null,
	feature=unitFeature){
	const wordSignature = String.fromCharCode(...pronunciation.map(feature));
	let best = Infinity;
	for(const variation of variations){
		const signature = String.fromCharCode(...variation.map(feature));
		let score = ((variation.vcost||0)+wordCost)*cost;
		for(let i=0;i<variation.length;i++){
			const left = signature.charCodeAt(i), right = wordSignature.charCodeAt(i);
			const weight = weightAt(variation,i,weights);
			if((left>>>8)!==(right>>>8))score += 5*ratio*weight;
			if((left&255)!==(right&255))score += 5*(1-ratio)*weight;
		}
		if(score<best)best = score;
	}
	return best;
}
function checkScores(target,pronunciations,weights,cost,ratio=.8,wordCost=2,dist=kanaDist){
	const variations = k2s.getVariation(target);
	const search = new PronunciationSearch(target,Array.from({length:18},(_,i)=>i+1));
	assert.deepEqual(search.lengths,[...new Set(variations.map(v=>v.length))].sort((a,b)=>a-b));
	for(const pronunciation of pronunciations){
		const context = JSON.stringify({target,pronunciation,weights,cost,ratio,wordCost});
		assert.equal(search.score(pronunciation,dist,cost,wordCost,weights),
			eagerExact(variations,pronunciation,cost,wordCost,weights,dist),context);
		const matching = variations.filter(v=>v.length===pronunciation.length);
		assert.equal(search.coarseScore(pronunciation,unitFeature,ratio,cost,wordCost,weights),
			eagerCoarse(matching,pronunciation,ratio,cost,wordCost,weights),context);
	}
}

// Every ordered pair of grammar branches, including bare deletion and null sources.
for(const left of syllables)for(const right of syllables){
	const target = [left,right];
	const pronunciations = [...new Map(k2s.getVariation(target)
		.map(v=>[JSON.stringify([...v]),[...v]])).values(),[],["キ"],["☃","カ"]];
	for(const weights of [null,[0,1.7],[],[2.3]]){
		for(const cost of [0,.1,16.25])checkScores(target,pronunciations,weights,cost);
	}
}
for(const target of [[],[null],[null,null],["☃","カ"],[null,"カン",null,"キッ"]]){
	checkScores(target,[["カ","カ"],["カ","ン","キ","ッ"],["☃","カ"]],
		[0,1.7,99,.3].slice(0,target.length),.3);
}
print("[ok] all syllable branches, deletions, null sources, partial and zero weights");

// Seeded fractional scores also detect regrouped additions and misplaced penalties.
let randomState = 0x7419c;
const random = n=>{
	randomState = (Math.imul(randomState,1664525)+1013904223)>>>0;
	return randomState%n;
};
const pick = values=>values[random(values.length)];
const floatDist = Object.fromEntries(units.map(left=>[left,Object.fromEntries(units.map(right=>
	[right,pick([0,.1,1/3,1e-12,1e12,2**53])]))]));
for(let sample=0;sample<160;sample++){
	const target = Array.from({length:1+random(6)},()=>pick(syllables));
	const variations = k2s.getVariation(target);
	const pronunciation = variations.length ? [...pick(variations)] : [];
	if(pronunciation.length)pronunciation[random(pronunciation.length)] = pick([...units,"☃"]);
	const weights = sample%3 ? target.map(()=>pick([0,.3,1,1.9])) : null;
	checkScores(target,[pronunciation],weights,pick([0,.1,.7,16.25,-.125]),
		pick([.2,.3,.5,.8]),random(5),floatDist);
}
{
	const target = ["カンッ","キンッ"];
	const search = new PronunciationSearch(target,[2,6]);
	const variations = k2s.getVariation(target);
	const feature = unit=>({"カー":0x101,"キー":0x201,"ッ":0x303})[unit];
	const pronunciation = ["ッ","ッ"];
	const expected = eagerCoarse(variations.filter(v=>v.length===2),pronunciation,.3,2e15,1,null,feature);
	assert.equal(expected,1e16+12,"penalty precedes separately rounded vowel/consonant additions");
	assert.equal(search.coarseScore(pronunciation,feature,.3,2e15,1),expected);
	const dist = Object.fromEntries(units.map(left=>[left,Object.fromEntries(units.map(right=>[right,1]))]));
	dist["カ"]["カ"] = 1e16;
	const exactPronunciation = ["カ","ン","ッ","キ","ン","ッ"];
	assert.equal(search.score(exactPronunciation,dist,.75,1),
		eagerExact(variations,exactPronunciation,.75,1,null,dist));
}
print("[ok] exact and coarse float scores preserve their distinct addition orders");

// Small-query allocation includes intermediate lengths absent from the dictionary.
assert.equal(new PronunciationSearch(["カン"],[1,2]).compact,false);
assert.equal(new PronunciationSearch(Array(6).fill("カン"),[6]).compact,false);
assert.equal(new PronunciationSearch(Array(6).fill("カン"),[12]).compact,true);
for(const target of [[],[null],[""],["ン","ッ"],["カン"]]){
	const wanted = [7,2,0,1,2,-1];
	assert.deepEqual(new PronunciationSearch(target,wanted.values()).lengths,
		[...new Set(k2s.getVariation(target).map(v=>v.length))]
			.filter(n=>wanted.includes(n)).sort((a,b)=>a-b));
}
{
	const target = Array(6).fill("カン");
	const variants = k2s.getVariation(target).filter(v=>v.length===12);
	const search = new PronunciationSearch(target,[12]);
	for(const pronunciation of [["カ"],Array(14).fill("カ"),[]]){
		assert.equal(search.coarseScore(pronunciation,unitFeature,.3,.7,2,null,12),
			eagerCoarse(variants,pronunciation,.3,.7,2),"malformed coarse bucket");
	}
}
{
	const target = Array(6).fill("カン"), pronunciation = Array(6).fill("キ");
	const search = new PronunciationSearch(target,[6,12]);
	const feature = unit=>({"カ":0x10001,"カー":0x10001,"キ":1,"ン":4})[unit];
	const matching = k2s.getVariation(target).filter(v=>v.length===6);
	assert.equal(search.coarseScore(pronunciation,feature,.8,0),
		eagerCoarse(matching,pronunciation,.8,0,0,null,feature),
		"coarse features retain legacy String.fromCharCode 16-bit conversion");
}
print("[ok] sparse length bounds and malformed coarse buckets preserve eager behavior");

const word = (id,pronunciation,label,cost=0)=>({id,surface:label,original:label,
	kana:pronunciation.join(""),pronunciation,vcost:cost});
const normalWeights = weights=>{
	if(!weights)return null;
	const scale = weights.length/weights.reduce((a,b)=>a+b,0);
	return weights.map(w=>w*scale);
};
function eagerCandidates(db,target,param,length,rawWeights=null){
	const variations = k2s.getVariation(target), grouped = {};
	for(const v of variations)if(v.length in db)(grouped[v.length] ||= []).push(v);
	const weights = normalWeights(rawWeights), cost = param.VARIATION_COST||0;
	const limit = param.APPROX_CANDIDATES>0 ? Math.max(param.APPROX_CANDIDATES,length) : 0;
	const entries = Object.keys(grouped).flatMap(key=>db[key]);
	let selected = null;
	if(limit && entries.length>limit*2 && new Set(entries.map(w=>w.id)).size>limit*2){
		const best = new Map();
		for(const key in grouped)for(const w of db[key]){
			const score = eagerCoarse(grouped[key],w.pronunciation,param.VOWEL_RATIO??.8,
				cost/16,w.vcost||0,weights);
			if(!best.has(w.id) || score<best.get(w.id))best.set(w.id,score);
		}
		selected = new Set([...best].sort((a,b)=>a[1]-b[1]).slice(0,limit).map(([id])=>id));
	}
	const result = {};
	for(const key in grouped)for(const w of db[key]){
		if(selected && !selected.has(w.id))continue;
		const sim = eagerExact(grouped[key],w.pronunciation,cost,w.vcost||0,weights);
		if(w.id in result && sim>result[w.id].sim)continue;
		result[w.id] = {...w,sim};
	}
	return Object.values(result).sort((a,b)=>a.sim-b.sim).slice(0,length);
}
const analyzer = {syllableToVariation:k2s.getVariation,getYomiAndPhraseBreak:tokens=>tokens};
const maker = SoramimiMaker({getKanaSimilarity:()=>kanaDist},analyzer,kana2phonon);
const target = Array(6).fill("カン");
const ids = ["10","z","2","01","a","4294967295","4294967294"];
const db = {6:[],12:[word("2",Array(6).fill(["カ","ン"]).flat(),"last same ID")]};
for(let i=0;i<36;i++){
	const pronunciation = Array.from({length:6},(_,j)=>units[(i+j)%units.length]);
	db[6].push(word(ids[i%ids.length],pronunciation,`reading-${i}`,i%3));
}
for(let i=0;i<12;i++)db[6].push(word(`extra-${i}`,Array(6).fill(units[i%units.length]),`extra-${i}`));
db[6].push(word("bad-length",Array(12).fill("カ"),"malformed length"));
db[6].push(word("unknown",Array(6).fill("☃"),"unknown unit"));
assert.ok(new PronunciationSearch(target,Object.keys(db)).compact);
for(const cost of [0,.3,16.25])for(const ratio of [.2,.5,.8]){
	for(const rawWeights of [null,[0,.3,1,1.9,2,.1]]){
		for(const [approximate,length] of [[0,40],[1,2],[3,2],[4,4]]){
			const param = {VARIATION_COST:cost,VOWEL_RATIO:ratio,APPROX_CANDIDATES:approximate};
			assert.deepEqual(maker.getCandidates(db,target,param,length,rawWeights),
				eagerCandidates(db,target,param,length,rawWeights),JSON.stringify(param));
		}
	}
}
assert.deepEqual(maker.getCandidates(db,target,{APPROX_CANDIDATES:1},0),[]);
print("[ok] public exact and approximate candidates match eager ranking and unique-ID shortlist");

// Treat all source syllables as one character to query the full span through the
// public generation API. Repeated lines exercise excluded IDs without tokenization.
const tokens = target.map((pronunciation,index)=>({pronunciation,char_index:0,phrase:0,
	surface_form:index===0 ? "sample" : ""}));
const tieDb = {6:ids.map(id=>word(id,Array(6).fill("カ"),`tie-${id}`)),12:[
	word("2",Array(6).fill(["カ","ン"]).flat(),"same ID first"),
	word("2",Array(6).fill(["カ","ン"]).flat(),"same ID last"),
]};
const repeatedDb = {...tieDb,6:[
	...Array.from({length:20},(_,i)=>word("10",Array(6).fill("カ"),`repeated-${i}`)),
	...tieDb[6],
]};
const shortlist = maker.getCandidates(repeatedDb,target,
	{VARIATION_COST:0,APPROX_CANDIDATES:2},2);
assert.deepEqual(shortlist.map(w=>w.id),["10","z"],
	"duplicate readings consume one shortlist slot; coarse ties retain insertion order");
assert.deepEqual(shortlist,eagerCandidates(repeatedDb,target,
	{VARIATION_COST:0,APPROX_CANDIDATES:2},2));
const summary = values=>values.map(w=>({id:w.id,surface:w.surface,sim:w.sim}));
const expected = eagerCandidates(tieDb,target,{VARIATION_COST:0,APPROX_CANDIDATES:0},20);
const savedLog = console.log;
console.log = ()=>{};
let generated;
try{
	generated = await new Promise(resolve=>maker.generateFromTokens(
		Array(5).fill(tokens),tieDb,{DUPLICATE:false,APPROX_CANDIDATES:1,VARIATION_COST:0,
			SAME_PHRASE_BREAK_REWARD:0,WORD_NUMBER_PENALTY:20},null,resolve));
}finally{
	console.log = savedLog;
}
assert.deepEqual(generated.map(line=>summary(line)[0]),summary(expected.slice(0,5)));
assert.equal(generated[0][0].surface,"same ID last");
assert.deepEqual(generated.map(line=>line[0].id),["2","10","4294967294","z","01"]);
print("[ok] streaming generation excludes previous IDs and preserves same-ID ties");

// If target enumeration returns, the heap limit makes only this child fail.
// Both shortest and intermediate output lengths are reachable; this is not an
// empty-bucket fast path. The exact shortest match is the last Cartesian path.
const stressScript = `
import assert from "node:assert/strict";
import { KanaToSyllable } from ${JSON.stringify(new URL("../frontend/src/lib/kanaToSyllable.js",import.meta.url).href)};
import { SoramimiMaker } from ${JSON.stringify(new URL("../frontend/src/lib/soramimic.js",import.meta.url).href)};
const print = console.log.bind(console);
console.log = ()=>{};
const target = Array(36).fill("カン");
const units = ["カ","カー","ン"];
const dist = Object.fromEntries(units.map(a=>[a,Object.fromEntries(units.map(b=>[b,Number(a!==b)]))]));
const k2s = KanaToSyllable();
const analyzer = {syllableToVariation:k2s.getVariation,getYomiAndPhraseBreak:tokens=>tokens};
const maker = SoramimiMaker({getKanaSimilarity:()=>dist},analyzer,{"カ":["k","a"],"ン":["sp","N"]});
const db = {
  36:Array.from({length:8},(_,i)=>({id:String(10+i),pronunciation:Array(36).fill("カ"),vcost:i})),
  54:[{id:"2",pronunciation:[...Array(18).fill(["カ","ン"]).flat(),...Array(18).fill("カ")],vcost:0}],
};
const param = {VARIATION_COST:.125,VOWEL_RATIO:.8,APPROX_CANDIDATES:0};
const full = maker.getCandidates(db,target,param,20);
assert.deepEqual(full.slice(0,2).map(w=>[w.id,w.sim]),[["2",2.25],["10",4.5]]);
assert.deepEqual(maker.getCandidates(db,target,{...param,APPROX_CANDIDATES:1},1),full.slice(0,1));
const tokens = target.map((pronunciation,i)=>({pronunciation,char_index:0,phrase:0,surface_form:i?"":"sample"}));
const generated = await new Promise(resolve=>maker.generateFromTokens([tokens,tokens],db,
  {...param,DUPLICATE:false,SAME_PHRASE_BREAK_REWARD:0},null,resolve));
assert.deepEqual(generated.map(line=>[line[0].id,line[0].sim]),[["2",2.25],["10",4.5]]);
print(JSON.stringify({heapUsed:process.memoryUsage().heapUsed}));
`;
const {stdout} = await promisify(execFile)(process.execPath,[
	"--max-old-space-size=128","--input-type=module","--eval",stressScript,
],{timeout:30000,maxBuffer:1024*1024});
assert.ok(JSON.parse(stdout).heapUsed<64*1024*1024,"compact query stays within a modest heap");
print("[ok] reachable 3**36-path queries finish under a 128 MiB child heap bound");
print("compact pronunciation search: all tests passed");
