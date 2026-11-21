import assert from "node:assert/strict";
import test from "node:test";

import {
  contributors,
  groupCommits,
  parseSubject,
  previousTag,
  readCommits,
  renderNotes,
  sectionFor,
} from "../scripts/release-notes.mjs";

const commit = (subject, extra = {}) => ({
  sha: "0123456789abcdef0123456789abcdef01234567",
  short: "0123456",
  subject,
  author: "xiguazhiPrince",
  email: "34903051+xiguazhiPrince@users.noreply.github.com",
  ...extra,
});

test("a conventional subject splits without losing the Chinese text", () => {
  assert.deepEqual(parseSubject("fix: 嵌入模式的画布不再藏掉版本号"), {
    type: "fix",
    scope: null,
    text: "嵌入模式的画布不再藏掉版本号",
  });
  assert.deepEqual(parseSubject("feat(canvas)!: 元素可以作为引用胶囊"), {
    type: "feat",
    scope: "canvas",
    text: "元素可以作为引用胶囊",
  });
  // A repository-specific prefix still parses: the type is what decides the
  // section, the text is what the reader sees.
  assert.deepEqual(parseSubject("canvas: 单击选层级"), {
    type: "canvas",
    scope: null,
    text: "单击选层级",
  });
});

test("the commit prefix decides the What's New section", () => {
  assert.equal(sectionFor("feat: 新东西"), "features");
  assert.equal(sectionFor("fix: 修一个洞"), "fixes");
  assert.equal(sectionFor("perf: 快一点"), "changes");
  assert.equal(sectionFor("refactor: 换个写法"), "changes");
  assert.equal(sectionFor("canvas: 单击选层级"), "changes");
  assert.equal(sectionFor("brand: 改名 justSkill"), "changes");
  // Bookkeeping never claims a user-facing change.
  assert.equal(sectionFor("chore: release 3.3.2"), null);
  assert.equal(sectionFor("test: 补一条回归"), null);
  assert.equal(sectionFor("docs: 加一份发版清单"), null);
  assert.equal(sectionFor("ci: 换 runner"), null);
});

test("a release commit stays out of What's New but inside Commits", () => {
  const notes = renderNotes({
    version: "3.3.2",
    from: "v3.3.1",
    to: "v3.3.2",
    repo: "justskill-ai/justskill-design",
    commits: [
      commit("chore: release 3.3.2"),
      commit("fix: 嵌入模式的画布不再藏掉版本号"),
    ],
  });

  assert.match(notes, /^## Install \/ Update$/m);
  assert.match(notes, /dsh plugin --profile web update justskill-design@latest/);
  assert.match(notes, /npx skills update/);
  assert.match(notes, /^### Fixes$/m);
  assert.doesNotMatch(notes, /^### Features$/m, "an empty section is not printed");
  assert.match(notes, /^- 嵌入模式的画布不再藏掉版本号$/m);
  assert.match(notes, /^- chore: release 3\.3\.2 \(/m);
  assert.match(notes, /\[v3\.3\.1\.\.\.v3\.3\.2\]\(https:\/\/github\.com\/justskill-ai\/justskill-design\/compare\/v3\.3\.1\.\.\.v3\.3\.2\) · 2 commits/);
  assert.match(notes, /^## Contributors$/m);
  assert.match(notes, /^- @xiguazhiPrince$/m);
});

test("a first release has no compare link and says so plainly", () => {
  const notes = renderNotes({
    version: "1.0.0",
    repo: "justskill-ai/justskill-design",
    commits: [commit("feat: 第一个版本")],
  });
  assert.match(notes, /^### Features$/m);
  assert.match(notes, /1 commits/);
  assert.doesNotMatch(notes, /compare\//);
});

test("grouping keeps the order git printed, newest first", () => {
  const groups = groupCommits([
    commit("feat: 后写的"),
    commit("feat: 先写的"),
    commit("chore: release 9.9.9"),
  ]);
  assert.deepEqual(groups.features, ["后写的", "先写的"]);
});

test("contributors come from the noreply addresses everyone already uses", () => {
  assert.deepEqual(
    contributors([
      commit("feat: a", { email: "34903051+xiguazhiPrince@users.noreply.github.com" }),
      commit("feat: b", { email: "someone@users.noreply.github.com" }),
      commit("feat: c", { email: "hi@example.com" }),
      commit("feat: d", { email: "34903051+xiguazhiPrince@users.noreply.github.com" }),
    ]),
    ["someone", "xiguazhiPrince"],
  );
});

test("the repository's own history renders without a missing tag", () => {
  // Integration with this checkout: the range that produced 3.3.2 is known.
  const commits = readCommits({ from: "v3.3.1", to: "v3.3.2" });
  const subjects = commits.map((entry) => entry.subject);
  assert.equal(subjects.includes("fix: 嵌入模式的画布不再藏掉版本号"), true);
  const rendered = renderNotes({
    version: "3.3.2",
    from: "v3.3.1",
    to: "v3.3.2",
    repo: "justskill-ai/justskill-design",
    commits,
  });
  assert.match(rendered, /^## Install \/ Update$/m);
  assert.equal(previousTag("v3.3.2").startsWith("v3."), true);
});
