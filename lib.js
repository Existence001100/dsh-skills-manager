/**
 * dsh-skills-manager — pure logic.
 *
 * Everything here is side-effect free so it can be unit tested without a
 * harness: trigger matching and skill scoring, activation-mode resolution,
 * repository skill discovery, and the manager state manifest (parse,
 * validate, serialize, change detection).
 *
 * @module dsh-skills-manager/lib
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Public activation modes a skill may resolve to. */
export const ACTIVATION_MODES = ["auto", "suggest", "off"];
/** Preferred order for the settings UI. */
export const ACTIVATION_MODES_ZH = { auto: "自动加载", suggest: "建议加载", off: "关闭" };
/**
 * Codex-style skill mode aliases (Codex skills declare `auto | manual |
 * disabled`): `manual` (only explicit invocation) and `disabled` both behave
 * as `off` in this manager — the skill stays callable by name but never
 * participates proactively.
 */
export const ACTIVATION_MODE_ALIASES = { manual: "off", disabled: "off" };

/**
 * Install/update gate modes. `ask` shows one approval card, `deny` blocks the
 * call outright, and `off` restores the pre-1.1 behavior of installing without
 * a user decision. See DESIGN.md §5.
 */
export const INSTALL_GATE_MODES = ["ask", "deny", "off"];

/**
 * `skill_manager` actions that pull remote code and can add executable hooks.
 * `install` and `update` share one gate because the supply-chain path is
 * "install something harmless, then update it into something hostile".
 */
export const GATED_ACTIONS = ["install", "update"];

/** Longest single-line approval text the plugin emits (the card flattens newlines). */
const GATE_CARD_MAX_CHARS = 200;

/** Default manager configuration. */
export function defaultConfig() {
  return {
    enabled: true,
    installGate: "ask",
    maxAuto: 2,
    maxSuggest: 3,
    autoThreshold: 7,
    suggestThreshold: 4,
    proposeEnabled: false,
    proposeThreshold: 7,
    maxPropose: 1,
    candidateCatalogPath: "",
  };
}

/** Fresh empty manager state. */
export function defaultState() {
  return {
    version: 1,
    config: defaultConfig(),
    skillSources: [],
    skills: {},
    events: [],
  };
}

const STATE_VERSION = 1;
const MAX_EVENTS = 50;

/**
 * Resolve a skill's activation mode: user override > skill metadata
 * declaration > derived default (triggers present → auto, else suggest).
 * @param metadata - the skill's invocation-neutral `metadata` object, if any.
 * @param override - optional user-side mode override for this skill.
 * @returns one of ACTIVATION_MODES.
 */
export function resolveActivationMode(metadata, override) {
  if (ACTIVATION_MODES.includes(override)) return override;
  const declared = metadata && typeof metadata === "object" ? metadata.activation : undefined;
  if (ACTIVATION_MODES.includes(declared)) return declared;
  if (typeof declared === "string" && ACTIVATION_MODE_ALIASES[declared]) return ACTIVATION_MODE_ALIASES[declared];
  const triggers = triggerListOf(metadata);
  return triggers.length > 0 ? "auto" : "suggest";
}

/**
 * Normalized trigger list from metadata. Strings only; regex entries may be
 * written as `re:<pattern>`, everything else is a case-insensitive substring.
 * @returns parsed trigger objects `{ raw, kind, re? }`.
 */
export function parseTriggers(metadata) {
  const parsed = [];
  for (const raw of triggerListOf(metadata)) {
    const trigger = parseTriggerEntry(raw);
    if (trigger !== undefined) parsed.push(trigger);
  }
  return parsed;
}

/** Parse one trigger entry; returns `undefined` for unusable patterns. */
function parseTriggerEntry(entry) {
  if (!entry.startsWith("re:")) {
    return { raw: entry, kind: "sub", text: entry.toLocaleLowerCase() };
  }
  const source = entry.slice(3);
  try {
    return { raw: entry, kind: "re", re: new RegExp(source, "iu") };
  } catch {
    // Unusable regex triggers are ignored, not fatal.
    return undefined;
  }
}

/**
 * Merge declared metadata triggers with user-side triggers (deduped, strings
 * only). User triggers make third-party skills triggerable without editing
 * the skill itself.
 * @param metadata - skill metadata carrying `triggers`.
 * @param extra - user-side trigger strings from manager state.
 * @returns unique trigger strings.
 */
export function mergeTriggers(metadata, extra) {
  const out = [];
  const seen = new Set();
  for (const entry of [...triggerListOf(metadata), ...(Array.isArray(extra) ? extra : [])]) {
    if (typeof entry !== "string" || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * The string array a skill declared in `metadata.triggers`, or an empty list.
 * Non-array values degrade to empty instead of throwing.
 */
export function triggerListOf(metadata) {
  const value = metadata && typeof metadata === "object" ? metadata.triggers : undefined;
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * Split query text into matching atoms: latin word tokens and CJK bigrams.
 * @param text - raw text.
 * @returns unique normalized atoms.
 */
export function tokenize(text) {
  const out = new Set();
  for (const word of String(text).toLocaleLowerCase().matchAll(/[a-z0-9]+/g)) out.add(word[0]);
  const cjk = String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) out.add(run);
    for (let index = 0; index < run.length - 1; index += 1) out.add(run.slice(index, index + 2));
  }
  return out;
}

/** Word-boundary containment of a kebab name inside query text. */
function nameAppears(query, name) {
  return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(name)}(?=$|[^a-z0-9-])`, "i").test(query);
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchTrigger(trigger, query) {
  if (trigger.kind === "re") return trigger.re.test(query);
  return query.includes(trigger.text);
}

/**
 * Score one skill against the query text.
 * @param skill - view `{ name, description, whenToUse?, triggers?, metadata? }`.
 * @param query - normalized (lowercased) user text.
 * @param extraTriggers - optional user-side trigger strings merged with the
 *   skill's declared metadata triggers.
 * @returns `{ score, reasons }`: reason strings describe what matched.
 */
export function scoreSkill(skill, query, extraTriggers = []) {
  const reasons = [];
  let best = 0;
  if (nameAppears(query, skill.name)) {
    best = 12;
    reasons.push("name");
  }
  const merged = mergeTriggers(skill.metadata, extraTriggers);
  for (const entry of merged) {
    const trigger = parseTriggerEntry(entry);
    if (trigger !== undefined && matchTrigger(trigger, query)) {
      best = Math.max(best, 7);
      reasons.push(`trigger:${trigger.raw}`);
    }
  }
  const haystack = [skill.name, skill.description, skill.whenToUse ?? ""].join(" ").toLocaleLowerCase();
  const overlap = overlapRatio(tokenize(haystack), tokenize(query));
  if (overlap >= 0.5) {
    best = Math.max(best, 6);
    reasons.push("description");
  } else if (overlap >= 0.25) {
    best = Math.max(best, 4);
    reasons.push("description");
  }
  if (reasons.length > 1) best += 1;
  return { score: best, reasons };
}

/** Jaccard-style overlap of two token sets. */
export function overlapRatio(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  return shared / smaller.size;
}

/**
 * Record scope: overrides are keyed by skill name in state, so they must be
 * scoped to the root that owns the skill — a project skill never inherits the
 * user-level record of the same name (project roots outrank user roots).
 * @param record - a state skills entry (`undefined` allowed).
 * @param source - the summary's `source` bucket (`project-dsh`, `project-agents`,
 *   `custom`, `user-dsh`, `user-agents`, `bundled`).
 * @param cwd - lookup cwd used for project-scoped records.
 * @returns whether the record applies to this skill occurrence.
 */
export function recordMatches(record, source, cwd) {
  if (record === undefined) return false;
  const project = record.scope === "project";
  if (project) {
    return (source === "project-dsh" || source === "project-agents") && record.cwd === cwd;
  }
  return source !== "project-dsh" && source !== "project-agents";
}

/** Effective scope label of a record ("user" unless declared project). */
export function scopeOfRecord(record) {
  return record && record.scope === "project" ? "project" : "user";
}

/**
 * Rank model-invocable skills against query text.
 * @param skills - skill summaries (registry `list()` output) plus metadata.
 * @param query - raw user text.
 * @param state - manager state used for user overrides.
 * @param cwd - lookup cwd; project-scoped overrides match only in their own workspace.
 * @returns ranked entries `{ skill, mode, score, reasons }`, descending score.
 */
export function rankSkills(skills, query, state, cwd) {
  const normalized = String(query).toLocaleLowerCase();
  const ranked = [];
  for (const skill of skills) {
    if (skill.invocation && skill.invocation.modelInvocable === false) continue;
    const record = state && state.skills
      ? (recordMatches(state.skills[skill.name], skill.source, cwd) ? state.skills[skill.name] : undefined)
      : undefined;
    const { score, reasons } = scoreSkill(skill, normalized, record && record.triggers);
    if (score <= 0) continue;
    ranked.push({
      skill,
      mode: resolveActivationMode(skill.metadata, record ? record.mode : undefined),
      score,
      reasons,
    });
  }
  ranked.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  return ranked;
}

/**
 * Split ranked skills into auto-loads and suggestions per manager config.
 * Only skills whose mode is `auto` may be auto-loaded; `suggest` mode skills
 * and unmatched `auto` skills become suggestions.
 * @param ranked - output of {@link rankSkills}.
 * @param config - manager config (`maxAuto`, `maxSuggest`, thresholds).
 * @returns `{ auto: [], suggest: [] }` of ranked entries.
 */
export function selectActivations(ranked, config) {
  const auto = [];
  const suggest = [];
  for (const entry of ranked) {
    if (entry.mode === "off") continue;
    if (entry.mode === "auto" && entry.score >= config.autoThreshold && auto.length < config.maxAuto) {
      auto.push(entry);
      continue;
    }
    if (entry.score >= config.suggestThreshold && suggest.length < config.maxSuggest) suggest.push(entry);
  }
  return { auto, suggest };
}

/**
 * Scan one session's events plus the visible surface nodes for a skill's
 * latest activation marker.
 * @param events - session event snapshot.
 * @param surfaceNodes - `agent.session.surface.nodes` (seq array or legacy set).
 * @param name - skill name.
 * @returns `{ active: boolean, turn?: number }` — active while its marker
 *   remains in the visible surface.
 */
export function activationStateOf(events, surfaceNodes, name) {
  const visible = new Set(surfaceNodes ?? []);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "user/message") continue;
    const source = managerSourceData(event.data && event.data.source);
    if (!source || source.form !== "activation") continue;
    if (source.name !== name) continue;
    return { active: visible.has(event.seq), turn: typeof source.turn === "number" ? source.turn : undefined };
  }
  return { active: false };
}

function managerSourceData(source) {
  if (!source) return null;
  if (source.kind === "skill-manager") return source;
  if (source.kind !== "plugin:dsh-skills-manager" && !(source.kind === "plugin" && source.plugin === "dsh-skills-manager")) return null;
  if (source.form !== "notice" || typeof source.summary !== "string") return {};
  try {
    const data = JSON.parse(source.summary);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Whether any message in the claimed batch was injected by this manager. */
export function batchHasInjection(messages) {
  return messages.some((message) => managerSourceData(message.source) !== null);
}

/** Render the activation reminder shell around canonical skill content. */
export function renderActivationReminder(entries) {
  const lines = entries.map((entry) => `- \`${entry.skill.name}\`: ${entry.reasons.join(", ") || "matched task"}`);
  return [
    "<system-reminder>",
    "The following skills were automatically activated for this task. Follow their instructions; do not call the `skill` tool for them again:",
    ...lines,
    "</system-reminder>",
  ].join("\n");
}

/** Render a lightweight suggestion notice for the model. */
export function renderSuggestionNotice(entries) {
  const lines = entries.map((entry) => `- \`${entry.skill.name}\`: ${entry.skill.description} (${entry.reasons.join(", ") || "matched task"})`);
  return [
    "<system-reminder>",
    "Skills matching this task. If applicable, call the `skill` tool with the exact name to load the full instructions before acting:",
    ...lines,
    "</system-reminder>",
  ].join("\n");
}

/**
 * Parse the YAML frontmatter of a SKILL.md text body with a tiny regex —
 * only enough to read `name` (and `description`) without a yaml dependency.
 * @param raw - SKILL.md content.
 * @returns `{ name?, description? }` (raw strings) or `null` when absent.
 */
export function parseFrontmatterSlim(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(raw));
  if (!match) return null;
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const field = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    if (field[1] !== "name" && field[1] !== "description") continue;
    const value = field[2].trim();
    if (!/^[>|][+-]?$/.test(value)) out[field[1]] = value;
    else {
      const block = [];
      while (/^\s+/.test(lines[i + 1] ?? "")) block.push(lines[i += 1].trim());
      out[field[1]] = value[0] === ">" ? block.join(" ") : block.join("\n");
    }
  }
  return out;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"]);
const DEFAULT_MAX_DEPTH = 3;

/**
 * Find every skill directory (a directory containing `SKILL.md`) inside a
 * cloned repository, at or below the given depth. The clone root itself may
 * hold a `SKILL.md`.
 * @param rootDir - absolute clone path.
 * @param depth - max traversal depth (default 3).
 * @returns `{ root, relPath, name?, description? }[]` — name/description come
 *   from slim frontmatter parsing when present.
 */
export async function findSkillDirs(rootDir, depth = DEFAULT_MAX_DEPTH) {
  const found = [];
  const walk = async (dir, level) => {
    if (level > depth) return;
    if (await hasSkillFile(dir)) {
      found.push(await describeSkillDir(rootDir, dir, level));
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), level + 1);
    }
  };
  await walk(rootDir, 0);
  // ponytail: prefer the shared skills/ source over generated platform copies;
  // parse marketplace manifests only if a real repository needs another root.
  found.sort((a, b) => Number(!a.relPath.startsWith("skills/")) - Number(!b.relPath.startsWith("skills/")) || a.relPath.localeCompare(b.relPath));
  const names = new Set();
  return found.filter((item) => {
    if (!item.name || names.has(item.name)) return !item.name;
    names.add(item.name);
    return true;
  });
}

const PLUGIN_MANIFESTS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"];
const RUNNABLE_PLUGIN_HOOKS = new Set(["SessionStart", "UserPromptSubmit"]);

function safeRepoPath(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return clean
    && !clean.startsWith("/")
    && clean.split("/").every((part) => part && part !== "." && part !== "..")
    ? clean
    : null;
}

/** Safe subset used by both reference plugins: `node ${PLUGIN_ROOT}/path.js`. */
export function parsePluginHookCommand(command) {
  if (typeof command !== "string") return null;
  const text = command.trim();
  const match = /^node\s+"\$\{(?:CLAUDE_|CODEX_)?PLUGIN_ROOT\}\/([^"\r\n]+)"$/.exec(text)
    ?? /^node\s+\$\{(?:CLAUDE_|CODEX_)?PLUGIN_ROOT\}\/([^\s]+)$/.exec(text);
  return safeRepoPath(match?.[1]);
}

/** Normalize Claude/Codex command hook JSON without enabling a shell. */
export function normalizePluginHookManifest(input) {
  const hooks = [];
  const unsupportedHooks = new Set();
  const groups = input && typeof input === "object" ? input.hooks : undefined;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) return { hooks, unsupportedHooks: [] };
  for (const [event, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries)) continue;
    for (const group of entries) {
      if (!group || !Array.isArray(group.hooks)) continue;
      if (event === "SessionStart" && typeof group.matcher === "string") {
        try {
          if (!new RegExp(group.matcher).test("startup")) continue;
        } catch {
          continue;
        }
      }
      for (const hook of group.hooks) {
        if (!hook || hook.type !== "command") continue;
        const script = parsePluginHookCommand(hook.command);
        if (!script) {
          unsupportedHooks.add(event);
          continue;
        }
        if (!RUNNABLE_PLUGIN_HOOKS.has(event)) {
          unsupportedHooks.add(event);
          continue;
        }
        hooks.push({
          event,
          script,
          timeoutMs: Math.min(30, Math.max(1, Number(hook.timeout) || 5)) * 1000,
        });
      }
    }
  }
  return { hooks, unsupportedHooks: [...unsupportedHooks] };
}

/** Read Codex first, then Claude, plugin metadata from a cloned repository. */
export async function readPluginPackage(rootDir) {
  for (const manifest of PLUGIN_MANIFESTS) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(rootDir, manifest), "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw new Error(`invalid plugin manifest ${manifest}`);
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !parsed.name.trim()) continue;
    const hooksFile = parsed.hooks === undefined ? null : safeRepoPath(parsed.hooks);
    if (parsed.hooks !== undefined && !hooksFile) throw new Error(`invalid plugin hooks path in ${manifest}`);
    const normalized = hooksFile
      ? normalizePluginHookManifest(JSON.parse(await readFile(join(rootDir, hooksFile), "utf8")))
      : { hooks: [], unsupportedHooks: [] };
    return {
      name: parsed.name.trim().slice(0, 128),
      version: typeof parsed.version === "string" ? parsed.version.slice(0, 64) : "",
      description: typeof parsed.description === "string" ? parsed.description.slice(0, 500) : "",
      manifest,
      hooksFile,
      ...normalized,
    };
  }
  return null;
}

async function hasSkillFile(dir) {
  try {
    const info = await stat(join(dir, "SKILL.md"));
    return info.isFile();
  } catch {
    return false;
  }
}

async function describeSkillDir(rootDir, dir, level) {
  let name;
  let description;
  try {
    const raw = await readFile(join(dir, "SKILL.md"), "utf8");
    const parsed = parseFrontmatterSlim(raw);
    name = parsed && parsed.name;
    description = parsed && parsed.description;
  } catch {
    // Unreadable skill file still yields a directory candidate; the registry
    // will reject it at catalog time and the installer reports the failure.
  }
  return {
    root: rootDir,
    relPath: level === 0 ? "." : relative(rootDir, dir).split(sep).join("/"),
    name,
    description,
    level,
  };
}

/** Short 7-char commit display. */
export function shortCommit(commit) {
  return typeof commit === "string" && /^[0-9a-f]{7,}$/i.test(commit) ? commit.slice(0, 7) : commit ?? "";
}

/**
 * Normalize a deployable git source. Claude/Codex marketplace shorthand is
 * resolved to GitHub; explicit https/ssh URLs pass through unchanged.
 * @param url - candidate URL or `owner/repo` shorthand.
 * @returns canonical clone URL, or `null` when unsupported.
 */
export function normalizeGitSourceUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048 || url.startsWith("-")) return null;
  const shorthand = /^([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9_.-]+)$/i.exec(url);
  if (shorthand) {
    const repo = shorthand[2].replace(/\.git$/i, "");
    if (repo) return `https://github.com/${shorthand[1]}/${repo}.git`;
  }
  return (
    /^https?:\/\//i.test(url)
    || /^git@[a-z0-9.-]+:/i.test(url)
    || /^ssh:\/\//i.test(url)
  ) ? url : null;
}

/** Whether a source can be passed safely to git clone. */
export function isGitSourceUrl(url) {
  return normalizeGitSourceUrl(url) !== null;
}

/**
 * Parse and sanity-check persisted manager state text.
 * @param text - JSON text; empty or whitespace yields a default state.
 * @returns validated state or `null` when the payload is not usable.
 */
export function parseStateText(text) {
  if (!text || !text.trim()) return defaultState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateState(parsed);
}

/** Coerce a parsed object into a safe state shape; throws on bad shapes. */
export function validateState(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("state must be an object");
  }
  const state = defaultState();
  state.version = input.version === STATE_VERSION ? STATE_VERSION : STATE_VERSION;
  const config = input.config && typeof input.config === "object" ? input.config : {};
  state.config = {
    enabled: typeof config.enabled === "boolean" ? config.enabled : state.config.enabled,
    maxAuto: intIn(config.maxAuto, 0, 8, state.config.maxAuto),
    maxSuggest: intIn(config.maxSuggest, 0, 8, state.config.maxSuggest),
    autoThreshold: intIn(config.autoThreshold, 1, 20, state.config.autoThreshold),
    suggestThreshold: intIn(config.suggestThreshold, 1, 20, state.config.suggestThreshold),
    installGate: INSTALL_GATE_MODES.includes(config.installGate) ? config.installGate : state.config.installGate,
    proposeEnabled: typeof config.proposeEnabled === "boolean" ? config.proposeEnabled : state.config.proposeEnabled,
    proposeThreshold: intIn(config.proposeThreshold, 1, 20, state.config.proposeThreshold),
    maxPropose: intIn(config.maxPropose, 1, 4, state.config.maxPropose),
    candidateCatalogPath: typeof config.candidateCatalogPath === "string"
      ? config.candidateCatalogPath.slice(0, 1024)
      : state.config.candidateCatalogPath,
  };
  if (Array.isArray(input.skillSources)) {
    state.skillSources = input.skillSources
      .filter((source) => source && typeof source === "object" && typeof source.url === "string")
      .map((source) => ({
        id: String(source.id ?? `${source.url}#${source.ref ?? "main"}`),
        url: source.url,
        ref: typeof source.ref === "string" ? source.ref : "main",
        clonePath: typeof source.clonePath === "string" ? source.clonePath : "",
        commit: typeof source.commit === "string" ? source.commit : "",
        installedAt: typeof source.installedAt === "string" ? source.installedAt : "",
        plugin: source.plugin && typeof source.plugin === "object" && typeof source.plugin.name === "string"
          ? {
              name: source.plugin.name.slice(0, 128),
              version: typeof source.plugin.version === "string" ? source.plugin.version.slice(0, 64) : "",
              description: typeof source.plugin.description === "string" ? source.plugin.description.slice(0, 500) : "",
              manifest: safeRepoPath(source.plugin.manifest) ?? "",
              hooksFile: safeRepoPath(source.plugin.hooksFile),
              hooks: Array.isArray(source.plugin.hooks)
                ? source.plugin.hooks.filter((hook) => hook && RUNNABLE_PLUGIN_HOOKS.has(hook.event) && safeRepoPath(hook.script))
                : [],
              unsupportedHooks: Array.isArray(source.plugin.unsupportedHooks) ? source.plugin.unsupportedHooks.filter((event) => typeof event === "string").slice(0, 16) : [],
            }
          : null,
        skills: Array.isArray(source.skills)
          ? source.skills.filter((skill) => skill && typeof skill.name === "string")
          : [],
      }));
  }
  if (input.skills && typeof input.skills === "object" && !Array.isArray(input.skills)) {
    for (const [name, entry] of Object.entries(input.skills)) {
      if (!entry || typeof entry !== "object") continue;
      state.skills[name] = {
        sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : "",
        ref: typeof entry.ref === "string" ? entry.ref : "main",
        commit: typeof entry.commit === "string" ? entry.commit : "",
        relPath: typeof entry.relPath === "string" ? entry.relPath : ".",
        installedAt: typeof entry.installedAt === "string" ? entry.installedAt : "",
        mode: ACTIVATION_MODES.includes(entry.mode) ? entry.mode : undefined,
        triggers: Array.isArray(entry.triggers)
          ? entry.triggers.filter((item) => typeof item === "string").slice(0, 32)
          : undefined,
        hooks: entry.hooks && typeof entry.hooks === "object" ? sanitizeHooks(entry.hooks) : undefined,
        scope: entry.scope === "project" ? "project" : undefined,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      };
    }
  }
  if (Array.isArray(input.events)) state.events = input.events.slice(-MAX_EVENTS);
  return state;
}

function intIn(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Serialize state for the manifest file. */
export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Names of skills whose installed commit changed between two states.
 * @param before - previous state.
 * @param after - next state.
 * @returns `{ name, from, to }[]` for changed skills.
 */
export function changedSkills(before, after) {
  const changed = [];
  for (const [name, afterEntry] of Object.entries(after.skills)) {
    const beforeEntry = before && before.skills ? before.skills[name] : undefined;
    if (!beforeEntry || beforeEntry.commit !== afterEntry.commit) {
      changed.push({ name, from: shortCommit(beforeEntry?.commit), to: shortCommit(afterEntry.commit) });
    }
  }
  return changed;
}

/** Append one event line to the capped history. */
export function pushEvent(state, kind, detail) {
  const entry = {
    at: new Date().toISOString(),
    kind,
    detail: typeof detail === "string" ? detail.slice(0, 500) : String(detail ?? "").slice(0, 500),
  };
  state.events = [...state.events, entry].slice(-MAX_EVENTS);
  return entry;
}

/** One-line changelog rendering for a completed sync. */
export function renderSyncSummary(result) {
  const lines = [];
  if (result.updated && result.updated.length > 0) {
    lines.push(`updated: ${result.updated.map((item) => `${item.name} (${item.from} → ${item.to})`).join(", ")}`);
  }
  if (result.unchangedCount !== undefined && result.unchangedCount > 0) {
    lines.push(`unchanged: ${result.unchangedCount} skill(s)`);
  }
  for (const error of result.errors ?? []) lines.push(`error: ${error}`);
  if (lines.length === 0) lines.push("no changes");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude Code / Codex parity: declarative skill hooks.
//
// A skill declares hooks in SKILL.md frontmatter under `metadata.hooks` using
// Claude Code's event names:
//
//   metadata:
//     hooks:
//       UserPromptSubmit:                 # fires while the skill is active
//         inject: "Always remind: YAGNI."
//       PreToolUse:                       # policy gate before tool dispatch
//         - tool: bash
//           when: "git push"              # substring or re:<pattern>
//           decision: deny                # allow | deny | ask
//           reason: "Push without review is forbidden"
//       PostToolUse:                      # activate the skill on result match
//         - tool: bash
//           when: "exit code [1-9]"       # re: not required; substring also ok
//           action: activate
//       SessionStart:
//         activate: true
//
// User-side hook overrides (manager state) replace the metadata hooks per
// event, so third-party skills stay triggerable without editing upstream.
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart"];
export const HOOK_DECISIONS = ["allow", "deny", "ask"];

/** Hook metadata declared by a skill, or an empty object. */
export function hookListOf(metadata) {
  const value = metadata && typeof metadata === "object" ? metadata.hooks : undefined;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Normalized hook set for one skill: `{ inject?, preToolUse[], postToolUse[], sessionStartActivate? }`. */
export function normalizeHooks(metadata, userOverrides) {
  const declared = hookListOf(metadata);
  const merged = { ...declared, ...(userOverrides && typeof userOverrides === "object" && !Array.isArray(userOverrides) ? userOverrides : {}) };
  const hooks = { inject: undefined, preToolUse: [], postToolUse: [], sessionStartActivate: false };
  const submitted = merged.UserPromptSubmit;
  if (submitted && typeof submitted === "object" && typeof submitted.inject === "string") {
    hooks.inject = submitted.inject.slice(0, 2000);
  }
  const pre = merged.PreToolUse;
  if (Array.isArray(pre)) {
    for (const entry of pre) {
      if (!entry || typeof entry !== "object") continue;
      const tool = typeof entry.tool === "string" ? entry.tool : "*";
      const decision = HOOK_DECISIONS.includes(entry.decision) ? entry.decision : undefined;
      if (decision === undefined) continue;
      hooks.preToolUse.push({
        tool,
        when: typeof entry.when === "string" ? entry.when.slice(0, 512) : undefined,
        decision,
        reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : undefined,
      });
    }
  }
  const post = merged.PostToolUse;
  if (Array.isArray(post)) {
    for (const entry of post) {
      if (!entry || typeof entry !== "object" || entry.action !== "activate") continue;
      const tool = typeof entry.tool === "string" ? entry.tool : "*";
      hooks.postToolUse.push({
        tool,
        when: typeof entry.when === "string" ? entry.when.slice(0, 512) : undefined,
      });
    }
  }
  const start = merged.SessionStart;
  if (start && typeof start === "object" && start.activate === true) hooks.sessionStartActivate = true;
  return hooks;
}

/** Whether a normalized hook set declares anything executable. */
export function hookCount(hooks) {
  return (hooks.inject ? 1 : 0)
    + hooks.preToolUse.length
    + hooks.postToolUse.length
    + (hooks.sessionStartActivate ? 1 : 0);
}

/**
 * Match a `when` pattern against text: plain case-insensitive substring, or
 * `re:<pattern>` regular expression. `undefined`/empty matches everything.
 * @returns boolean.
 */
export function matchHookWhen(when, text) {
  if (when === undefined || when === "") return true;
  const trigger = parseTriggerEntry(when);
  return trigger !== undefined && matchTrigger(trigger, String(text).toLocaleLowerCase());
}

/** Lowercased searchable text of a tool call (name + serialized arguments). */
export function toolCallText(name, args) {
  let serialized = "";
  try {
    serialized = args === undefined ? "" : JSON.stringify(args) ?? "";
  } catch {
    serialized = String(args ?? "");
  }
  return `${name} ${serialized}`.toLocaleLowerCase();
}

/** Searchable text of a tool result content projection. */
export function resultText(content) {
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") blocks.push(block.text);
  }
  return blocks.join("\n").toLocaleLowerCase();
}

/** Collect active skill names from session events (activation markers). */
export function activeSkillNames(events) {
  const names = [];
  const seen = new Set();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "user/message") continue;
    const source = managerSourceData(event.data && event.data.source);
    if (!source) continue;
    const candidate = source.form === "activation" ? source.name : undefined;
    if (typeof candidate === "string" && !seen.has(candidate)) {
      seen.add(candidate);
      names.push(candidate);
    }
  }
  return names;
}

/**
 * Shallow-sanitize a user-supplied hooks object so only known events survive
 * with plausibly typed values; {@link normalizeHooks} performs the strict
 * per-entry validation at read time.
 * @param raw - raw hooks object.
 * @returns a plain object safe to persist.
 */
export function sanitizeHooks(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const submitted = raw.UserPromptSubmit;
  if (submitted && typeof submitted === "object" && typeof submitted.inject === "string") {
    out.UserPromptSubmit = { inject: submitted.inject.slice(0, 2000) };
  }
  for (const key of ["PreToolUse", "PostToolUse"]) {
    const list = raw[key];
    if (Array.isArray(list)) {
      out[key] = list
        .filter((entry) => entry && typeof entry === "object")
        .slice(0, 16)
        .map((entry) => ({
          tool: typeof entry.tool === "string" ? entry.tool.slice(0, 64) : "*",
          when: typeof entry.when === "string" ? entry.when.slice(0, 512) : undefined,
          decision: typeof entry.decision === "string" ? entry.decision.slice(0, 16) : undefined,
          reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : undefined,
          action: typeof entry.action === "string" ? entry.action.slice(0, 16) : undefined,
        }));
    }
  }
  const start = raw.SessionStart;
  if (start && typeof start === "object" && start.activate === true) out.SessionStart = { activate: true };
  return out;
}

// ---------------------------------------------------------------------------
// Install/update consent gate (P0). These are pure text builders. The host
// wiring lives in index.js. See DESIGN.md §4 (card text) and §6 (fail-closed).
// ---------------------------------------------------------------------------

/** Whether a `skill_manager` action changes installed code from a remote source. */
export function isGatedAction(action) {
  return GATED_ACTIONS.includes(action);
}

/** Collapse whitespace, drop control characters, and cap a single-line surface. */
export function truncateText(text, max) {
  const clean = String(text ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render the one-line approval card text.
 * The host card flattens newlines, because its headline element has no
 * `white-space: pre-wrap` (dsh-client-ui-approval). A multi-line list would lose
 * its structure here, so the full inventory travels in the propose message.
 * @param input - `{ action, label, hooksSummary? }`.
 * @returns one line of at most {@link GATE_CARD_MAX_CHARS} characters.
 */
export function renderGateAskLine({ action, label, hooksSummary }) {
  const where = truncateText(label, 48);
  const text = action === "update"
    ? `Update ${where} — pulls remote code, may add hooks, current hooks: ${hooksSummary ?? "unknown"}. Allow once?`
    : `Install ${where} — whole repo, may include extra skills, executable lifecycle hooks unverifiable before install, source allowlisted. Allow once?`;
  return truncateText(text, GATE_CARD_MAX_CHARS);
}

/** What the model loses when the gated operation does not run. */
function gateFallback(action) {
  return action === "update"
    ? "Installed skills keep their current version and no remote code was fetched."
    : "The installed skills stay as they are, and the Git source is not added to the skill catalog.";
}

/** Model-facing verb for the gated operation. */
function gateVerb(action) {
  return action === "update" ? "update" : "install";
}

const GATE_SETTINGS_HINT =
  "The user can run the same operation in Settings → Skill Management, which is not gated because the user starts it.";

/** Model-facing reason for each denial code. These are multi-line and safe. */
const GATE_DENIAL_RENDERERS = {
  "user-rejected": (action, label) => [
    `Operation not performed: the user rejected this ${gateVerb(action)} request (${label}).`,
    `Degradation: ${gateFallback(action)}`,
    "Next step: retry only when the user asks. The user can also run it in Settings → Skill Management.",
  ].join("\n"),
  "approval-cancelled": (action, label) => [
    `Operation not performed: the approval request was cancelled, so no Git command ran (${label}).`,
    `Degradation: ${gateFallback(action)}`,
  ].join("\n"),
  "approval-unavailable": (action, label) => [
    `Operation not performed: no approval channel is available, so the gate failed closed (${label}).`,
    "Deployment note: mount an approval answerer, for example dsh-user-approval with dsh-client-ui-approval.",
    `Degradation: ${gateFallback(action)}`,
    GATE_SETTINGS_HINT,
  ].join("\n"),
  "approval-error": (action, label) => [
    `Operation not performed: the approval request failed, so the gate failed closed (${label}).`,
    `Degradation: ${gateFallback(action)}`,
    GATE_SETTINGS_HINT,
  ].join("\n"),
  "policy-deny": (action, label) => [
    `Operation not performed: installGate is deny, so this session blocks model-initiated ${gateVerb(action)} calls (${label}).`,
    `Degradation: ${gateFallback(action)}`,
    GATE_SETTINGS_HINT,
  ].join("\n"),
  "no-agent": (action, label) => [
    `Operation not performed: this tool call has no agent, so the gate cannot ask the user (${label}).`,
    `Degradation: ${gateFallback(action)}`,
  ].join("\n"),
};

/**
 * Build the denial for one gate outcome.
 * @param input - `{ code, action, label, reasonOverride? }`.
 * @returns `{ reason, info }` for a `{ kind: 'deny' }` decision.
 * `reasonOverride` is returned verbatim. The gate uses it for `invalid-source`,
 * so the model never sees two wordings for one rejected URL (DESIGN.md §6).
 */
export function renderGateDenial({ code, action, label, reasonOverride }) {
  const info = { name: "SkillInstallBlocked", code };
  if (typeof reasonOverride === "string") return { reason: reasonOverride, info };
  const render = GATE_DENIAL_RENDERERS[code];
  const where = truncateText(label, 120) || "(unknown source)";
  if (render === undefined) {
    return { reason: `Operation not performed: the install gate denied this call (${code}).`, info };
  }
  return { reason: render(action === "update" ? "update" : "install", where), info };
}

// ---------------------------------------------------------------------------
// Capability-gap proposals (P1). Pure parsing, ranking, and rendering. The host
// owns filesystem access, mtime caching, and warn throttling (DESIGN.md §12).
// ---------------------------------------------------------------------------

/** Hard caps for one candidate catalog (DESIGN.md §3.1). */
export const CANDIDATE_LIMITS = {
  entries: 200,
  description: 300,
  whenToUse: 300,
  triggers: 32,
  trigger: 200,
  skills: 16,
};

/** Whether a string is a kebab-case skill name. */
function isKebabName(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Normalize one catalog entry, or return undefined when it is unusable. */
function normalizeCandidate(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
  const repoUrl = normalizeGitSourceUrl(repo);
  // An off-allowlist repo drops whole: the catalog is a listing, and it must not
  // widen what may be cloned (DESIGN.md §3.1).
  if (repoUrl === null) return undefined;
  const description = typeof raw.description === "string"
    ? raw.description.slice(0, CANDIDATE_LIMITS.description)
    : "";
  if (description === "") return undefined;
  const whenToUse = typeof raw.whenToUse === "string"
    ? raw.whenToUse.slice(0, CANDIDATE_LIMITS.whenToUse)
    : "";
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers
      .filter((item) => typeof item === "string" && item.length > 0 && item.length <= CANDIDATE_LIMITS.trigger)
      .slice(0, CANDIDATE_LIMITS.triggers)
    : [];
  const declaredSkills = Array.isArray(raw.skills)
    ? raw.skills.filter(isKebabName).slice(0, CANDIDATE_LIMITS.skills)
    : [];
  const hookEvents = raw.hooks !== null && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
    ? HOOK_EVENTS.filter((event) => raw.hooks[event] === true)
    : [];
  return {
    repo,
    repoUrl,
    name: isKebabName(raw.name) ? raw.name : undefined,
    description,
    whenToUse,
    triggers,
    declaredSkills,
    hooks: { declared: hookEvents.length > 0, events: hookEvents },
    verified: raw.verified === true,
  };
}

/**
 * Validate a candidate catalog document.
 * @param text - catalog JSON text.
 * @returns `{ entries, dropped }`. Throws for a document the loader cannot use,
 * so callers report one load failure instead of a per-entry mystery.
 */
export function parseCandidateCatalog(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("candidate catalog is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("candidate catalog must be an object");
  }
  if (parsed.version !== 1) {
    throw new Error(`unsupported candidate catalog version: ${JSON.stringify(parsed.version)}`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("candidate catalog must be an object with an entries array");
  }
  if (parsed.entries.length > CANDIDATE_LIMITS.entries) {
    throw new Error(`candidate catalog has too many entries (${parsed.entries.length} > ${CANDIDATE_LIMITS.entries})`);
  }
  const entries = [];
  let dropped = 0;
  for (const raw of parsed.entries) {
    const entry = normalizeCandidate(raw);
    if (entry === undefined) {
      dropped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, dropped };
}

/**
 * Rank catalog entries with the same scorer the installed skills use, so "gap"
 * and "match" mean one thing across both branches (DESIGN.md §2).
 */
export function rankCandidates(entries, query) {
  const normalized = String(query).toLocaleLowerCase();
  const ranked = [];
  for (const entry of entries) {
    const view = {
      name: entry.name ?? entry.repo,
      description: entry.description,
      whenToUse: entry.whenToUse,
      metadata: entry.triggers.length > 0 ? { triggers: entry.triggers } : undefined,
      invocation: { modelInvocable: true },
    };
    const { score, reasons } = scoreSkill(view, normalized, []);
    if (score <= 0) continue;
    ranked.push({ ...entry, score, reasons });
  }
  ranked.sort((left, right) => right.score - left.score
    || (left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0));
  return ranked;
}

/** Whether a candidate's declared skills are all installed already. */
export function candidateIsInstalled(entry, installedNames) {
  if (entry.name !== undefined && installedNames.has(entry.name)) return true;
  if (entry.declaredSkills.length === 0) return false;
  return entry.declaredSkills.every((name) => installedNames.has(name));
}

/** Render the proposal injected into model context (English, DESIGN.md §3.3). */
export function renderProposalText(entries, query) {
  const lines = [
    "<system-reminder>",
    "[skill-manager · capability gap]",
    `Trigger: "${truncateText(query, 160)}"`,
    `Suggested equipment (${entries.length} this turn):`,
  ];
  entries.forEach((entry, index) => {
    const label = entry.name === undefined ? entry.repo : `${entry.repo} (skill: ${entry.name})`;
    lines.push(`${index + 1}. ${label} — ${entry.description}`);
    lines.push(`   Score ${entry.score} (${entry.reasons.join(", ") || "matched task"})`);
    lines.push("   Gap: the installed skills do not fully cover this request");
    lines.push(entry.hooks.declared
      ? `   Hooks: catalog declares ${entry.hooks.events.join(", ")} (unverified)`
      : "   Hooks: not declared by the catalog (unknown until installed)");
    lines.push(entry.verified ? "   Source: verified by curator" : "   Source: allowlisted only");
    if (entry.declaredSkills.length > 0) {
      lines.push(`   Repository skills (catalog-declared, may be incomplete): ${entry.declaredSkills.join(", ")}`);
    }
  });
  lines.push("", "Installing needs the user to approve this tool call. I will not install on my own.");
  lines.push("If the user rejects or does not answer: continue with the installed skills and state the remaining gap.");
  lines.push("</system-reminder>");
  return lines.join("\n");
}
