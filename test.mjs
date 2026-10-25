/**
 * dsh-skills-manager — unit tests for the pure logic in lib.js.
 * Run with `node --test test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ACTIVATION_MODES,
  INSTALL_GATE_MODES,
  GATED_ACTIONS,
  defaultConfig,
  defaultState,
  parseStateText,
  serializeState,
  validateState,
  changedSkills,
  resolveActivationMode,
  parseTriggers,
  triggerListOf,
  mergeTriggers,
  normalizeHooks,
  sanitizeHooks,
  hookCount,
  matchHookWhen,
  toolCallText,
  resultText,
  activeSkillNames,
  ACTIVATION_MODE_ALIASES,
  recordMatches,
  scopeOfRecord,
  tokenize,
  overlapRatio,
  scoreSkill,
  rankSkills,
  selectActivations,
  activationStateOf,
  batchHasInjection,
  renderActivationReminder,
  renderSuggestionNotice,
  normalizeGitSourceUrl,
  isGitSourceUrl,
  isGatedAction,
  truncateText,
  renderGateAskLine,
  renderGateDenial,
  parseCandidateCatalog,
  rankCandidates,
  candidateIsInstalled,
  renderProposalText,
  findSkillDirs,
  parsePluginHookCommand,
  normalizePluginHookManifest,
  readPluginPackage,
  parseFrontmatterSlim,
  shortCommit,
  pushEvent,
  renderSyncSummary,
} from "./lib.js";

const skill = (overrides = {}) => ({
  name: "ponytail-review",
  description: "Code review for over-engineering; finds what to delete.",
  whenToUse: "review for over-engineering",
  invocation: { modelInvocable: true, userInvocable: true },
  provider: "filesystem",
  source: "user",
  metadata: { triggers: ["over-engineering", "what can we delete"], activation: "auto" },
  ...overrides,
});
const managerSource = (data) => ({
  kind: "plugin:dsh-skills-manager", form: "notice", summary: JSON.stringify(data),
});

test("tokenize extracts latin words and CJK bigrams", () => {
  const tokens = tokenize("review this MR for over-engineering 管理界面");
  assert.ok(tokens.has("review"));
  assert.ok(tokens.has("over"));
  assert.ok(tokens.has("engineering"));
  assert.ok(tokens.has("管理"));
  assert.ok(tokens.has("理界"));
});

test("parseTriggers handles substring and regex triggers", () => {
  const parsed = parseTriggers({ triggers: ["CI fail", "re:exit code \\d+", "re:["] });
  assert.equal(parsed.length, 2, "broken regex is dropped");
  assert.equal(parsed[0].kind, "sub");
  assert.equal(parsed[1].kind, "re");
  assert.ok(parseTriggers({ triggers: ["re:\\d{4}"] })[0].re.test("exit code 1234"));
  assert.deepEqual(triggerListOf({ triggers: [1, "ok"] }), ["ok"]);
  assert.deepEqual(triggerListOf(undefined), []);
});

test("normalizeHooks parses Claude-Code-style declarations and user overrides", () => {
  const metadata = {
    hooks: {
      UserPromptSubmit: { inject: "Always remind: YAGNI." },
      PreToolUse: [{ tool: "bash", when: "git push", decision: "deny", reason: "no direct push" }, { tool: "read", decision: "allow" }, { decision: "deny", when: "" }, { tool: "bash", decision: "bogus" }],
      PostToolUse: [{ tool: "bash", when: "re:exit code [1-9]", action: "activate" }, { tool: "bash", action: "ignore" }],
      SessionStart: { activate: true },
    },
  };
  const hooks = normalizeHooks(metadata, undefined);
  assert.equal(hooks.inject, "Always remind: YAGNI.");
  assert.equal(hooks.preToolUse.length, 3, "invalid decisions dropped; missing tool defaults to *");
  assert.equal(hooks.preToolUse[0].decision, "deny");
  assert.equal(hooks.postToolUse.length, 1);
  assert.equal(hooks.sessionStartActivate, true);
  assert.equal(hookCount(hooks), 6);
  const overridden = normalizeHooks(metadata, { PreToolUse: [] });
  assert.equal(overridden.preToolUse.length, 0, "user hooks replace metadata per event");
  assert.equal(overridden.inject, "Always remind: YAGNI.", "other events keep metadata");
});

test("sanitizeHooks keeps only known events with plausible values", () => {
  const clean = sanitizeHooks({
    UserPromptSubmit: { inject: "x".repeat(3000), evil: true },
    PreToolUse: [{ tool: "bash", when: "git", decision: "deny", reason: "r", bogus: 1 }],
    EventUnknown: { anything: true },
    SessionStart: { activate: true },
  });
  assert.equal(clean.UserPromptSubmit.inject.length, 2000);
  assert.equal(clean.PreToolUse.length, 1);
  assert.equal(clean.PreToolUse[0].bogus, undefined);
  assert.equal(clean.EventUnknown, undefined);
  assert.deepEqual(clean.SessionStart, { activate: true });
  assert.deepEqual(sanitizeHooks(null), {});
});

test("matchHookWhen supports substring, regex, and empty wildcard", () => {
  assert.equal(matchHookWhen("git push", "bash git push -f"), true);
  assert.equal(matchHookWhen("git push", "bash git status"), false);
  assert.equal(matchHookWhen("re:exit code [1-9]", "exit code 7"), true);
  assert.equal(matchHookWhen(undefined, "anything"), true);
  assert.equal(matchHookWhen("", "anything"), true);
  assert.equal(matchHookWhen("re:[", "anything"), false, "broken regex matches nothing");
});

test("toolCallText and resultText build searchable text", () => {
  assert.equal(toolCallText("bash", { command: "git push" }), 'bash {"command":"git push"}');
  assert.ok(toolCallText("bash", undefined).startsWith("bash"));
  assert.ok(resultText([{ type: "text", text: "exit code 7" }]).includes("exit code 7"));
  assert.equal(resultText([{ type: "image", url: "x" }]), "");
});

test("activeSkillNames collects activation markers from events", () => {
  const events = [
    { type: "user/message", seq: 1, data: { source: managerSource({ form: "activation", name: "ponytail", turn: 1 }) } },
    { type: "user/message", seq: 2, data: { source: managerSource({ form: "suggestion", names: ["ci-status"] }) } },
    { type: "user/message", seq: 3, data: { source: { kind: "skill-manager", form: "activation", name: "ponytail", turn: 2 } } },
    { type: "user/message", seq: 4, data: { source: { kind: "plugin", plugin: "dsh-skills-manager", form: "notice", summary: JSON.stringify({ form: "activation", name: "ponytail", turn: 3 }) } } },
  ];
  assert.deepEqual(activeSkillNames(events), ["ponytail"]);
});

test("Codex mode aliases map manual/disabled to off", () => {
  assert.equal(resolveActivationMode({ activation: "manual" }, undefined), "off");
  assert.equal(resolveActivationMode({ activation: "disabled" }, undefined), "off");
  assert.equal(resolveActivationMode({ activation: "auto" }, undefined), "auto");
  assert.ok(ACTIVATION_MODE_ALIASES);
});

test("recordMatches scopes overrides to their owning root", () => {
  const userRecord = { mode: "auto", scope: undefined, cwd: undefined };
  assert.equal(recordMatches(userRecord, "user-dsh", undefined), true);
  assert.equal(recordMatches(userRecord, "user-agents", undefined), true);
  assert.equal(recordMatches(userRecord, "bundled", undefined), true);
  assert.equal(recordMatches(userRecord, "project-dsh", "/repo"), false, "user record never hits project skills");
  const projectRecord = { mode: "auto", scope: "project", cwd: "/repo" };
  assert.equal(recordMatches(projectRecord, "project-dsh", "/repo"), true);
  assert.equal(recordMatches(projectRecord, "project-agents", "/repo"), true);
  assert.equal(recordMatches(projectRecord, "project-dsh", "/other"), false, "project record is cwd-bound");
  assert.equal(recordMatches(projectRecord, "user-dsh", "/repo"), false, "project record never hits user skills");
  assert.equal(recordMatches(undefined, "user-dsh", undefined), false);
  assert.equal(scopeOfRecord({ scope: "project" }), "project");
  assert.equal(scopeOfRecord({}), "user");
});

test("rankSkills applies project overrides only in their workspace", () => {
  const projectSkill = {
    name: "proj-review",
    description: "Project review",
    invocation: { modelInvocable: true, userInvocable: true },
    provider: "filesystem",
    source: "project-dsh",
  };
  const state = defaultState();
  state.skills["proj-review"] = { mode: "off", scope: "project", cwd: "/repo" };
  const inRepo = rankSkills([projectSkill], "review the project", state, "/repo");
  assert.equal(inRepo[0].mode, "off", "project override applies in its workspace");
  const elsewhere = rankSkills([projectSkill], "review the project", state, "/other");
  assert.equal(elsewhere[0].mode, "suggest", "override does not leak into other workspaces");
  const asUser = rankSkills([{ ...projectSkill, source: "user-dsh" }], "review the project", state, "/repo");
  assert.equal(asUser[0].mode, "suggest", "project record never applies to user-root skills");
});

test("state round-trip keeps project scope and hooks", () => {
  const state = defaultState();
  state.skills["p"] = { mode: "auto", hooks: { SessionStart: { activate: true } }, scope: "project", cwd: "/repo" };
  const parsed = parseStateText(serializeState(state));
  assert.equal(parsed.skills.p.scope, "project");
  assert.equal(parsed.skills.p.cwd, "/repo");
  assert.deepEqual(parsed.skills.p.hooks, { SessionStart: { activate: true } });
});

test("scoreSkill ranks name > trigger > description", () => {
  const query = "please review what can we delete in this repo";
  const scored = scoreSkill(skill(), query.toLocaleLowerCase());
  assert.ok(scored.score >= 7, `expected trigger-level score, got ${scored.score}`);
  const byName = scoreSkill(skill(), "ponytail-review the repo");
  assert.ok(byName.score >= 12, `expected name-level score, got ${byName.score}`);
  const named = scoreSkill(skill(), "ponytail-review");
  assert.ok(named.score >= 12, `expected name-level score, got ${named.score}`);
  const unrelated = scoreSkill(skill(), "how to bake a cake 12345");
  assert.equal(unrelated.score, 0);
  const noMatch = scoreSkill(skill(), "this task has nothing to do with it at all");
  assert.equal(noMatch.score, 0);
});

test("no early name match inside another word", () => {
  const scored = scoreSkill(skill(), "not-ponytail-reviewing anything");
  assert.equal(scoreSkill(skill(), "reviewing").reasons.length, 0);
  assert.ok(scored.score < 12);
});

test("resolveActivationMode precedence: override > metadata > derived", () => {
  assert.equal(resolveActivationMode({ activation: "auto" }, "off"), "off");
  assert.equal(resolveActivationMode({ activation: "off" }, undefined), "off");
  assert.equal(resolveActivationMode({ triggers: ["x"] }, undefined), "auto");
  assert.equal(resolveActivationMode({}, undefined), "suggest");
  assert.equal(resolveActivationMode(undefined, "bogus"), "suggest");
});

test("rankSkills respects modelInvocable and sorts by score", () => {
  const skills = [
    skill(),
    skill({ name: "ci-status", description: "CI checks", metadata: {} }),
    skill({ name: "hidden", description: "hidden", invocation: { modelInvocable: false, userInvocable: true } }),
  ];
  const ranked = rankSkills(skills, "review this code", defaultState());
  assert.ok(ranked[0].skill.name === "ponytail-review", "description match wins");
  assert.ok(ranked.every((entry) => entry.skill.name !== "hidden"));
});

test("selectActivations caps auto and demotes overflow to suggest", () => {
  const state = defaultState();
  const ranked = [1, 2, 3, 4].map((index) => ({
    skill: skill({ name: `skill-${index}`, metadata: { activation: "auto" } }),
    mode: "auto",
    score: 12,
    reasons: ["name"],
  }));
  const config = { ...defaultConfig(), maxAuto: 2, maxSuggest: 2, autoThreshold: 7, suggestThreshold: 4 };
  const picked = selectActivations(ranked, config);
  assert.equal(picked.auto.length, 2);
  assert.equal(picked.suggest.length, 2);
  assert.deepEqual(picked.auto.map((e) => e.skill.name), ["skill-1", "skill-2"]);
  assert.deepEqual(picked.suggest.map((e) => e.skill.name), ["skill-3", "skill-4"]);
});

test("off mode never activates", () => {
  const ranked = [{
    skill: skill({ metadata: {} }),
    mode: "off",
    score: 12,
    reasons: ["name"],
  }];
  const picked = selectActivations(ranked, defaultConfig());
  assert.equal(picked.auto.length + picked.suggest.length, 0);
});

test("activationStateOf respects surface visibility", () => {
  const events = [
    { type: "user/message", seq: 5, data: { source: managerSource({ form: "activation", name: "ponytail-review", turn: 2 }) } },
    { type: "user/message", seq: 9, data: { source: managerSource({ form: "activation", name: "ponytail-review", turn: 3 }) } },
    { type: "user/message", seq: 12, data: { source: { kind: "skill-manager", form: "suggestion", names: ["ponytail-review"], turn: 4 } } },
  ];
  assert.deepEqual(activationStateOf(events, new Set([9]), "ponytail-review"), { active: true, turn: 3 });
  assert.deepEqual(activationStateOf(events, new Set([8]), "ponytail-review"), { active: false, turn: 3 });
  assert.deepEqual(activationStateOf(events, new Set([12]), "other-skill"), { active: false });
});

test("batchHasInjection only matches manager messages", () => {
  assert.equal(batchHasInjection([{ source: { kind: "user" } }, { source: managerSource({ form: "suggestion" }) }]), true);
  assert.equal(batchHasInjection([{ source: { kind: "skill-manager" } }]), true, "legacy sessions stay readable");
  assert.equal(batchHasInjection([{ source: { kind: "plugin", plugin: "dsh-skills-manager" } }]), true, "retired plugin sources stay readable");
  assert.equal(batchHasInjection([{ source: { kind: "plugin", plugin: "other", form: "notice", summary: "x" } }]), false);
  assert.equal(batchHasInjection([{ source: { kind: "user" } }]), false);
  assert.equal(batchHasInjection([{}]), false);
});

test("render helpers name the matched skills", () => {
  const entry = { skill: skill(), reasons: ["trigger:CI fail"] };
  const activation = renderActivationReminder([entry]);
  assert.ok(activation.includes("ponytail-review"));
  assert.ok(activation.includes("automatically activated"));
  const notice = renderSuggestionNotice([entry]);
  assert.ok(notice.includes("skill` tool"));
  assert.ok(notice.includes("ponytail-review"));
});

test("git sources accept Codex URLs and Claude/Codex owner/repo shorthand", () => {
  assert.equal(normalizeGitSourceUrl("Wisdoverse/ci-status-snapshot"), "https://github.com/Wisdoverse/ci-status-snapshot.git");
  assert.equal(normalizeGitSourceUrl("DietrichGebert/ponytail.git"), "https://github.com/DietrichGebert/ponytail.git");
  assert.equal(isGitSourceUrl("https://github.com/a/b.git"), true);
  assert.equal(isGitSourceUrl("git@github.com:a/b.git"), true);
  assert.equal(isGitSourceUrl("ssh://git@github.com/a/b.git"), true);
  assert.equal(isGitSourceUrl("owner/repo/path"), false);
  assert.equal(isGitSourceUrl("-upload-pack=evil"), false);
  assert.equal(isGitSourceUrl("file:///etc/passwd"), false);
  assert.equal(isGitSourceUrl(""), false);
});

test("Codex/Claude plugin manifests expose safe lifecycle hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-"));
  try {
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({
      name: "ponytail",
      version: "4.9.0",
      hooks: "./hooks/hooks.json",
    }));
    await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/start.js\"", timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/prompt.js\"" }] }],
        SubagentStart: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/subagent.js\"" }] }],
      },
    }));
    const plugin = await readPluginPackage(root);
    assert.equal(plugin.name, "ponytail");
    assert.equal(plugin.version, "4.9.0");
    assert.deepEqual(plugin.hooks.map((hook) => [hook.event, hook.script]), [
      ["SessionStart", "hooks/start.js"],
      ["UserPromptSubmit", "hooks/prompt.js"],
    ]);
    assert.deepEqual(plugin.unsupportedHooks, ["SubagentStart"]);
    assert.equal(parsePluginHookCommand("node \"${CLAUDE_PLUGIN_ROOT}/../evil.js\""), null);
    assert.deepEqual(normalizePluginHookManifest({ hooks: {} }), { hooks: [], unsupportedHooks: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter slim parse reads name and description", () => {
  const raw = "---\nname: my-skill\ndescription: does things\nmetadata:\n  triggers:\n    - x\n---\n# body\n";
  const parsed = parseFrontmatterSlim(raw);
  assert.equal(parsed.name, "my-skill");
  assert.equal(parsed.description, "does things");
  const folded = parseFrontmatterSlim("---\nname: folded\ndescription: >\n  first line\n  second line\nargument-hint: x\n---\n");
  assert.equal(folded.description, "first line second line");
  assert.equal(parseFrontmatterSlim("# no frontmatter"), null);
});

test("findSkillDirs discovers SKILL.md dirs including platform-hidden dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    await mkdir(join(root, "sk1/references"), { recursive: true });
    await writeFile(join(root, "sk1/SKILL.md"), "---\nname: sk1\n---\nbody\n");
    await writeFile(join(root, "sk1/references/guide.md"), "hello");
    await mkdir(join(root, "deep/nested/sk2"), { recursive: true });
    await writeFile(join(root, "deep/nested/sk2/SKILL.md"), "---\nname: sk2\n---\nbody\n");
    await mkdir(join(root, ".openclaw/skills/ponytail"), { recursive: true });
    await writeFile(join(root, ".openclaw/skills/ponytail/SKILL.md"), "---\nname: ponytail\n---\nbody\n");
    await mkdir(join(root, "skills/ponytail"), { recursive: true });
    await writeFile(join(root, "skills/ponytail/SKILL.md"), "---\nname: ponytail\n---\nbody\n");
    await mkdir(join(root, "skills/ci-status-snapshot"), { recursive: true });
    await writeFile(join(root, "skills/ci-status-snapshot/SKILL.md"), "---\nname: ci-status-snapshot\n---\nbody\n");
    await mkdir(join(root, ".git"), { recursive: true });
    const found = await findSkillDirs(root);
    assert.ok(found.some((item) => item.name === "sk1" && item.relPath === "sk1"));
    assert.ok(found.some((item) => item.name === "sk2" && item.relPath === "deep/nested/sk2"));
    assert.deepEqual(found.filter((item) => item.name === "ponytail").map((item) => item.relPath), ["skills/ponytail"]);
    assert.ok(found.some((item) => item.name === "ci-status-snapshot" && item.relPath === "skills/ci-status-snapshot"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeTriggers dedupes and filters malformed entries", () => {
  assert.deepEqual(mergeTriggers({ triggers: ["a", "b"] }, ["b", "c", 7]), ["a", "b", "c"]);
  assert.deepEqual(mergeTriggers(undefined, ["x"]), ["x"]);
});

test("user triggers fire auto-level scoring even without declared metadata", () => {
  const plain = skill({ metadata: undefined });
  const hit = scoreSkill(plain, "please harden this repo now", ["harden"]);
  assert.ok(hit.score >= 7, `expected trigger score from user triggers, got ${hit.score}`);
  assert.ok(hit.reasons.includes("trigger:harden"));
  const miss = scoreSkill(plain, "unrelated text", ["harden"]);
  assert.equal(miss.score, 0);
});

test("state parse/validate/serialize round-trip", () => {
  const state = defaultState();
  state.config.maxAuto = 3;
  state.skills["x"] = { sourceId: "s", sourceUrl: "https://x", ref: "main", commit: "abc1234", relPath: ".", installedAt: "t", mode: "auto", triggers: ["harden"] };
  state.skillSources = [{
    id: "s",
    url: "https://x",
    ref: "main",
    clonePath: "/tmp/x",
    commit: "abc1234",
    installedAt: "t",
    plugin: { name: "p", version: "1", manifest: ".codex-plugin/plugin.json", hooksFile: "hooks/hooks.json", hooks: [{ event: "SessionStart", script: "hooks/start.js", timeoutMs: 5000 }], unsupportedHooks: ["SubagentStart"] },
    skills: [{ name: "x", relPath: "." }],
  }];
  const parsed = parseStateText(serializeState(state));
  assert.equal(parsed.config.maxAuto, 3);
  assert.equal(parsed.skills.x.mode, "auto");
  assert.equal(parsed.skillSources[0].plugin.hooks[0].script, "hooks/start.js");
  assert.deepEqual(parsed.skills.x.triggers, ["harden"]);
  assert.equal(parseStateText("not json"), null);
  assert.throws(() => validateState([1, 2]));
  assert.equal(parseStateText("").config.enabled, true);
});

test("changedSkills lists only commit moves", () => {
  const before = defaultState();
  before.skills.a = { commit: "1111111" };
  before.skills.b = { commit: "2222222" };
  const after = defaultState();
  after.skills.a = { commit: "1111111" };
  after.skills.b = { commit: "3333333" };
  const changed = changedSkills(before, after);
  assert.deepEqual(changed, [{ name: "b", from: "2222222", to: "3333333" }]);
  assert.equal(shortCommit("0123456789abcdef"), "0123456");
});

test("pushEvent appends and caps history", () => {
  const state = defaultState();
  pushEvent(state, "update", "x y");
  pushEvent(state, "update", "x y");
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].detail, "x y");
});

test("renderSyncSummary covers all outcome kinds", () => {
  assert.ok(renderSyncSummary({ updated: [{ name: "a", from: "1111111", to: "2222222" }], unchangedCount: 2, errors: [] }).includes("updated: a"));
  const none = renderSyncSummary({ updated: [], unchangedCount: 0, errors: ["boom"] });
  assert.ok(none.includes("boom"));
  assert.equal(renderSyncSummary({ updated: [], unchangedCount: 0, errors: [] }), "no changes");
});

// ---------------------------------------------------------------------------
// Install/update consent gate (P0). See DESIGN.md §5, §6 and §4.
// ---------------------------------------------------------------------------

test("installGate defaults to ask and survives state round-trips", () => {
  assert.deepEqual(INSTALL_GATE_MODES, ["ask", "deny", "off"]);
  assert.equal(defaultConfig().installGate, "ask");
  assert.equal(defaultState().config.installGate, "ask");
  // A state file written before 1.1 has no installGate key.
  assert.equal(validateState({ config: { enabled: false } }).config.installGate, "ask");
  assert.equal(validateState({ config: { installGate: "off" } }).config.installGate, "off");
  assert.equal(validateState({ config: { installGate: "deny" } }).config.installGate, "deny");
  // An unknown value falls back instead of throwing, like the thresholds do.
  assert.equal(validateState({ config: { installGate: "yes" } }).config.installGate, "ask");
  assert.equal(validateState({}).config.installGate, "ask");
});

test("only install and update are gated", () => {
  assert.deepEqual(GATED_ACTIONS, ["install", "update"]);
  for (const action of GATED_ACTIONS) assert.equal(isGatedAction(action), true);
  for (const action of ["status", "uninstall", "set-mode", "set-config", "refresh"]) {
    assert.equal(isGatedAction(action), false);
  }
  assert.equal(isGatedAction(undefined), false);
});

test("the ask line is one short line and states unverified hooks", () => {
  const install = renderGateAskLine({ action: "install", label: "owner/repo" });
  assert.equal(install.includes("\n"), false);
  assert.ok(install.length <= 200);
  assert.ok(install.includes("owner/repo"));
  // S2: say why hooks are unverified, never a bare "hooks unknown".
  assert.ok(install.includes("executable lifecycle hooks unverifiable before install"));
  assert.ok(install.includes("whole repo"));
  assert.ok(install.includes("source allowlisted"));
  assert.equal(install.includes("hooksCount"), false);

  const update = renderGateAskLine({ action: "update", label: "owner/repo", hooksSummary: "2 (measured)" });
  assert.equal(update.includes("\n"), false);
  assert.ok(update.includes("Update owner/repo"));
  assert.ok(update.includes("current hooks: 2 (measured)"));
  assert.ok(renderGateAskLine({ action: "update", label: "x" }).includes("current hooks: unknown"));
});

test("a long label cannot break the single-line card", () => {
  const line = renderGateAskLine({ action: "install", label: "o".repeat(500) });
  assert.equal(line.includes("\n"), false);
  assert.ok(line.length <= 200);
  assert.equal(truncateText("a\nb\tc", 40), "a b c");
  assert.equal(truncateText("abc", 3), "abc");
  assert.ok(truncateText("abcd", 3).endsWith("…"));
});

test("every denial code yields a model-facing reason and structured info", () => {
  const codes = [
    "user-rejected",
    "approval-cancelled",
    "approval-unavailable",
    "approval-error",
    "policy-deny",
    "no-agent",
  ];
  for (const code of codes) {
    const denial = renderGateDenial({ code, action: "install", label: "owner/repo" });
    assert.equal(denial.info.name, "SkillInstallBlocked");
    assert.equal(denial.info.code, code);
    assert.equal(denial.reason.startsWith("Error:"), false, "the registry adds the Error: prefix");
    assert.ok(denial.reason.includes("Degradation:"), `${code} must explain the degradation`);
    assert.ok(denial.reason.includes("owner/repo"));
    // Multi-line is safe here: this text reaches the model, not the card.
    assert.ok(denial.reason.length > 40);
  }
  // The Settings escape hatch must survive in the codes that need it.
  for (const code of ["policy-deny", "approval-unavailable", "approval-error"]) {
    assert.ok(renderGateDenial({ code, action: "install", label: "x" }).reason.includes("Settings → Skill Management"));
  }
  // `update` wording must not claim a fetch happened.
  const updateDenied = renderGateDenial({ code: "user-rejected", action: "update", label: "x" });
  assert.ok(updateDenied.reason.includes("no remote code was fetched"));
});

test("invalid-source reuses the install error verbatim", () => {
  const messages = ["install requires url", "unsupported git source (use owner/repo, https://, or git@)"];
  for (const message of messages) {
    const denial = renderGateDenial({ code: "invalid-source", action: "install", label: "x", reasonOverride: message });
    assert.equal(denial.reason, message);
    assert.equal(denial.info.code, "invalid-source");
  }
});

test("control characters never reach model-facing text", () => {
  // invalid-source labels come from unvalidated input, so strip C0 controls.
  assert.equal(truncateText("a\u0000b\u001Fc", 40), "abc");
  assert.equal(truncateText("a\r\nb", 40), "a b");
  assert.equal(truncateText("a\u0007b", 40), "ab");
});

test("the gate accepts exactly the sources the installer accepts", () => {
  // isGitSourceUrl is a pure wrapper over normalizeGitSourceUrl, so the equivalence
  // is definitional. This table pins the shared boundary instead: it fails if the
  // rule changes, or if the wrapper is ever re-implemented independently.
  const cases = [
    ["owner/repo", true],
    ["owner/repo.git", true],
    ["https://github.com/o/r.git", true],
    ["https://github.com/o/r", true],
    ["HTTPS://github.com/o/r", true],
    ["git@github.com:o/r.git", true],
    ["ssh://git@host/o/r.git", true],
    // The shared rule checks only the protocol prefix here. `git` rejects these
    // later, and the gate stays consistent with the installer either way.
    ["https://", true],
    ["https://github.com/o r.git", true],
    ["owner/repo/extra", false],
    ["owner", false],
    ["git@", false],
    ["-owner/repo", false],
    ["ftp://example.com/x", false],
    ["owner/repo\u0000", false],
    ["", false],
    ["o".repeat(2100), false],
  ];
  for (const [sample, expected] of cases) {
    assert.equal(isGitSourceUrl(sample), expected, `isGitSourceUrl(${JSON.stringify(sample)})`);
    assert.equal(normalizeGitSourceUrl(sample) !== null, expected, `normalizeGitSourceUrl(${JSON.stringify(sample)})`);
  }
});

// ---------------------------------------------------------------------------
// P1: candidate catalog. DESIGN.md §12.
// ---------------------------------------------------------------------------

test("candidate catalog drops unusable entries and enforces caps", () => {
  const catalog = (entries) => JSON.stringify({ version: 1, entries });
  const parsed = parseCandidateCatalog(catalog([
    { repo: "owner/repo", description: "Review diffs", triggers: ["review"] },
    { repo: "ftp://nope.example/x", description: "off allowlist" },
    { repo: "owner/empty", description: "" },
    { repo: "owner/long", description: "x".repeat(400) },
  ]));
  assert.equal(parsed.dropped, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].description.length, 300);
  assert.equal(parsed.entries[0].hooks.declared, false);

  const hooks = parseCandidateCatalog(catalog([
    { repo: "o/r", description: "d", hooks: { PreToolUse: true, SessionStart: false, Bogus: true } },
  ]));
  assert.deepEqual(hooks.entries[0].hooks.events, ["PreToolUse"]);

  assert.throws(() => parseCandidateCatalog("not json"), /not JSON/);
  assert.throws(() => parseCandidateCatalog(JSON.stringify({ version: 1, entries: "x" })), /entries array/);
  assert.throws(
    () => parseCandidateCatalog(catalog(Array.from({ length: 201 }, () => ({ repo: "o/r", description: "d" })))),
    /too many entries/,
  );
});

test("candidates rank with the installed-skill scorer", () => {
  const { entries } = parseCandidateCatalog(JSON.stringify({ version: 1, entries: [
    { repo: "o/review", description: "Code review for over-engineering", triggers: ["review"] },
    { repo: "o/other", description: "Unrelated gardening task" },
  ] }));
  const ranked = rankCandidates(entries, "please review this diff");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].repo, "o/review");
  assert.ok(ranked[0].score >= 7);
});

test("a candidate counts as installed only when every declared skill is", () => {
  const { entries } = parseCandidateCatalog(JSON.stringify({ version: 1, entries: [
    { repo: "o/multi", description: "d", skills: ["a", "b"] },
    { repo: "o/one", description: "d", name: "solo" },
    { repo: "o/none", description: "d" },
  ] }));
  const installed = new Set(["a", "solo"]);
  assert.equal(candidateIsInstalled(entries[0], installed), false);
  assert.equal(candidateIsInstalled(entries[1], installed), true);
  assert.equal(candidateIsInstalled(entries[2], installed), false);
});

test("proposal text is English and labels unverified facts", () => {
  const { entries } = parseCandidateCatalog(JSON.stringify({ version: 1, entries: [
    { repo: "o/review", description: "Code review", triggers: ["review"], skills: ["review"], hooks: { PreToolUse: true } },
  ] }));
  const [pick] = rankCandidates(entries, "review");
  const text = renderProposalText([pick], "review this diff");
  assert.ok(text.startsWith("<system-reminder>"));
  assert.ok(text.includes("o/review"));
  assert.ok(text.includes("Score "));
  assert.ok(text.includes("PreToolUse") && text.includes("(unverified)"));
  assert.ok(text.includes("Source: allowlisted only"));
  assert.ok(text.includes("I will not install on my own"));
  assert.ok(text.includes("Repository skills (catalog-declared, may be incomplete)"));
  assert.equal(text.includes("当前"), false);
  // V2 guard: reasons must be strings. An object array would render "[object Object]".
  assert.ok(text.includes("trigger:review"));
  assert.equal(text.includes("[object Object]"), false);
});

test("candidate catalog rejects an unknown version", () => {
  assert.throws(
    () => parseCandidateCatalog(JSON.stringify({ version: 2, entries: [] })),
    /unsupported candidate catalog version/,
  );
  assert.throws(
    () => parseCandidateCatalog(JSON.stringify({ entries: [] })),
    /unsupported candidate catalog version/,
  );
  assert.deepEqual(parseCandidateCatalog(JSON.stringify({ version: 1, entries: [] })).entries, []);
});

test("proposal text marks a curator-verified source", () => {
  const { entries } = parseCandidateCatalog(JSON.stringify({ version: 1, entries: [
    { repo: "o/review", description: "Code review", triggers: ["review"], verified: true },
  ] }));
  const [pick] = rankCandidates(entries, "review");
  assert.ok(renderProposalText([pick], "review").includes("Source: verified by curator"));
});

test("ranking an empty query or an unmatched catalog yields nothing", () => {
  const { entries } = parseCandidateCatalog(JSON.stringify({ version: 1, entries: [
    { repo: "o/review", description: "Code review", triggers: ["review"] },
  ] }));
  assert.deepEqual(rankCandidates(entries, ""), []);
  assert.deepEqual(rankCandidates([], "review"), []);
});
