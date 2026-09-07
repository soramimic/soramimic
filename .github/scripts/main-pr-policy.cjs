'use strict';

const MAX_FILES = 3000;
const PAGE_SIZE = 100;
const isMarkdown = (path) => typeof path === 'string' && /\.md$/i.test(path);

// Read only trusted API metadata. Never check out or execute the proposed head.
async function classify({ github, owner, repo, pull_number, expectedHead, expectedBase }) {
  const params = { owner, repo, pull_number };
  const { data: pr } = await github.rest.pulls.get(params);
  const headSha = pr.head?.sha;
  const baseSha = pr.base?.sha;
  const result = (allowed, markdownOnly, reason) => ({ allowed, markdownOnly, headSha, baseSha, reason, pr });
  const repository = `${owner}/${repo}`.toLowerCase();
  const eligible = (value) => value.state === 'open' && !value.merged &&
    value.base?.ref === 'main' && typeof value.head?.ref === 'string' &&
    typeof value.head?.sha === 'string' && typeof value.base?.sha === 'string' &&
    value.base?.repo?.full_name?.toLowerCase() === repository &&
    value.head?.repo?.full_name?.toLowerCase() === repository &&
    value.base.repo.id != null && value.head.repo.id === value.base.repo.id;
  if (!eligible(pr)) return result(false, false, 'An open, same-repository pull request targeting main is required.');
  if ((expectedHead !== undefined && expectedHead !== headSha) ||
      (expectedBase !== undefined && expectedBase !== baseSha)) {
    return result(false, false, 'The expected head or base has changed.');
  }

  const unchanged = async () => {
    const { data: current } = await github.rest.pulls.get(params);
    return eligible(current) && current.head.sha === headSha && current.base.sha === baseSha &&
      current.head.ref === pr.head.ref && current.base.ref === pr.base.ref &&
      current.head.repo.id === pr.head.repo.id && current.base.repo.id === pr.base.repo.id &&
      current.changed_files === pr.changed_files;
  };
  if (pr.head.ref === 'preview') {
    return await unchanged()
      ? result(true, false, 'Same-repository preview promotion.')
      : result(false, false, 'The pull request changed during classification.');
  }

  const count = pr.changed_files;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
    return result(false, false, 'The file count is empty, unavailable, or exceeds the API limit.');
  }
  const files = [];
  for (let page = 1; page <= MAX_FILES / PAGE_SIZE + 1; page++) {
    const { data } = await github.rest.pulls.listFiles({ ...params, per_page: PAGE_SIZE, page });
    if (!Array.isArray(data) || data.length > PAGE_SIZE) return result(false, false, 'Invalid file listing.');
    files.push(...data);
    if (files.length > count) return result(false, false, 'The file listing does not match the pull request.');
    if (data.length < PAGE_SIZE) break;
  }
  if (files.length !== count || new Set(files.map((file) => file.filename)).size !== count) {
    return result(false, false, 'The file listing is incomplete or duplicated.');
  }
  for (const file of files) {
    if (!isMarkdown(file.filename) ||
        !['added', 'removed', 'modified', 'renamed'].includes(file.status) ||
        (file.status === 'renamed' && !isMarkdown(file.previous_filename))) {
      return result(false, false, 'Every changed path, including rename sources, must be Markdown.');
    }
  }

  async function readTree(commitSha) {
    const { data: commit } = await github.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
    if (!commit.tree?.sha) throw new Error('Missing commit tree.');
    const { data: tree } = await github.rest.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: 'true' });
    if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete Git tree.');
    const entries = new Map();
    for (const entry of tree.tree) {
      if (typeof entry.path !== 'string' || entries.has(entry.path)) throw new Error('Invalid Git tree.');
      entries.set(entry.path, entry);
    }
    return entries;
  }
  const [baseTree, headTree] = await Promise.all([readTree(baseSha), readTree(headSha)]);
  const regular = (tree, path) => tree.get(path)?.type === 'blob' && tree.get(path)?.mode === '100644';
  for (const file of files) {
    const oldPath = file.status === 'renamed' ? file.previous_filename : file.filename;
    const paths = new Set([oldPath, file.filename]);
    const unsafeExistingPath = [...paths].some((path) =>
      [baseTree, headTree].some((tree) => tree.has(path) && !regular(tree, path)));
    if (unsafeExistingPath ||
        (file.status !== 'added' && !regular(baseTree, oldPath)) ||
        (file.status !== 'removed' && !regular(headTree, file.filename)) ||
        (file.status === 'added' && baseTree.has(file.filename)) ||
        (file.status === 'removed' && headTree.has(file.filename))) {
      return result(false, false, 'Markdown changes must contain only regular, non-executable files.');
    }
  }
  if (!await unchanged()) return result(false, false, 'The pull request changed during classification.');
  return result(true, true, 'All changed files are regular Markdown files.');
}

module.exports = { classify };
