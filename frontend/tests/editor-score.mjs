import assert from 'node:assert/strict';
import { retainScoreLines } from '../src/editorScore.js';
const previous = {phrases:['ア','イ'], scoreContext:{moras:[{line:10},{line:20}]},
 param:{}, wordlist:{value:'X'}, unitsList:[[{pronunciation:'ア'}],[{pronunciation:'イ'}]],
 results:[[{surface:'採用済み',period:[0,1],locked:true}],[{surface:'古い行',period:[0,1]}]],
 tokensList:[[{reading:'ア'}],[{reading:'イ'}]]};
const data = {param:{}, wordlist:{value:'X'}, phrases:['ア','ウ'],
 scoreContext:{moras:[{line:10},{line:20}]}, scorePrevious:previous};
const units = [[{pronunciation:'ア'}],[{pronunciation:'ウ'}]];
const results = [[{surface:'新しい候補'}],[{surface:'修正行の候補'}]], tokens=[[],[]];
retainScoreLines(data,tokens,units,results);
assert.deepEqual(results[0],previous.results[0]);
assert.equal(results[1][0].surface,'修正行の候補');
assert.notEqual(results[0],previous.results[0]);
assert.deepEqual(tokens[0],previous.tokensList[0]);
const changedSettings = [[{surface:'新しい設定の候補'}],[]];
retainScoreLines({...data,wordlist:{value:'Y'}},[[],[]],units,changedSettings);
assert.equal(changedSettings[0][0].surface,'新しい設定の候補');
const newLine = [[{surface:'新しい行'}],[]];
retainScoreLines({...data,scoreContext:{moras:[{line:99},{line:20}]}},[[],[]],units,newLine);
assert.equal(newLine[0][0].surface,'新しい行');
console.log('[ok] score corrections preserve adopted unchanged lines; changed lines, settings and identities are regenerated');

const {readFile}=await import('node:fs/promises');
const {runInNewContext}=await import('node:vm');
const window={};
runInNewContext(await readFile(new URL('../src/appBridge.js',import.meta.url),'utf8'),
 {window,location:{origin:'https://dev.soramimic.pages.dev'},URL,Blob});
const score={format:'soramimic-score-context/1',moras:[{line:0,text:'ア',start:0,end:1,pitch:60}],song:{tempo_map:[]}};
assert.equal(window.SoramimicBridge.scoreContext(score).song.tempo_map.length,0);
console.log('[ok] scores with implicit default tempo remain portable');
