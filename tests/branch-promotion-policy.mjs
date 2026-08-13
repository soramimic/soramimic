import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = async (name) => readFile(
	new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const [automerge, bump, deploy, preview, release, retarget] = await Promise.all([
	workflow("automerge.yaml"),
	workflow("bump-wordlists.yaml"),
	workflow("deploy.yaml"),
	workflow("preview.yaml"),
	workflow("release.yaml"),
	workflow("retarget-main-pr.yaml"),
]);

assert.match(automerge, /branches: \[dev\]/, "自動マージはdev PRだけを対象にする");
assert.doesNotMatch(automerge, /branches: \[(?:preview|main)/,
	"preview/mainを自動マージ対象にしない");

assert.match(preview, /branches: \[dev, preview\]/,
	"devとpreviewを別々の常設環境へデプロイする");
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
