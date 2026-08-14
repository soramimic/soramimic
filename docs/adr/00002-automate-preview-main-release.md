# ADR 00002: preview から main へのリリースを自動完了する

- Status: accepted
- Date: 2026-08-14
- Supersedes: none
- Superseded by: none
- Related: PR #90, PR #94, PR #95

## Context

Soramimic は `dev`、`preview`、`main` の3ブランチを、それぞれ開発環境、公開候補環境、
本番環境に対応させている。公開内容は `preview` の固定環境で確認し、同一repositoryの
`preview` から `main` へのpull requestをユーザーの指示で作成することで、対象SHAと公開内容を
明示したリリース承認を表現できる。

PR #90では、この承認後に必須チェックを待ち、マージと本番デプロイを自動完了する仕組みを
導入した。PR #94では `main` へのマージを再び手動操作へ戻したが、これはPR作成とは別に
同じリリース判断をもう一度要求し、自動化の途中で処理を止める。承認境界はpull requestの
作成またはready化に置き、その後の機械的な検証・マージ・デプロイは一続きに実行する。

GitHub Actionsの `GITHUB_TOKEN` でpull requestをマージした場合、そのpushから別workflowが
起動しないことがある。そのため、自動マージを行ったworkflow自身が、マージ成功を確認してから
本番deploy workflowを再利用呼び出しする必要がある。

## Decision

- ユーザーの指示で作成またはready化した、同一repositoryの非ドラフト
  `preview` → `main` pull requestを本番リリースの明示承認とする。
- release pull requestがopenかつreadyである間はリリース承認が継続する。`preview` のheadが
  更新された場合は古い待機をキャンセルし、新しいhead SHAで全チェックを最初から実行する。
  リリースを保留する場合はdraft化、`no-automerge` ラベル、またはcloseで明示的に停止する。
- release pull requestは `golden` と `smoke` を含む全チェックの完了を待ち、失敗がなく、
  必須チェックが成功した場合にrepositoryのautomerge workflowが自動マージする。
- マージ直前にPRのopen状態、draft状態、base、head、head repository、head SHA、停止ラベルを
  live APIで再検証する。待機開始時から対象が変わっていた場合はマージしない。
- `no-automerge` または `emergency` ラベル付きPR、forkからのPR、`preview` 以外をheadとする
  `main` 向けPRは自動マージしない。
- APIが実際のマージ成功を返した場合だけ、automerge workflowから本番deploy workflowを
  直接呼び出す。デプロイは最新の `main` をcheckoutし、本番環境へ反映する。
- CI成功、schedule実行、または「finish」のような一般的な指示だけではリリース承認とせず、
  エージェントが独断で `preview` → `main` pull requestを作成してはならない。
- `main` にこのworkflowがまだ存在せず、pull request eventで自動化を起動できない初回導入時だけ、
  必須チェックと対象SHAを確認したうえで手動マージしてbootstrapする。以後の通常releaseでは
  手動マージを承認工程として追加しない。

## Consequences

- ユーザーは公開候補を確認してrelease pull requestの作成を指示すればよく、その後の待機、
  マージ、本番デプロイは自動で完了する。
- マージ対象はPR eventごとのhead SHAとして記録される。`preview` が更新された場合も古いSHAを
  マージせず、新しいSHAのCIとlive状態を再検証する。
- 自動マージ経路でも、fork、停止ラベル、必須チェック、live状態の再検証により、通常の
  `main` 向けPRを誤って本番へ入れない。
- 自動化障害時は本番反映が止まる。原因を解消してworkflowを再実行することを優先し、通常運用を
  恒常的な手動マージへ戻す場合は、このADRを置き換える新しいADRで承認境界と理由を記録する。
