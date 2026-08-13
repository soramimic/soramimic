# Repository agent rules

## Worktree isolation

- Treat the primary worktree as a protected coordination checkout and keep it on `dev`.
- Perform implementation, tests, commits, rebases, and conflict resolution in a session-specific linked worktree.
- Do not switch, reset, clean, or implement changes in the primary worktree.

## Branch promotion safety

- Automatic merging is allowed for non-draft, same-repository pull requests whose base branch is `dev` or `preview`. Pull requests from forks and pull requests labeled `no-automerge` or `emergency` are excluded. Pull requests targeting `main` may not be automatically merged.
- `dev` is the development/integration branch and may include unapproved word lists.
- `preview` contains changes selected for the next production release. Prefer a selective promotion pull request from a branch based on `preview` when only part of `dev` should ship; a direct `dev` → `preview` pull request is also allowed when all current development changes should ship.
- Creating or marking ready a same-repository pull request to `dev` or `preview` authorizes the repository workflow to merge it after all mandatory checks pass and deploy the corresponding fixed environment automatically.
- `main` is production and accepts normal releases only from `preview`. Do not merge a `preview` to `main` release pull request or deploy production until the user explicitly approves after reviewing preview.
- A passing CI run, a schedule, or a generic instruction such as "finish" is not release approval.
- Do not add or use the `emergency` label unless the user explicitly requests an emergency release.
