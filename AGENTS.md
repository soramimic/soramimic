# Repository agent rules

## Worktree isolation

- Treat the primary worktree as a protected coordination checkout and keep it on `dev`.
- Perform implementation, tests, commits, rebases, and conflict resolution in a session-specific linked worktree.
- Do not switch, reset, clean, or implement changes in the primary worktree.

## Branch promotion safety

- Automatic merging is allowed for pull requests whose base branch is `dev`, and for same-repository `preview` → `main` release pull requests. No other pull request targeting `main` may be automatically merged.
- `dev` is the development/integration branch and may include unapproved word lists.
- `preview` contains only changes explicitly approved for the next production release. Prepare selective promotion pull requests from a branch based on `preview`; never merge all of `dev` into `preview`.
- Do not merge a pull request into `preview` unless the user explicitly approves promoting the named changes in the current conversation.
- `main` is production and accepts normal releases only from `preview`. Creating a same-repository `preview` → `main` pull request at the user's direction is explicit production release approval; the repository workflow must merge it after all mandatory checks pass and complete the associated deployment automatically.
- A passing CI run, a schedule, or a generic instruction such as "finish" is not release approval and must not create a `preview` → `main` pull request.
- Do not add or use the `emergency` label unless the user explicitly requests an emergency release.
