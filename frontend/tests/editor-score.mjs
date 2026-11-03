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
