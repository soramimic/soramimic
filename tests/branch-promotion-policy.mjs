import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = async (name) => readFile(
	new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const [automerge, bump, deploy, smoke, preview, release, retarget] = await Promise.all([
	workflow("automerge.yaml"),
	workflow("bump-wordlists.yaml"),
	workflow("deploy.yaml"),
	workflow("frontend-smoke.yaml"),
	workflow("preview.yaml"),
	workflow("release.yaml"),
	workflow("retarget-main-pr.yaml"),
]);

assert.match(automerge, /branches: \[dev, preview, main\]/,
	"自動マージworkflowはdev/preview PRとmain release PRを監視する");
assert.match(automerge,
	/types: \[opened, reopened, synchronize, ready_for_review, converted_to_draft, edited, labeled, unlabeled\]/,
	"待機中のドラフト化やbase変更でも古い自動マージ実行をキャンセルする");
assert.match(automerge,
	/!contains\(github\.event\.pull_request\.labels\.\*\.name, 'emergency'\)/,
	"emergency PRは自動マージ対象から除外する");
assert.match(automerge,
	/!contains\(github\.event\.pull_request\.labels\.\*\.name, 'no-automerge'\)/,
	"no-automerge PRは自動マージ対象から除外する");
assert.match(automerge, /\["golden", "smoke"\] as \$required/,
	"全自動マージ対象でgoldenとsmokeの出現・成功を必須にする");
assert.match(automerge, /\[ "\$required_ready" -eq 2 \]/,
	"必須checkが揃う前に自動マージしない");
assert.match(automerge, /!github\.event\.pull_request\.draft/,
	"ドラフトPRは自動マージ対象から除外する");
assert.match(automerge, /github\.event\.pull_request\.base\.ref == 'dev'/,
	"dev PRを自動マージする");
assert.match(automerge, /github\.event\.pull_request\.base\.ref == 'preview'/,
	"選択promotionとdev直接PRのどちらもpreviewへ自動マージする");
assert.match(automerge, /github\.event\.pull_request\.base\.ref == 'main'/,
	"main向けPRは独立したrelease条件で判定する");
assert.match(automerge, /github\.event\.pull_request\.head\.ref == 'preview'/,
	"mainへ自動マージできるheadをpreviewに限定する");
assert.match(automerge, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
	"forkのpreviewという名前だけでは自動releaseしない");
assert.match(automerge,
	/github\.event\.pull_request\.base\.ref == 'dev'[^]*?\|\|[^]*?github\.event\.pull_request\.base\.ref == 'preview'[^]*?\|\|[^]*?github\.event\.pull_request\.base\.ref == 'main'[^]*?&&[^]*?github\.event\.pull_request\.head\.ref == 'preview'/,
	"同一条件式でmain向け自動マージをpreview releaseだけに限定する");
assert.match(automerge, /\[ "\$BRANCH" != "dev" \] && \[ "\$BRANCH" != "preview" \]/,
	"常設のdev/preview branchは自動マージ後も削除しない");
assert.match(automerge, /gh api "repos\/\$REPO\/pulls\/\$PR"/,
	"マージ直前にPRのlive状態を取得する");
for (const selector of [
	".state", ".draft", ".base.ref", ".head.ref", ".head.repo.full_name", ".head.sha",
]) {
	assert.match(automerge, new RegExp(`jq -r '${selector.replaceAll(".", "\\.")}'`),
		`マージ直前にlive PRの${selector}を再検証する`);
}
assert.match(automerge,
	/jq '\[\.labels\[\]\.name \| select\(\. == "no-automerge" or \. == "emergency"\)\] \| length'/,
	"マージ直前に停止ラベルを再検証する");
assert.match(automerge,
	/\[ "\$live_state" != "open" \][^]*?\[ "\$live_draft" != "false" \][^]*?\[ "\$live_repo" != "\$REPO" \][^]*?\[ "\$live_sha" != "\$SHA" \][^]*?\[ "\$live_base" != "\$BASE" \][^]*?\[ "\$live_branch" != "\$BRANCH" \][^]*?\[ "\$stopped" -ne 0 \]/,
	"live PRが待機開始時と一致する場合だけマージする");
assert.match(automerge,
	/result=\$\(gh api -X PUT[^]*?jq -r '\.merged'\)" != "true"[^]*?echo "merged=true" >> "\$GITHUB_OUTPUT"/,
	"APIが実際のマージ成功を返した場合だけdeployを有効にする");
assert.match(automerge, /for attempt in 1 2 3; do[^]*?\.merged_at \/\/ empty[^]*?sleep 10/,
	"一時的なマージAPI障害を再試行し、応答消失時もlive状態で完了を確認する");
assert.match(automerge, /uses: \.\/\.github\/workflows\/deploy\.yaml/,
	"preview→mainの自動マージ成功後に本番deployを確実に起動する");
assert.match(automerge,
	/needs\.automerge\.outputs\.merged == 'true'[^\n]*base\.ref == 'dev'[^]*?uses: \.\/\.github\/workflows\/preview\.yaml[^]*?ref: dev/,
	"devへのマージ成功後に固定dev環境をデプロイする");
assert.match(automerge,
	/needs\.automerge\.outputs\.merged == 'true'[^\n]*base\.ref == 'preview'[^]*?uses: \.\/\.github\/workflows\/preview\.yaml[^]*?ref: preview/,
	"previewへのマージ成功後に固定preview環境をデプロイする");
assert.match(automerge,
	/needs\.automerge\.outputs\.merged == 'true'[^\n]*github\.event\.pull_request\.base\.ref == 'main'/,
	"本番deployはmain releaseのマージ成功時だけに限定する");

assert.match(preview, /branches: \[dev, preview\]/,
	"devとpreviewを別々の常設環境へデプロイする");
assert.match(smoke, /pull_request:/,
	"dev/preview/main向けPRで必須smoke checkを常に生成する");
assert.doesNotMatch(smoke, /pull_request:\s*\n\s+paths:/,
	"変更パスだけを理由にpreview rulesetの必須smoke checkを欠落させない");
assert.doesNotMatch(preview, /pull_request:/,
	"promotion PRの一時成果物を公開せず、固定previewで確認する");
assert.match(preview, /ALIAS=\"\$RAW\"/, "常設ブランチ名をCloudflare aliasに使う");
assert.doesNotMatch(preview, /alias:\s*\n\s+description:/,
	"再利用呼出からCloudflare aliasを直接指定させない");
assert.match(preview, /workflow_call[^]*REQUESTED_REF[^]*dev\|preview/,
	"再利用呼出のrefをdevまたはpreviewに限定する");

assert.match(deploy, /ref: main/, "本番デプロイはmainだけをcheckoutする");
assert.match(deploy, /--branch main/, "本番デプロイ先はmainで固定する");

assert.doesNotMatch(release, /contents: write|git push|git merge/,
	"release workflowはmainを自動更新しない");
assert.match(release, /refs\/heads\/preview/, "release候補はpreviewから固定する");
assert.match(release, /github\.event\.pull_request\.head\.sha/,
	"release PRのhead SHA自体を再検証する");
assert.match(release, /validate-main-source:[^]*HEAD_REF[^]*IS_EMERGENCY/,
	"main PRの出所をrelease workflow自身でも検証する");

assert.doesNotMatch(bump, /HEAD:main|uses: \.\/\.github\/workflows\/deploy\.yaml/,
	"wordlists更新をmainへ直送しない");
assert.match(bump, /refs\/heads\/dev/, "wordlists更新は検証後にdevだけへ進める");
assert.match(bump, /force-with-lease/, "並行更新時にdevを上書きしない");

assert.match(retarget, /head\.ref != 'preview'/,
	"同一repoのpreview→mainだけを通常releaseとして許可する");
assert.match(retarget, /head\.repo\.full_name != github\.repository/,
	"forkのpreviewという名前だけではrelease扱いしない");

console.log("branch promotion policy: OK");
