# Repository agent rules

## Delivery

- Ordinary implementation is complete when its pull request is merged into `dev`
  after mandatory checks pass. Use a session-specific linked worktree and task
  branch from `origin/dev`; keep the primary checkout on `dev` and preserve its state.
- Development delivery does not authorize a release. Create or mark ready a
  promotion to `preview` or a `preview` to `main` release only when the user has
  requested that promotion. These pull requests can merge and deploy automatically;
  use `no-automerge` when the requested review requires a separate stop.
- Normal code releases to `main` come only from the same repository's `preview` branch.
  Use the existing merge workflow; do not bypass checks or trigger a duplicate deployment.

## Changes and verification

- Use [README.md](README.md) for the project structure and development commands.
  Initialize `wordlists` at its recorded submodule commit for tests; update that
  pointer only when the requested change requires it.
- Preserve conversion output unless a behavior change is requested. For changes in
  `frontend/src/lib/`, run `node tests/golden/run.cjs` and the affected algorithm or
  editor API tests. Change golden expectations only for an intentional behavior change.
- For frontend behavior, run the relevant browser tests in `frontend/package.json`;
  `npm run test:smoke` includes the production build. Install dependencies with
  `npm ci` in `frontend`.
- For documentation-only changes, check links, command names, and `git diff --check`.
  All mandatory CI checks still apply before merge; workflows in `.github/workflows/`
  define the complete CI commands.
- Preserve the third-party license and attribution notices in [NOTICE](NOTICE).

## Agent coordination

- Default to one agent. Delegate only an explicitly requested or clearly useful,
  bounded independent subtask while the parent advances other work. Use the
  smallest useful team and a self-contained brief; avoid unnecessary full-history
  forks, recursive delegation, duplicate work, and overlapping edits.
- Prefer completion notifications. When blocked on a result, call the native wait
  tool directly with an explicit timeout suited to the expected duration and the
  active runtime and communication limits. Avoid repeated short waits, wrapping
  native agent waits in another yielding tool, and checking status after every
  unchanged timeout.
- Send follow-up messages only for new information, changed scope, or a concrete
  blocker. If a final result conflicts with a running status, inspect once and
  reconcile it instead of polling indefinitely. Respect required progress updates.
- Use bounded waits and incremental output for CI and long commands too. A timeout
  is neither completion nor approval; required checks must still pass before merge.

## Markdown-only main updates

- A same-repository PR containing only regular `.md` files may target `main`
  directly after an explicit request to publish those documentation changes.
  Create that task branch from `origin/main` in a linked worktree so unrelated
  development or preview changes are not included.
  Renames must have Markdown names on both sides. Code, workflow files, symlinks,
  executable files, submodules, and mixed changes do not qualify.
- The workflows verify the complete live diff and recheck it before merging.
  Mandatory CI, branch protections, draft status, and `no-automerge` still apply.
  An API error or incomplete diff is not permission to use the exception.
