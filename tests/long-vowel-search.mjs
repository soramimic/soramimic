// Long vowels match either one long unit or two morae without Cartesian storage.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KanaToSyllable, maximumVariationLength } from '../frontend/src/lib/kanaToSyllable.js';
import { PronunciationSearch } from '../frontend/src/lib/pronunciationSearch.js';
import { buildApp } from './golden/harness-lib.mjs';
import { findPlacements } from '../frontend/src/reverseSearch.js';

const print = console.log.bind(console);
const k2s = KanaToSyllable();
const { app } = await buildApp();
const param = { VOWEL_RATIO:.8, VARIATION_COST:16, APPROX_CANDIDATES:0 };
const target = text => app.textAnalyzer.yomiToSyllable(text);
const candidates = (db,text,weights=null,extra={}) => app.soramimiMaker
  .getCandidates(db,target(text),{...param,...extra},100,weights);

for (const [long,spelled] of [
  ['カー','カア'],['キー','キイ'],['クー','クウ'],['ケー','ケエ'],['コー','コオ'],
  ['キャー','キャア'],['シェー','シェエ'],['フォー','フォオ'],['ヲー','ヲオ'],
  ['カーッ','カアッ'],['カーン','カアン'],
]) {
  const units = k2s.getVariation(target(long));
  assert(units.some(v => [...v].join('') === spelled), long);
  const db = await app.wordList.parsePlain(`長音語,${long}\n母音語,${spelled}`);
  for (const query of [long,spelled]) {
    assert(candidates(db,query).every(c => c.sim === 0), query);
  }
}
const db = await app.wordList.parsePlain('ナゲール\nアカエフ');
const found = candidates(db,'ナガレル');
assert(found.some(c => c.surface === 'ナゲール' && Number.isFinite(c.sim)));
const expandedDb = await app.wordList.parsePlain('ナゲエル\nアカエフ');
assert.deepEqual(found.map(c => [c.surface,c.sim]),
  candidates(expandedDb,'ナガレル').map(c => [c.surface === 'ナゲエル' ? 'ナゲール' : c.surface,c.sim]));
assert.equal(maximumVariationLength(target('ナゲール')),4);
const bounded = await app.wordList.parsePlain('ナゲール',3);
assert.deepEqual(Object.keys(bounded),['3']);
assert.equal(candidates(bounded,'ナゲール')[0].sim,0);
const fullyBounded = await app.wordList.parsePlain('ナゲール',4);
assert.equal(fullyBounded[3][0],fullyBounded[4][0], 'length buckets share the entry');
assert.equal(fullyBounded[4][0].kana,'ナゲール');
print('[ok] all vowels, small kana, suffixes, length bounds and ナガレル → ナゲール');

// Independent eager oracle: small inputs allow exhaustively spelling out each
// candidate long vowel, retaining the lyric source position on both output units.
const units = ['カ','カー','ア','キ','キー','イ','ン','ッ'];
const dist = Object.fromEntries(units.map((left,i)=>[left,
  Object.fromEntries(units.map((right,j)=>[right,left===right ? 0 : (i*7+j+1)/13]))]));
function wordVariants(word) {
  let variants = [[]];
  for (const unit of word) {
    const choices = unit === 'カー' ? [[unit],['カ','ア']]
      : unit === 'キー' ? [[unit],['キ','イ']] : [[unit]];
    variants = variants.flatMap(prefix=>choices.map(choice=>[...prefix,...choice]));
  }
  return variants;
}
const features = unit => ({カ:0x101,カー:0x101,ア:0x102,キ:0x201,キー:0x201,イ:0x202,ン:0x303,ッ:0x404})[unit];
for (const syllables of [
  ['カー','キ'],['カ','キー'],['カー','キー'],['カン','カーッ'],
  ['カーン',null,'キッ'],['ンッ','カー','ン'],
]) {
  const variations = k2s.getVariation(syllables);
  for (const word of [['カー','キー'],['カ','キー'],['カー','ン'],['カー','ッ','キー']]) {
    for (const size of [...new Set(wordVariants(word).map(v=>v.length))]) {
      const search = new PronunciationSearch(syllables,[size]);
      for (const weights of [null,syllables.map((_,i)=>i%2 ? 0 : 1.7)]) {
        for (const cost of [0,.1,16.25]) {
          let exact = Infinity, coarse = Infinity;
          for (const left of variations) for (const right of wordVariants(word)) {
            if (left.length!==size || right.length!==size) continue;
            let e = 0, c = (left.vcost+2)*cost;
            for (let i=0;i<size;i++) {
              const weight = weights ? weights[left.srcIndex[i]] : 1;
              e += dist[left[i]][right[i]]*weight;
              const a = features(left[i]), b = features(right[i]);
              if ((a>>>8)!==(b>>>8)) c += 5*.8*weight;
              if ((a&255)!==(b&255)) c += 5*(1-.8)*weight;
            }
            exact = Math.min(exact,e+(left.vcost+2)*cost);
            coarse = Math.min(coarse,c);
          }
          assert.equal(search.scoreExpanded(word,size,dist,cost,2,weights),exact);
          assert.equal(search.coarseScoreExpanded(word,size,features,.8,cost,2,weights),coarse);
        }
      }
    }
  }
}
print('[ok] graph matching agrees with exhaustive exact/coarse scores and source weights');

// More IDs than the approximation threshold force the coarse shortlist path.
const many = await app.wordList.parsePlain([
  'ナゲール',...Array.from({length:24},(_,i)=>`別語${i},${i%2 ? 'キキキキ' : 'クククク'}`),
].join('\n'));
for (const weights of [null,[1,2,0,1]]) {
  const exact = candidates(many,'ナガレル',weights).find(c=>c.surface==='ナゲール');
  const approximate = app.soramimiMaker.getCandidates(many,target('ナガレル'),
    {...param,APPROX_CANDIDATES:2},2,weights);
  assert.equal(approximate[0].surface,'ナゲール');
  assert.equal(approximate[0].sim,exact.sim);
}
const tokens = [[{surface_form:'ナガレル',pronunciation:'ナガレル',reading:'ナガレル',
  pos:'名詞',pos_detail_1:'一般',pos_detail_2:'*',pos_detail_3:'*',phrase:0}]];
for (const duplicate of [false,true]) {
  const [[word]] = await new Promise(resolve=>app.soramimiMaker.generateFromTokens(tokens,
    fullyBounded,{...param,DUPLICATE:duplicate},null,resolve));
  assert.equal(word.surface,'ナゲール');
  assert.deepEqual(word.period,[0,4]);
}
const matches = await findPlacements(app,'ナゲール',[
  ['ナ','ゲ','エ','ル'].map(pronunciation=>({pronunciation})),
],param,null);
assert(matches.some(match=>match.start===0 && match.end===4 && Number.isFinite(match.score)));
print('[ok] approximate shortlist, generation and reverse search include expanded long vowels');

// Both sides have 2**36 theoretical alternatives. Dictionary construction and
// public comparison must complete without storing those alternatives.
const stress = `
import assert from 'node:assert/strict';
import { KanaToSyllable } from ${JSON.stringify(new URL('../frontend/src/lib/kanaToSyllable.js',import.meta.url).href)};
import { WordList } from ${JSON.stringify(new URL('../frontend/src/lib/wordList.js',import.meta.url).href)};
import { SoramimiMaker } from ${JSON.stringify(new URL('../frontend/src/lib/soramimic.js',import.meta.url).href)};
const print = console.log.bind(console); console.log = ()=>{};
const k = KanaToSyllable();
const analyzer = {formatKana:v=>v,getYomi:v=>v,syllableToVariation:k.getVariation,
  yomiToVariation:(v,max,expand)=>k.getVariation(k.split(v),max,expand),
  getYomiAndPhraseBreak:tokens=>tokens};
const db = await WordList(analyzer).parsePlain('カー'.repeat(36));
assert.equal(Object.keys(db).length,37);
assert(Object.values(db).every(entries=>entries.length===1 && entries[0]===db[36][0]));
const units = ['カ','カー','ア','ン'];
const dist = Object.fromEntries(units.map(a=>[a,Object.fromEntries(units.map(b=>[b,Number(a!==b)]))]));
const maker = SoramimiMaker({getKanaSimilarity:()=>dist},analyzer,{カ:['k','a'],ア:['sp','a']});
const full = maker.getCandidates(db,Array(36).fill('カー'),{APPROX_CANDIDATES:0},1);
assert.equal(full[0].sim,0);
const intermediate = Array(18).fill(['カ','ア']).flat().concat(Array(18).fill('カ'));
assert.equal(maker.getCandidates(db,intermediate,{APPROX_CANDIDATES:0},1)[0].sim,18);
assert.equal(maker.getCandidates(db,Array(36).fill('カン'),
  {APPROX_CANDIDATES:0,VARIATION_COST:.125},1)[0].sim,4.5);
print(JSON.stringify({heapUsed:process.memoryUsage().heapUsed}));
`;
const { stdout } = await promisify(execFile)(process.execPath,[
  '--max-old-space-size=128','--input-type=module','--eval',stress,
],{timeout:30000,maxBuffer:1024*1024});
const heap = JSON.parse(stdout).heapUsed;
assert(heap<64*1024*1024);
print(`[ok] 2**36 alternatives on both sides under a 128 MiB heap (${(heap/1024/1024).toFixed(1)} MiB used)`);
