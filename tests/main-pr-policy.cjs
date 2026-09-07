'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classify } = require('../.github/scripts/main-pr-policy.cjs');

const blob = (path, mode = '100644', type = 'blob') => ({ path, mode, type, sha: 'blob-sha' });
function fixture(files = [{ filename: 'README.md', status: 'modified' }], options = {}) {
  const repository = { id: 1, full_name: 'owner/repo' };
  const pr = {
    state: 'open', merged: false, changed_files: files.length,
    head: { ref: 'docs', sha: 'head', repo: { ...repository } },
    base: { ref: 'main', sha: 'base', repo: { ...repository } },
  };
  const calls = [];
  let reads = 0;
  const base = files.filter((f) => f.status !== 'added').map((f) => blob(f.previous_filename || f.filename));
  const head = files.filter((f) => f.status !== 'removed').map((f) => blob(f.filename));
  const github = { rest: {
    pulls: {
      get: async () => {
        calls.push('get');
        const value = structuredClone(pr);
        if (reads++ > 0 && options.drift) options.drift(value);
        return { data: value };
      },
      listFiles: async ({ page, per_page }) => {
        calls.push(`files:${page}`);
        if (options.filesError) throw new Error('file API error');
        return { data: options.pages ? (options.pages[page - 1] || []) : files.slice((page - 1) * per_page, page * per_page) };
      },
    },
    git: {
      getCommit: async ({ commit_sha }) => {
        calls.push(`commit:${commit_sha}`);
        return { data: options.missingCommitTree ? {} : { tree: { sha: `${commit_sha}-tree` } } };
      },
      getTree: async ({ tree_sha, recursive }) => {
        calls.push(`tree:${tree_sha}`);
        assert.equal(recursive, 'true');
        if (options.treeError) throw new Error('tree API error');
        return { data: { truncated: options.truncated ?? false, tree: tree_sha === 'base-tree' ? base : head } };
      },
    },
  } };
  return { pr, base, head, calls, run: (pins = {}) => classify({ github, owner: 'owner', repo: 'repo', pull_number: 7, ...pins }) };
}

test('regular Markdown additions, deletions, modifications and renames are allowed', async () => {
  const f = fixture([
    { filename: 'nested/new.MD', status: 'added' },
    { filename: 'old.md', status: 'removed' },
    { filename: 'README.md', status: 'modified' },
    { filename: 'renamed.md', previous_filename: 'original.Md', status: 'renamed' },
  ]);
  const result = await f.run({ expectedHead: 'head', expectedBase: 'base' });
  assert.equal(result.allowed, true);
  assert.equal(result.markdownOnly, true);
  assert.equal(result.headSha, 'head');
  assert.equal(result.baseSha, 'base');
  assert.equal(f.calls.at(-1), 'get');
});

test('preview promotions allow code but require same repository and a stable PR', async () => {
  const f = fixture([{ filename: 'app.js', status: 'modified' }]);
  f.pr.head.ref = 'preview';
  assert.equal((await f.run()).allowed, true);
  assert.deepEqual(f.calls, ['get', 'get']);
  f.pr.head.repo = { id: 2, full_name: 'fork/repo' };
  assert.equal((await f.run()).allowed, false);
});

test('forks, closed PRs and non-main targets are rejected', async () => {
  for (const change of [
    (pr) => { pr.head.repo.id = 2; },
    (pr) => { pr.head.repo = null; },
    (pr) => { pr.state = 'closed'; },
    (pr) => { pr.merged = true; },
    (pr) => { pr.base.ref = 'dev'; },
    (pr) => { pr.base.repo.full_name = 'other/repo'; },
  ]) {
    const f = fixture(); change(f.pr);
    assert.equal((await f.run()).allowed, false);
  }
});

test('mixed files and renames crossing the Markdown boundary are rejected', async () => {
  for (const file of [
    { filename: 'app.js', status: 'modified' },
    { filename: 'new.md', previous_filename: 'old.js', status: 'renamed' },
    { filename: 'new.js', previous_filename: 'old.md', status: 'renamed' },
    { filename: 'new.md', status: 'renamed' },
    { filename: 'README.md', status: 'unknown' },
  ]) {
    assert.equal((await fixture([{ filename: 'other.md', status: 'modified' }, file]).run()).allowed, false);
  }
});

test('non-regular objects on either side are rejected', async () => {
  for (const side of ['base', 'head']) {
    for (const [mode, type] of [['120000', 'blob'], ['160000', 'commit'], ['100755', 'blob'], ['040000', 'tree']]) {
      const f = fixture(); f[side][0] = blob('README.md', mode, type);
      assert.equal((await f.run()).allowed, false, `${side}: ${mode}`);
    }
    const f = fixture(); f[side].length = 0;
    assert.equal((await f.run()).allowed, false);
  }
});

test('pagination verifies every file and completeness, including exact full pages', async () => {
  const files = Array.from({ length: 101 }, (_, i) => ({ filename: `${i}.md`, status: 'modified' }));
  const complete = fixture(files);
  assert.equal((await complete.run()).allowed, true);
  assert.ok(complete.calls.includes('files:2'));
  const full = fixture(files.slice(0, 100));
  assert.equal((await full.run()).allowed, true);
  assert.ok(full.calls.includes('files:2'));
  assert.equal((await fixture(files, { pages: [files.slice(0, 100)] }).run()).allowed, false);
  assert.equal((await fixture(files, { pages: [files.slice(0, 100), [files[0]]] }).run()).allowed, false);
  files[100] = { filename: 'last.js', status: 'modified' };
  assert.equal((await fixture(files).run()).allowed, false);
  const mismatch = fixture(files); mismatch.pr.changed_files = 100;
  assert.equal((await mismatch.run()).allowed, false);
});

test('the API maximum is accepted only with a complete listing', async () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `${i}.md`, status: 'added' }));
  const f = fixture(files);
  assert.equal((await f.run()).allowed, true);
  assert.ok(f.calls.includes('files:31'));
});

test('empty, invalid and over-limit changes fail closed', async () => {
  for (const count of [0, -1, undefined, 1.5, 3001]) {
    const f = fixture(); f.pr.changed_files = count;
    assert.equal((await f.run()).allowed, false);
  }
});

test('truncated trees, missing commit trees and API errors fail closed', async () => {
  for (const options of [{ truncated: true }, { missingCommitTree: true }, { treeError: true }, { filesError: true }]) {
    await assert.rejects(fixture(undefined, options).run());
  }
});

test('head/base pins and live PR drift fail closed', async () => {
  assert.equal((await fixture().run({ expectedHead: 'old' })).allowed, false);
  assert.equal((await fixture().run({ expectedBase: 'old' })).allowed, false);
  for (const drift of [
    (pr) => { pr.head.sha = 'new-head'; },
    (pr) => { pr.base.sha = 'new-base'; },
    (pr) => { pr.state = 'closed'; },
    (pr) => { pr.head.repo.id = 2; },
    (pr) => { pr.base.repo.id = 2; pr.head.repo.id = 2; },
    (pr) => { pr.base.ref = 'dev'; },
    (pr) => { pr.changed_files++; },
  ]) {
    for (const ref of ['docs', 'preview']) {
      const f = fixture(undefined, { drift }); f.pr.head.ref = ref;
      assert.equal((await f.run()).allowed, false);
    }
  }
});


test('CLI checks paginated API responses and fails closed on mixed files and errors', () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join, resolve } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'main-policy-'));
  try {
    const fake = join(dir, 'gh');
    writeFileSync(fake, `#!/usr/bin/env node
const path = process.argv[3];
const mixed = process.env.FIXTURE === 'mixed';
if (process.env.FIXTURE === 'error') process.exit(2);
const files = Array.from({length:101}, (_, i) => ({filename: mixed && i === 100 ? 'code.js' : i+'.md', status:'added'}));
let data;
if (path === 'repos/owner/repo/pulls/7') data = {state:'open',merged:false,changed_files:101,head:{ref:'docs',sha:'head',repo:{id:1,full_name:'owner/repo'}},base:{ref:'main',sha:'base',repo:{id:1,full_name:'owner/repo'}}};
else if (path.includes('/files?')) { const page = Number(new URL('https://api.github.com/'+path).searchParams.get('page')); data = files.slice((page-1)*100,page*100); }
else if (path.includes('/git/commits/')) data = {tree:{sha:path.endsWith('/base')?'base-tree':'head-tree'}};
else if (path.includes('/git/trees/')) data = {truncated:false,tree:path.includes('/base-tree')?[]:files.map(f=>({path:f.filename,mode:'100644',type:'blob'}))};
else throw new Error('Unexpected API route: '+path);
console.log(JSON.stringify(data));
`);
    chmodSync(fake, 0o755);
    for (const [mode, status] of [['docs', 0], ['mixed', 1], ['error', 2]]) {
      const result = spawnSync(process.execPath, [resolve(__dirname, '../.github/scripts/check-main-pr.cjs')], {
        encoding:'utf8', env:{...process.env, PATH:dir+':'+process.env.PATH, REPO:'owner/repo', PR:'7', SHA:'head', BASE_SHA:'base', FIXTURE:mode},
      });
      assert.equal(result.status, status, result.stdout+' '+result.stderr);
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
