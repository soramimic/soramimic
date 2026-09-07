// Run only from the trusted base checkout, never from the PR head.
const { execFileSync } = require("node:child_process");
const { classify } = require("./main-pr-policy.cjs");
function api(path) {
  const args = ["api", path];
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}
const pulls = {
  get: async ({ owner, repo, pull_number }) => ({ data: api(`repos/${owner}/${repo}/pulls/${pull_number}`) }),
  listFiles: async ({ owner, repo, pull_number, per_page, page }) => ({ data: api(`repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=${per_page}&page=${page}`) }),
};
const github = {
  rest: {
    pulls,
    git: {
      getCommit: async ({ owner, repo, commit_sha }) => ({ data: api(`repos/${owner}/${repo}/git/commits/${commit_sha}`) }),
      getTree: async ({ owner, repo, tree_sha }) => ({ data: api(`repos/${owner}/${repo}/git/trees/${tree_sha}?recursive=1`) }),
    },
  },
};
(async () => {
  const [owner, repo, extra] = (process.env.REPO || "").split("/");
  const pull_number = Number(process.env.PR);
  if (!owner || !repo || extra || !Number.isSafeInteger(pull_number) || pull_number <= 0) throw new Error("Invalid repository or PR");
  const result = await classify({ github, owner, repo, pull_number,
    expectedHead: process.env.SHA, expectedBase: process.env.BASE_SHA });
  console.log(result.reason);
  process.exitCode = result.allowed ? 0 : 1;
})().catch((error) => { console.error(error.message); process.exitCode = 2; });
