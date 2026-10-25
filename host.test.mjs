import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "./index.js";

for (const lifecycleEvent of ["agent/created", "agent/session-start"]) {
  test(`${lifecycleEvent}: SessionStart skill activates before the first step`, async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-"));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const handlers = new Map();
    const warnings = [];
    const skill = {
      name: "startup-guide", description: "Startup guide", content: "Read this first.",
      provider: "filesystem", source: "user-dsh", invocation: { modelInvocable: true, userInvocable: true },
      metadata: { hooks: { SessionStart: { activate: true } } },
    };
    const agent = { session: { header: { cwd: home }, surface: { nodes: [] }, snapshotEvents: () => [] } };
    const prompt = { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] };
    try {
      apply({
        on(name, handler) { handlers.set(name, handler); },
        events: { dispatch() {} },
        logger: { warn(message) { warnings.push(message); } },
        skills: { snapshot: async () => ({ complete: true, skills: [skill] }), get: async () => skill },
        tools: { register() {} },
        inject() {},
      });
      await handlers.get(lifecycleEvent)({ agent, source: "startup" });
      const decision = await handlers.get("agent/pre-step")(
        { agent, messages: [prompt], turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages: [prompt] }),
      );
      assert.equal(decision.messages.length, 2, warnings.join("; "));
      assert.match(decision.messages[1].content[0].text, /Read this first/);
      assert.equal(decision.messages[1].source.kind, "plugin:dsh-skills-manager");
      assert.equal(decision.messages[1].source.plugin, undefined);
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    }
  });
}

for (const api of ["events", "snapshotEvents"]) {
  test(`${api}: activation survives resume and reinjects after compaction`, async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-"));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const handlers = new Map();
    const warnings = [];
    const skill = {
      name: "review-code", description: "Review code", content: "Check the code.",
      provider: "filesystem", source: "user-dsh",
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: {
        triggers: ["review"], activation: "auto",
        hooks: { PostToolUse: [{ tool: "bash", when: "review", action: "activate" }] },
      },
    };
    const events = [];
    const session = { header: { cwd: home }, surface: { nodes: [] } };
    if (api === "events") session.events = events;
    else session.snapshotEvents = function () {
      assert.equal(this, session);
      return Object.freeze([...events]);
    };
    const agent = { session };
    const signal = new AbortController().signal;
    const prompt = { source: { kind: "user" }, content: [{ type: "text", text: "review" }] };
    try {
      apply({
        on(name, handler) { handlers.set(name, handler); },
        events: { dispatch() {} },
        logger: { warn(message) { warnings.push(message); } },
        skills: { snapshot: async () => ({ complete: true, skills: [skill] }), get: async () => skill },
        tools: { register() {} },
        inject() {},
      });
      const step = () => handlers.get("agent/pre-step")(
        { agent, messages: [prompt], turn: 1, step: 1, signal },
        async () => ({ kind: "enter", messages: [prompt] }),
      );
      // A resumed session has a persisted activation but no manager memory.
      events.push({ type: "user/message", seq: 0, data: {
        source: {
          kind: "plugin",
          plugin: "dsh-skills-manager",
          form: "notice",
          summary: JSON.stringify({ form: "activation", name: skill.name }),
        },
      } });
      session.surface.nodes = [0];
      assert.equal((await step()).messages.length, 1);
      const post = () => handlers.get("tools/post-execute")(
        { agent, name: "bash", arguments: {}, signal },
        { content: [{ type: "text", text: "review" }] },
        async () => ({ kind: "accept" }),
      );
      assert.equal((await post()).additionalContexts, undefined);

      session.surface.nodes = [];
      const activated = await step();
      assert.equal(activated.messages.length, 2);
      assert.deepEqual(
        { kind: activated.messages[1].source.kind, form: activated.messages[1].source.form },
        { kind: "plugin:dsh-skills-manager", form: "notice" },
      );
      assert.equal(JSON.parse(activated.messages[1].source.summary).name, skill.name);
      events.push({ type: "user/message", seq: 1, data: activated.messages[1] });
      session.surface.nodes = [1];
      assert.equal((await step()).messages.length, 1);

      // Reading the committed marker clears the pending in-memory activation.
      session.surface.nodes = [];
      const context = (await post()).additionalContexts;
      assert.equal(context.length, 1);
      assert.equal(context[0].source.kind, "plugin:dsh-skills-manager");
      assert.deepEqual(warnings, []);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  });
}

test("a fresh DSH home returns a valid Settings view", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let route;

  try {
    apply({
      on() {},
      events: { dispatch() {} },
      logger: { warn() {} },
      skills: {
        snapshot: async () => ({ complete: true, skills: [] }),
        get: async () => undefined,
      },
      tools: { register() {} },
      inject(seats, setup) {
        assert.deepEqual(seats, ["connection", "agentPresets"]);
        setup({
          agentPresets: { standingKeyFor: async () => undefined },
          connection: {
            fetch: {
              register(value) {
                route = value;
                return () => {};
              },
            },
          },
          effect: (start) => start(),
        });
      },
    });

    assert.equal(route.path, "/api/skill-manager");
    assert.deepEqual(route.methods, ["POST"]);
    assert.equal((await route.fetch(new Request("http://localhost/api/skill-manager", { method: "POST" }))).status, 415);
    const response = await route.fetch(new Request("http://localhost/api/skill-manager", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "list", payload: {} }),
    }));
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(Array.isArray(result.value.events), true);
    assert.equal(result.value.events[0]?.kind, "state");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Install/update consent gate (P0). DESIGN.md §6 is the matrix under test.
// ---------------------------------------------------------------------------

/**
 * Run one gated call against a fake host and report what the host observed.
 * @param options - config, approval service, skill definitions, sources, action.
 * @returns `{ decision, warnings, requests }`.
 */
async function runGate({
  config = {},
  approval,
  skillDefinitions = {},
  sources = [],
  action = "install",
  args = { url: "owner/repo" },
  callId = "call-1",
  agent: agentOption,
  next,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-gate-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const listeners = [];
  const warnings = [];
  const requests = [];
  const service = approval === undefined ? undefined : {
    async request(request) {
      requests.push(request);
      return approval(request);
    },
  };
  try {
    await writeFile(
      join(home, "skill-manager.json"),
      JSON.stringify({ version: 1, config, skillSources: sources, skills: {} }),
      "utf8",
    );
    apply({
      on(name, handler) { listeners.push([name, handler]); },
      events: { dispatch() {} },
      logger: { warn(message) { warnings.push(message); } },
      skills: {
        snapshot: async () => ({ complete: true, skills: [] }),
        get: async (skillName) => skillDefinitions[skillName],
      },
      tools: { register() {} },
      inject() {},
      get(serviceName) { return serviceName === "approval" ? service : undefined; },
    });
    // `agent: null` models a call with no agent, which the gate must deny.
    const defaultAgent = { session: { header: { cwd: home }, surface: { nodes: [] } } };
    const agent = agentOption === null ? undefined : (agentOption ?? defaultAgent);
    const exec = {
      name: "skill_manager",
      arguments: { action, ...args },
      agent,
      signal: new AbortController().signal,
      callId,
    };
    // The plugin registers two `tools/pre-execute` listeners. The host runs them
    // as a waterfall in registration order, so compose them the same way.
    const decision = await runWaterfall(listeners, exec, next ?? { kind: "allow" });
    return { decision, warnings, requests };
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
}

/**
 * Compose the `tools/pre-execute` listeners in registration order, like the
 * host waterfall: the first listener is outermost and calls the next one.
 * @param listeners - collected `[event, handler]` pairs.
 * @param exec - the tool execution under test.
 * @param fallback - the decision the host uses when no listener decides.
 * @returns the final decision.
 */
async function runWaterfall(listeners, exec, fallback) {
  const chain = listeners
    .filter(([eventName]) => eventName === "tools/pre-execute")
    .map(([, handler]) => handler);
  let index = 0;
  const invoke = async () => {
    const handler = chain[index];
    index += 1;
    if (handler === undefined) return fallback;
    return handler(exec, invoke);
  };
  return invoke();
}

test("gate: allowed-once installs and shows exactly one card", async () => {
  const { decision, requests } = await runGate({ approval: async () => "allowed-once" });
  assert.equal(decision.kind, "allow");
  // One card per call. Returning `allow` (not `ask`) stops the host's own ask.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, "skill_manager");
  assert.equal(requests[0].reason.includes("\n"), false);
  assert.ok(requests[0].reason.includes("owner/repo"));
  assert.ok(requests[0].reason.includes("executable lifecycle hooks unverifiable before install"));
});

test("gate: a rejected install denies with degradation text", async () => {
  const { decision } = await runGate({ approval: async () => "rejected" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "user-rejected");
  assert.ok(decision.reason.includes("Degradation:"));
  assert.ok(decision.reason.includes("owner/repo"));
});

test("gate: a cancelled approval denies", async () => {
  const { decision } = await runGate({ approval: async () => "cancelled" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "approval-cancelled");
});

test("gate: an unexpected outcome fails closed", async () => {
  const { decision } = await runGate({ approval: async () => "maybe" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "approval-unavailable");
});

test("gate: a missing approval service fails closed", async () => {
  const { decision } = await runGate({ approval: undefined });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "approval-unavailable");
  assert.ok(decision.reason.includes("failed closed"));
});

test("gate: a throwing approval request fails closed", async () => {
  const { decision, warnings } = await runGate({ approval: async () => { throw new Error("boom"); } });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "approval-error");
  assert.ok(warnings.some((line) => line.includes("approval request failed")));
});

test("gate: installGate deny blocks without asking", async () => {
  const { decision, requests } = await runGate({ config: { installGate: "deny" }, approval: async () => "allowed-once" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "policy-deny");
  assert.equal(requests.length, 0);
  assert.ok(decision.reason.includes("Settings → Skill Management"));
});

test("gate: installGate off restores the old behavior", async () => {
  const { decision, requests } = await runGate({ config: { installGate: "off" }, approval: async () => "rejected" });
  assert.equal(decision.kind, "allow");
  assert.equal(requests.length, 0);
});

test("gate: update is gated too and reports measured hooks", async () => {
  const sources = [{
    id: "gh:https://github.com/owner/repo.git",
    url: "https://github.com/owner/repo.git",
    ref: "main",
    skills: [{ name: "review-skill", relPath: "." }],
  }];
  const skillDefinitions = {
    "review-skill": {
      name: "review-skill",
      // Shapes accepted by normalizeHooks: PreToolUse needs `decision`, PostToolUse needs `action: activate`.
      metadata: {
        hooks: {
          PreToolUse: [{ tool: "bash", decision: "deny" }],
          PostToolUse: [{ tool: "bash", action: "activate" }],
        },
      },
    },
  };
  const { decision, requests } = await runGate({
    action: "update",
    args: {},
    sources,
    skillDefinitions,
    approval: async () => "rejected",
  });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "user-rejected");
  assert.ok(decision.reason.includes("no remote code was fetched"));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].reason.includes("Update https://github.com/owner/repo.git"));
  // S7: a readable catalog reports the measured count, not "unknown".
  assert.ok(requests[0].reason.includes("current hooks: 2 (measured)"));

  // S7: an unreadable definition must degrade to unknown, not to a guessed number.
  const unreadable = await runGate({
    action: "update",
    args: {},
    sources,
    skillDefinitions: {},
    approval: async () => "rejected",
  });
  assert.ok(unreadable.requests[0].reason.includes("current hooks: unknown"));
});

test("gate: update with no source is not worth a card", async () => {
  const { decision, requests } = await runGate({ action: "update", args: {}, approval: async () => "rejected" });
  assert.equal(decision.kind, "allow");
  assert.equal(requests.length, 0);
});

test("gate: an unsupported url denies with the install error verbatim", async () => {
  const { decision, requests } = await runGate({ args: { url: "ftp://example.com/x" }, approval: async () => "allowed-once" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "invalid-source");
  assert.equal(decision.reason, "unsupported git source (use owner/repo, https://, or git@)");
  assert.equal(requests.length, 0);
});

test("gate: a missing url denies with the install error verbatim", async () => {
  const { decision } = await runGate({ args: {}, approval: async () => "allowed-once" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reason, "install requires url");
});

test("gate: an upstream ask wins and is reported", async () => {
  const upstream = { kind: "ask", reason: "another policy" };
  const { decision, warnings } = await runGate({
    approval: async () => "allowed-once",
    next: upstream,
  });
  assert.equal(decision, upstream);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("intercepted by an earlier ask"));
});

test("gate: unrelated tools and actions are untouched", async () => {
  const requests = [];
  const service = { async request(request) { requests.push(request); return "rejected"; } };
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-gate-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const listeners = [];
  try {
    apply({
      on(name, handler) { listeners.push([name, handler]); },
      events: { dispatch() {} },
      logger: { warn() {} },
      skills: { snapshot: async () => ({ complete: true, skills: [] }), get: async () => undefined },
      tools: { register() {} },
      inject() {},
      get() { return service; },
    });
    const agent = { session: { header: { cwd: home }, surface: { nodes: [] } } };
    const allow = { kind: "allow" };
    const bash = { name: "bash", arguments: {}, agent, signal: new AbortController().signal };
    const status = { name: "skill_manager", arguments: { action: "status" }, agent, signal: new AbortController().signal };
    assert.equal((await runWaterfall(listeners, bash, allow)).kind, "allow");
    assert.equal((await runWaterfall(listeners, status, allow)).kind, "allow");
    assert.equal(requests.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

test("gate: a call without an agent fails closed", async () => {
  // DESIGN.md §6 #7. This branch depends on no host service, so it is easy to break.
  const { decision, requests } = await runGate({ agent: null, approval: async () => "allowed-once" });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "no-agent");
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// P1: capability-gap proposals. DESIGN.md §12.
// ---------------------------------------------------------------------------

/** Open one fake host whose proposal branch can be stepped repeatedly. */
async function setupPropose({ config = {}, catalog, catalogFile = "skill-manager-candidates.json", complete = true, skills = [], defs = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-manager-propose-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const listeners = [];
  const warnings = [];
  const catalogPath = join(home, catalogFile);
  await writeFile(
    join(home, "skill-manager.json"),
    JSON.stringify({
      version: 1,
      config: {
        proposeEnabled: true,
        ...(catalogFile === "skill-manager-candidates.json" ? {} : { candidateCatalogPath: catalogPath }),
        ...config,
      },
      skillSources: [],
      skills: {},
    }),
    "utf8",
  );
  if (catalog !== undefined) {
    await writeFile(catalogPath, typeof catalog === "string" ? catalog : JSON.stringify(catalog), "utf8");
  }
  apply({
    on(name, handler) { listeners.push([name, handler]); },
    events: { dispatch() {} },
    logger: { warn(message) { warnings.push(message); } },
    skills: { snapshot: async () => ({ complete, skills }), get: async (name) => defs[name] },
    tools: { register() {} },
    inject() {},
    get() { return undefined; },
  });
  const agent = { session: { header: { cwd: home }, surface: { nodes: [] }, snapshotEvents: () => [] } };
  const handler = listeners.find(([name]) => name === "agent/pre-step")[1];
  const prompt = { source: { kind: "user" }, content: [{ type: "text", text: "please review this diff" }] };
  return {
    warnings,
    catalogPath,
    step: (turn = 1, stepNumber = 1) => handler(
      { agent, messages: [prompt], turn, step: stepNumber, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [prompt] }),
    ),
    async close() {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    },
  };
}

/** Proposal payloads carried by one pre-step decision, with their rendered text. */
function proposalsIn(decision) {
  return decision.messages
    .filter((message) => message.source?.kind === "plugin:dsh-skills-manager")
    .map((message) => ({ ...JSON.parse(message.source.summary), text: message.content?.[0]?.text ?? "" }))
    .filter((payload) => payload.form === "proposal");
}

const REVIEW_CATALOG = { version: 1, entries: [
  { repo: "owner/review-a", description: "Code review for over-engineering", triggers: ["review"] },
  { repo: "owner/review-b", description: "Review diffs quickly", triggers: ["review"] },
  { repo: "owner/review-c", description: "Review pull requests", triggers: ["review"] },
] };

test("propose: off by default reads no catalog", async () => {
  const host = await setupPropose({ config: { proposeEnabled: false }, catalog: "not json" });
  try {
    const decision = await host.step();
    assert.equal(proposalsIn(decision).length, 0);
    // A read would have logged the broken catalog; silence proves no load.
    assert.deepEqual(host.warnings, []);
  } finally {
    await host.close();
  }
});

test("propose: a broken catalog warns once per mtime", async () => {
  const host = await setupPropose({ catalog: "not json" });
  try {
    await host.step(1, 1);
    await host.step(1, 2);
    assert.equal(host.warnings.filter((line) => line.includes("candidate catalog unusable")).length, 1);
  } finally {
    await host.close();
  }
});

test("propose: a missing catalog warns once", async () => {
  // No file at all: same error branch as a malformed file, but a different cause.
  const host = await setupPropose({});
  try {
    await host.step(1, 1);
    await host.step(1, 2);
    assert.equal(host.warnings.filter((line) => line.includes("candidate catalog unusable")).length, 1);
  } finally {
    await host.close();
  }
});

test("propose: one per turn, capped by maxPropose", async () => {
  const host = await setupPropose({ catalog: REVIEW_CATALOG, config: { maxPropose: 1, proposeThreshold: 7 } });
  try {
    const first = proposalsIn(await host.step(1, 1));
    assert.equal(first.length, 1);
    assert.equal(first[0].repos.length, 1);
    // V1/V2 guard: trigger reasoning reaches the model as text, not as "[object Object]".
    assert.ok(first[0].text.includes("trigger:review"));
    assert.equal(first[0].text.includes("[object Object]"), false);
    // Same turn, later step: no second proposal.
    assert.equal(proposalsIn(await host.step(1, 2)).length, 0);
    // A new turn may propose again.
    assert.equal(proposalsIn(await host.step(2, 1)).length, 1);
  } finally {
    await host.close();
  }
});

test("propose: installed candidates are skipped", async () => {
  const catalog = { version: 1, entries: [
    { repo: "owner/review-a", description: "Code review for over-engineering", triggers: ["review"], skills: ["review-a"] },
  ] };
  const host = await setupPropose({ catalog, skills: [{ name: "review-a", description: "installed" }] });
  try {
    assert.equal(proposalsIn(await host.step()).length, 0);
  } finally {
    await host.close();
  }
});

test("propose: an incomplete catalog never proposes", async () => {
  const host = await setupPropose({ complete: false, catalog: "not json" });
  try {
    assert.equal(proposalsIn(await host.step()).length, 0);
    // The existing early return runs before the proposal branch reads the file.
    assert.deepEqual(host.warnings, []);
  } finally {
    await host.close();
  }
});

test("propose: weak evidence stays silent", async () => {
  const catalog = { version: 1, entries: [{ repo: "owner/garden", description: "Gardening helper" }] };
  const host = await setupPropose({ catalog });
  try {
    assert.equal(proposalsIn(await host.step()).length, 0);
    assert.deepEqual(host.warnings, []);
  } finally {
    await host.close();
  }
});

test("propose: maxPropose caps a multi-candidate pick", async () => {
  const host = await setupPropose({ catalog: REVIEW_CATALOG, config: { maxPropose: 3, proposeThreshold: 7 } });
  try {
    const [proposal] = proposalsIn(await host.step());
    assert.equal(proposal.repos.length, 3);
  } finally {
    await host.close();
  }
});

test("propose: a changed mtime warns again", async () => {
  const host = await setupPropose({ catalog: "not json" });
  try {
    await host.step(1, 1);
    const later = new Date(Date.now() + 5000);
    await utimes(host.catalogPath, later, later);
    await host.step(1, 2);
    assert.equal(host.warnings.filter((line) => line.includes("candidate catalog unusable")).length, 2);
  } finally {
    await host.close();
  }
});

test("propose: candidateCatalogPath overrides the default location", async () => {
  const host = await setupPropose({ catalogFile: "custom-candidates.json", catalog: REVIEW_CATALOG });
  try {
    const proposals = proposalsIn(await host.step());
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].repos.length, 1);
  } finally {
    await host.close();
  }
});

test("propose: dropped entries are reported once", async () => {
  const catalog = { version: 1, entries: [
    { repo: "owner/review-a", description: "Code review", triggers: ["review"] },
    { repo: "ftp://nope.example/x", description: "off allowlist" },
  ] };
  const host = await setupPropose({ catalog });
  try {
    const proposals = proposalsIn(await host.step());
    assert.equal(proposals.length, 1);
    assert.equal(host.warnings.filter((line) => line.includes("dropped 1 invalid entries")).length, 1);
    await host.step(1, 2);
    assert.equal(host.warnings.filter((line) => line.includes("dropped 1 invalid entries")).length, 1);
  } finally {
    await host.close();
  }
});
