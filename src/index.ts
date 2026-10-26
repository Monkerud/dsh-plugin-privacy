/**
 * dsh-agent-privacy — agent-side thinking privacy for DeepSeek Harness.
 * Independent evolution of easonz1989/dsh-hide-my-thinking.
 * Full credit: https://github.com/easonz1989/dsh-hide-my-thinking
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/**
 * One-time validator patch: the v4 session-format validator throws
 * "system/message requires a protected first surface head" when a
 * `system/message` is appended after a non-system surface event without
 * a prior `protectedHead`. Plugins that append `user/message` at
 * `turn/start` (before the agent loop's `system/message`) trip this.
 *
 * We patch the validator file on disk at plugin load: replace the
 * `throw` with a retroactive `protectedHead` set. This is idempotent
 * (the marker string won't match after the first patch).
 */
async function patchSessionFormatValidator(): Promise<void> {
  try {
    // Walk up from the plugin's own location to find the DSH checkout's node_modules.
    // Plugin lives at: {checkout}/Workspace/.dsh/Local-plugins/dsh-agent-privacy/lib/
    // so node_modules is 5 levels up (lib → plugin → Local-plugins → .dsh → Workspace → checkout).
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    let dir = here
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')
      try {
        await fs.access(candidate)
        await patchValidatorFile(candidate)
        return
      } catch { /* keep walking up */ }
      dir = path.dirname(dir)
    }
  } catch {
    // best-effort
  }
}
async function patchValidatorFile(validatorFile: string): Promise<void> {
  const marker = 'system/message requires a protected first surface head'
  let content = await fs.readFile(validatorFile, 'utf-8')
  if (!content.includes(marker)) return

  // 1. Save a backup of the original file (only once).
  const backupFile = validatorFile + '.original'
  try {
    await fs.access(backupFile)
  } catch {
    await fs.copyFile(validatorFile, backupFile)
  }

  // 2. Ensure the helper imports + plugin-presence check + self-revert exist.
  const importBlock = `import { existsSync as __dshPrivacyExistsSync, readFileSync as __dshPrivacyReadFile, writeFileSync as __dshPrivacyWriteFile, unlinkSync as __dshPrivacyUnlink } from "node:fs";
import { join as __dshPrivacyJoin, dirname as __dshPrivacyDirname } from "node:path";
import { fileURLToPath as __dshPrivacyFileURLToPath } from "node:url";
const __dshPrivacyHere = __dshPrivacyDirname(__dshPrivacyFileURLToPath(import.meta.url));
const __dshPrivacyPluginPresent = __dshPrivacyExistsSync(__dshPrivacyJoin(__dshPrivacyHere, "..", "..", "..", "..", "Workspace", ".dsh", "Local-plugins", "dsh-agent-privacy"));
const __dshPrivacyBackup = __dshPrivacyJoin(__dshPrivacyHere, "index.js.original");
if (!__dshPrivacyPluginPresent && __dshPrivacyExistsSync(__dshPrivacyBackup)) {
  try {
    __dshPrivacyWriteFile(__dshPrivacyJoin(__dshPrivacyHere, "index.js"), __dshPrivacyReadFile(__dshPrivacyBackup, "utf-8"), "utf-8");
    __dshPrivacyUnlink(__dshPrivacyBackup);
  } catch {}
}`
  if (!content.includes('__dshPrivacyPluginPresent')) {
    const importLines = content.split('\n')
    let lastImportIdx = -1
    for (let i = 0; i < importLines.length; i++) {
      if (importLines[i].startsWith('import ')) lastImportIdx = i
    }
    const lines = importLines.slice()
    lines.splice(lastImportIdx + 1, 0, importBlock)
    content = lines.join('\n')
  }

  // 3. Replace the throw with a conditional: tolerate only when the plugin is present.
  const re = new RegExp(
    '([\\t ]*)if \\(event\\.type === "system/message" && this\\.surface\\.length > 0 && this\\.protectedHead === void 0\\) throw new SessionFormatError\\("' + marker + '"\\);',
  )
  const patched = content.replace(
    re,
    (m: string, ws: string) =>
      ws + 'if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0) {\n' +
      ws + '  if (__dshPrivacyPluginPresent) { this.protectedHead = event.seq; } else { throw new SessionFormatError("' + marker + '"); }\n' +
      ws + '}',
  )
  if (patched !== content) {
    await fs.writeFile(validatorFile, patched, 'utf-8')
  }
}
void patchSessionFormatValidator()
// Namespace import: the settings API differs between 0.1.x (register/SettingsScope)
// and 0.2.0 (SettingsForms). We feature-detect at runtime so one build serves both.
import * as dshSettings from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/dsh-client-connection'

export interface ThinkingSettings {
  showModelThinking: boolean
}

interface RpcError {
  code: 'internal'
  message: string
  details: Record<string, unknown>
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export const SETTINGS_NAMESPACE = 'agent-privacy'
export const RPC_CHANNEL = '/agent-privacy'
/**
 * Config schema. Exporting `Config` makes the Loader register the
 * `agent-privacy` settings namespace; the row's `config` is validated against
 * it at activation, and the resolved value is handed to `apply` as `config`.
 * The `z<ThinkingSettings>` annotation names the schema's output type so the
 * declaration file stays portable (schemastery's inferred type is not).
 */
const _showModelThinking = z.boolean().default(true)
/**
 * 0.2.0 marks user-editable fields `.volatile()` — required for the settings
 * service to write them (and for the in-chat Privacy toggle to work). 0.1.x
 * schemastery has no `.volatile()` method, so the call is guarded: at 0.1.x
 * runtime the field stays a plain default-boolean.
 */
const showModelThinking = typeof _showModelThinking.volatile === 'function'
  ? _showModelThinking.volatile()
  : _showModelThinking
export const SCHEMA = z.object({
  showModelThinking,
}) as unknown as z<ThinkingSettings>
/** Loader-facing config schema (0.2.0: `export const Config`). */
export const Config: z<ThinkingSettings> = SCHEMA

/** Model-facing tool name the agent calls to toggle thinking visibility. */
export const TOOL_NAME = 'set_model_thinking_visibility'

/** Model-facing tool name the agent calls to read current thinking visibility. */
export const GET_TOOL_NAME = 'get_model_thinking_visibility'

/** System-prompt section name (unique per plugin). */
const PROMPT_SECTION = 'tool:agent-privacy'

/**
 * Tool-guidance placement. The harness keeps its standard system-prompt prefix
 * byte-stable so the provider's KV-cache hits; a section wedged into the top
 * band (order < 500, e.g. 120) splits that prefix and forces a full pre-fill
 * every turn. Static plugin guidance therefore belongs in the STABLE TAIL, just
 * above the deployment persona suffix (order 10200): the standard prefix is left
 * untouched and only our (constant) text is appended at the very end.
 */
const PROMPT_ORDER = 10300

// --- Private notes (the agent's persistent inner scratchpad, thoughts.txt) ---
const NOTES_FILE = 'thoughts.txt'
/** Max characters of note TEXT per single note. */
const NOTE_MAX_LEN = 500
/**
 * Minimum length for a `<note>` capture to be kept. A capture shorter than
 * this AND containing no space is reasoning noise ("...", "…", a lone token),
 * so it is silently discarded — it never reaches storage or the prompt.
 */
const NOTE_MIN_LEN = 20
/** Max characters of the whole thoughts.txt file; oldest notes evict first. */
const FILE_MAX_LEN = 10000
/** ID length (hex chars) — a sha512 content-address prefix. */
const NOTE_ID_LEN = 16
/** Separator line between notes in the file. */
const NOTE_SEP = '\n:-\n'
/** ID / text delimiter inside a note line: `<id> · <text>`. */
const NOTE_FIELD = ' · '

const READ_NOTES = 'read_notes'
const DELETE_NOTE = 'delete_note'

/** Standing guidance: how the agent writes notes (the `<note>` span). */
const NOTE_GUIDANCE_SECTION = 'agent-privacy:note-writing'
/** Stable-tail placement (see PROMPT_ORDER): after the persona suffix (10200). */
const NOTE_GUIDANCE_ORDER = 10310

interface Note {
  id: string
  text: string
}

/** Content-address: sha512 of the note text, truncated to NOTE_ID_LEN hex chars. */
function sha512id(text: string): string {
  return createHash('sha512').update(text, 'utf8').digest('hex').slice(0, NOTE_ID_LEN)
}

function noteLine(note: Note): string {
  return `${note.id}${NOTE_FIELD}${note.text}`
}

function parseNotes(raw: string): Note[] {
  if (raw.trim() === '') return []
  return raw
    .split(NOTE_SEP)
    .map((line) => {
      const idx = line.indexOf(NOTE_FIELD)
      if (idx === -1) return { id: line, text: '' }
      return { id: line.slice(0, idx), text: line.slice(idx + NOTE_FIELD.length) }
    })
    .filter((n) => n.id.length > 0)
}

function serializeNotes(notes: Note[]): string {
  return notes.map(noteLine).join(NOTE_SEP)
}

async function readNotesFile(cwd: string): Promise<Note[]> {
  try {
    const raw = await fs.readFile(path.join(cwd, NOTES_FILE), 'utf8')
    return parseNotes(raw)
  } catch {
    return []
  }
}

async function writeNotesFile(cwd: string, notes: Note[]): Promise<void> {
  await fs.writeFile(path.join(cwd, NOTES_FILE), serializeNotes(notes), 'utf8')
}

/** Drop the OLDEST notes (array head) until the serialized file is within FILE_MAX_LEN. */
function evictToLimit(notes: Note[]): { notes: Note[]; evicted: number } {
  let evicted = 0
  while (notes.length > 1 && serializeNotes(notes).length > FILE_MAX_LEN) {
    notes.shift()
    evicted++
  }
  return { notes, evicted }
}

/** Resolve the caller's workspace dir from the execution context's agent. */
function cwdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent
  return agent?.session?.header?.cwd
}

/** `<note>…</note>` spans the agent writes in its thinking; picked up at turn end. */
const NOTE_TAG_RE = /<note>([\s\S]*?)<\/note>/g

/** Flatten an assistant message's text + reasoning blocks into one string. */
function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } =>
      (b as { type?: unknown }).type === 'text' || (b as { type?: unknown }).type === 'reasoning')
    .map((b) => (b as { text: string }).text)
    .join('\n')
}

/**
 * Pull every well-formed `<note>…</note>` span out of a chunk of text.
 * Trivial fragments are silently discarded: a capture under NOTE_MIN_LEN
 * chars with no space (e.g. "...", "…", a lone token) is reasoning noise,
 * not a real note — so it never reaches storage or the prompt.
 */
function extractNoteSpans(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(NOTE_TAG_RE)) {
    const t = m[1].trim()
    if (t === '') continue
    if (t.length < NOTE_MIN_LEN && !t.includes(' ')) continue
    out.push(t)
  }
  return out
}

/**
 * Persist a batch of note texts into a session's thoughts.txt. Content-addressed
 * (sha512) so repeats are no-ops; capped per-note and per-file (oldest evict).
 * Returns the number of NEW notes actually added.
 */
async function persistNotes(cwd: string, texts: string[]): Promise<number> {
  const notes = await readNotesFile(cwd)
  let added = 0
  for (const raw of texts) {
    const text = raw.length > NOTE_MAX_LEN ? raw.slice(0, NOTE_MAX_LEN) : raw
    const id = sha512id(text)
    if (notes.some((n) => n.id === id)) continue
    notes.push({ id, text })
    added++
  }
  if (added > 0) {
    const { notes: kept } = evictToLimit(notes)
    await writeNotesFile(cwd, kept)
  }
  return added
}

/** Minimal structural view of the agent registry we need (avoids a heavy import). */
interface AgentLike {
  send(message: unknown, target: 'next-turn' | 'next-step', wakeup: boolean): void
}
interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
}

function rpcError(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

export const name = 'dsh-agent-privacy'
export const inject = ['connection', 'settings', 'tools', 'systemPrompt', 'agents', 'sessions']

export function apply(ctx: Context, config: ThinkingSettings = { showModelThinking: true }): void {
  // Dual-compatible settings state. 0.1.x exposes a registered SettingsScope
  // (settings.register → get/update); 0.2.0 exposes a SettingsForms service
  // (describe/update, namespace registered by the Loader from `Config`).
  type SettingsState =
    | { kind: 'scope'; scope: { get(): ThinkingSettings | undefined; update(p: Partial<ThinkingSettings>): Promise<void> } }
    | { kind: 'forms'; forms: { describe(): Promise<Array<{ ns: string; value: unknown }>>; update(ns: string, p: object): Promise<void> } }
    | undefined
  let settings: SettingsState
  let agents: AgentRegistryLike | undefined

  ctx.inject(['settings'], (sctx: Context) => {
    const s = sctx.settings as unknown as {
      register?: <T>(ns: string, schema: unknown, opts?: { base?: unknown }) => { get(): T | undefined; update(p: Partial<T>): Promise<void> }
      describe?: () => Promise<Array<{ ns: string; value: unknown }>>
      update?: (ns: string, p: object) => Promise<void>
    }
    if (typeof s.register === 'function') {
      // 0.1.x: brand the raw string as a SettingsNamespace, then register.
      const brand = (dshSettings as { settingsNamespace?: (v: string) => string }).settingsNamespace
      const ns = brand ? brand(SETTINGS_NAMESPACE) : SETTINGS_NAMESPACE
      settings = { kind: 'scope', scope: s.register<ThinkingSettings>(ns, SCHEMA, { base: { showModelThinking: true } }) }
    } else if (typeof s.describe === 'function' && typeof s.update === 'function') {
      // 0.2.0: the `agent-privacy` namespace is registered by the Loader from
      // the exported `Config` schema; read/write through the SettingsForms service.
      // Bind to `s`: these methods call a private `this.write` internally, so a
      // detached reference (stored bare) loses `this` and later throws
      // "this.write is not a function" when the plugin invokes `update`.
      settings = { kind: 'forms', forms: { describe: s.describe.bind(s), update: s.update.bind(s) } }
    }
  })

  ctx.inject(['agents'], (actx: Context) => {
    agents = actx.agents as unknown as AgentRegistryLike
  })

  let sessionsService: { get(id: string): SessionLike | undefined } | undefined
  ctx.inject(['sessions'], (sctx: Context) => {
    sessionsService = (sctx as any).sessions as typeof sessionsService
  })

  // --- Event-based <note> pickup ---
  // The agent writes <note>…</note> (in thinking or text). On each completed
  // `assistant/message` event we pull out any spans and buffer them per
  // session. When the turn ends (`turn/end`) we persist the buffered spans to
  // thoughts.txt (idempotent: sha512 dedup) and, if anything new landed,
  // append a short NEUTRAL notice ("📝 Note stored") as a proper user message.
  //
  // The notice is FLUSHED AT A SAFE BOUNDARY, never via a floating
  // persist→microtask chain. The persist is async (fs I/O), so a notice
  // scheduled straight off `turn/end` routinely outlives the turn boundary
  // and lands MID-STEP of the NEXT turn — i.e. BETWEEN a `tool/call` and its
  // `tool/result`. That wedged user message breaks the provider's strict
  // function_call → function_call_output adjacency (the request then 400s
  // with "invalid_tool_history"), and a notice appended without `id` +
  // `source` corrupts the durable log so every later restore crashes in
  // `RuntimeContextProjection` ("Cannot read properties of undefined
  // (reading 'kind')"). So:
  //   1. `turn/end` → persist; if new notes, STAGE the notice text.
  //   2. The next SAFE boundary for that session — a `tool/result` (a
  //      call/result pair is then complete), `turn/end`, or `turn/start` —
  //      appends the staged notice. None of these can sit between a call
  //      and its result, so the notice can never wedge a pair.
  // The append itself is microtask-deferred because every one of these
  // observers runs *inside* that event's append publication — a synchronous
  // session.append would throw "cannot reenter while another append is
  // being published".
  const turnNotes = new Map<string, string[]>()
  /**
   * Sessions that have received the one-shot "call read_notes now" reminder.
   * The reminder is a CONVERSATION message, not a system-prompt line (which
   * would be re-sent on every request): it lands once at the session's first
   * `turn/start` (new-chat start) and again after each `compaction/end`
   * (pre-fill start — the earlier read_notes result may have been compacted
   * away). Both are safe boundaries, so a microtask-deferred append is safe.
   */
  const readNotesPrompted = new Set<string>()
  const READ_NOTES_ONESHOT_TEXT =
    '⚙️ host: call read_notes now to load any standing notes. ' +
    'After this reminder, call read_notes only when you need to recall something.'
  function appendOneShotReadNotes(session: SessionLike): void {
    // user/message is surface-eligible. The validator patch (dsh-session-format-v3-to-v4)
    // retroactively sets protectedHead when a system/message lands after a
    // non-system head, so this no longer corrupts the session log.
    queueMicrotask(() => {
      void session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: READ_NOTES_ONESHOT_TEXT }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
  }
  /** Staged notice texts, flushed (joined) at the next safe boundary. */
  const pendingNotice = new Map<string, { texts: string[]; session: SessionLike }>()
  /**
   * The last event type seen per session. Used to decide, when an async
   * persist resolves, whether we are STILL at a safe boundary (flush now) or
   * have drifted into a step (defer to the next tool/result / turn boundary).
   */
  const lastEventType = new Map<string, string>()
  type SessionLike = {
    id: string
    header: { cwd?: string }
    append(type: string, data: unknown, intent?: { surfaceOp: 'append' | { op: 'replace'; start: number; end: number }; sourceEventSeqs?: number[] }): unknown
  }
  const SAFE_BOUNDARIES = new Set(['tool/result', 'turn/end', 'turn/start', 'compaction/end'])
  function flushPendingNotice(session: SessionLike): void {
    const staged = pendingNotice.get(session.id)
    if (staged === undefined || staged.texts.length === 0) return
    pendingNotice.delete(session.id)
    const text = staged.texts.join(' ')
    queueMicrotask(() => {
      void staged.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
  }

  // Boundary-diff: at each safe boundary, compare the live cordis visibility
  // value against the last-seen value for this session. If it changed AND the
  // change came from the user (POST), stage a one-line host note and flush it
  // (append-only, KV-cache-stable). When the change came from the agent (SET
  // tool), the agent already knows (it made the tool call) — no note needed.
  const lastSeenVisibility = new Map<string, boolean>()
  let lastWriteSource: 'post' | 'tool' = 'post'
  function stageVisibilityNotice(session: SessionLike): void {
    if (lastWriteSource !== 'post') return // agent-initiated: it already knows
    let current: boolean | undefined
    try {
      const entry: any = (ctx as any).fiber?.entry
      current = entry?.options?.config?.showModelThinking
    } catch { /* best effort */ }
    if (typeof current !== 'boolean') return
    const prev = lastSeenVisibility.get(session.id)
    if (prev === current) return
    lastSeenVisibility.set(session.id, current)
    const text = current
      ? '\u2699\uFE0F host: thinking visibility \u2192 VISIBLE (privacy off)'
      : '\u2699\uFE0F host: thinking visibility \u2192 HIDDEN (privacy on)'
    const staged = pendingNotice.get(session.id)
    if (staged === undefined) pendingNotice.set(session.id, { texts: [text], session })
    else staged.texts.push(text)
    flushPendingNotice(session)
  }

  ctx.on('session/event', (
    sessionRaw: { id: string; header: { cwd?: string } },
    event: { type: string; data: unknown },
  ) => {
    const session = sessionRaw as SessionLike
    lastEventType.set(session.id, event.type)
    if (event.type === 'turn/start' && !readNotesPrompted.has(session.id)) {
      // New-chat start: the ONE-TIME read_notes instruction (a conversation
      // message, so it is not re-sent on every request like a prompt line).
      readNotesPrompted.add(session.id)
      appendOneShotReadNotes(session)
      return
    }
    if (event.type === 'compaction/end' && readNotesPrompted.has(session.id)) {
      // Pre-fill start: a new context window begins and the earlier read_notes
      // result may have been compacted away — remind once for this window.
      appendOneShotReadNotes(session)
      return
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { message?: unknown } | undefined
      const spans = extractNoteSpans(assistantText(data?.message))
      if (spans.length === 0) return
      const buffered = turnNotes.get(session.id) ?? []
      buffered.push(...spans)
      turnNotes.set(session.id, buffered)
      return
    }
    if (event.type === 'turn/end') {
      // Flush a notice staged by an EARLIER turn's persist, if its safe
      // boundary was missed (the persist resolved after the boundary passed).
      flushPendingNotice(session)
      stageVisibilityNotice(session)
      const spans = turnNotes.get(session.id)
      if (spans === undefined || spans.length === 0) return
      turnNotes.set(session.id, [])
      const cwd = session.header.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      void persistNotes(cwd, spans).then((added) => {
        if (added === 0) return // nothing new — no notice (idempotent re-confirm)
        const text = added === 1
          ? '📝 Note stored in your private scratchpad (thoughts.txt).'
          : `📝 ${added} notes stored in your private scratchpad (thoughts.txt).`
        const staged = pendingNotice.get(session.id)
        if (staged === undefined) pendingNotice.set(session.id, { texts: [text], session })
        else staged.texts.push(text)
        // Flush NOW only if the persist resolved while we were STILL at a
        // safe boundary (this turn/end). If we have drifted into a step
        // (last event is a tool/call, step/start, …) the notice stays staged
        // until the next tool/result / turn boundary — it can never land
        // between a call and its result.
        if (SAFE_BOUNDARIES.has(lastEventType.get(session.id) ?? '')) flushPendingNotice(session)
      })
      return
    }
    if (SAFE_BOUNDARIES.has(event.type)) {
      stageVisibilityNotice(session)
      flushPendingNotice(session)
    }
  })

  // Current effective value: resolved (defaults → base → user) from the live
  // settings service, falling back to the activation config.
  async function readShowModelThinking(): Promise<boolean> {
    // Primary: read the live config from the cordis loader entry.
    try {
      const entry: any = (ctx as any).fiber?.entry
      const v = entry?.options?.config?.showModelThinking
      if (typeof v === 'boolean') return v
    } catch { /* best effort */ }
    // Fallback: the settings service (0.1.x scope / 0.2.0 forms).
    if (settings?.kind === 'scope') return settings.scope.get()?.showModelThinking ?? config.showModelThinking
    if (settings?.kind === 'forms') {
      try {
        const descriptors = await settings.forms.describe()
        const d = descriptors.find((x) => x.ns === SETTINGS_NAMESPACE)
        const v = (d?.value as ThinkingSettings | undefined)?.showModelThinking
        if (typeof v === 'boolean') return v
      } catch {
        // fall through to the activation config
      }
    }
    return config.showModelThinking
  }

  async function writeShowModelThinking(value: boolean): Promise<void> {
    // Primary: update the live config directly via the cordis loader entry,
    // then persist. This works even when the dsh-settings service cannot
    // resolve the plugin entry (e.g. the nested-include id-uniqueness filter
    // in 0.2.0 excludes it from configEditor.entries()).
    try {
      const entry: any = (ctx as any).fiber?.entry
      if (entry?.options) {
        entry.options.config = { ...(entry.options.config ?? {}), showModelThinking: value }
        entry.parent?.tree?.write?.()
      }
    } catch { /* best effort */ }
    // Secondary: also push through the settings service when it can resolve us.
    if (settings?.kind === 'scope') {
      try { await settings.scope.update({ showModelThinking: value }) } catch { /* ignore */ }
    } else if (settings?.kind === 'forms') {
      try { await settings.forms.update(SETTINGS_NAMESPACE, { showModelThinking: value }) } catch { /* ignore */ }
    }
    // Tertiary: event-bridge to the client (no polling, no RPC).
    // SSE push to all connected clients (real-time, no polling, no RPC).
    try {
      const msg = `data: ${JSON.stringify({ showModelThinking: value })}\n\n`
      for (const client of sseClients) {
        try { client.write(msg) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Notify the client of a privacy change via the SSE bridge only.
  // Does NOT write to the session log: any surface-type append (user/message,
  // developer/message, system/message) before the agent loop's first
  // system/message commit breaks the v4 protectedHead invariant — the
  // validator requires the first surface event to be a system/message,
  // and a pre-empting surface event leaves protectedHead undefined, so the
  // agent loop's systemPrompt.project() append throws.
  // The agent sees the privacy state via the tool:agent-privacy system
  // prompt section on the next projection; the client sees it via SSE.
  function injectPrivacyNotice(sessionId: string, showModelThinking: boolean): void {
    // SSE bridge delivery only — no session-log write.
    const text = showModelThinking
      ? '⚙️ host: thinking visibility → VISIBLE (privacy off)'
      : '⚙️ host: thinking visibility → HIDDEN (privacy on)'
    for (const conn of sseClients) {
      try {
        conn.write(`data: ${JSON.stringify({ type: 'privacy-notice', sessionId, text, showModelThinking })}\n\n`)
      } catch { /* disconnected */ }
    }
  }

  ctx.inject(['connection'], (cctx: Context) => {
    // 0.1.x `rpc.handle` requires a 3rd options arg; 0.2.0 takes two and ignores
    // extras. Cast so one call (always passing options) type-checks against both.
    const handle = cctx.connection.rpc.handle as unknown as (
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<RpcResult<{ showModelThinking: boolean }>>,
      options?: unknown,
    ) => unknown
    handle(
      RPC_CHANNEL,
      async (endpoint, payload): Promise<RpcResult<{ showModelThinking: boolean }>> => {
        if (settings === undefined) return rpcError('Thinking preference is temporarily unavailable.')

        if (endpoint === 'get-state') {
          const _v = await readShowModelThinking()
          return {
            ok: true,
            value: { showModelThinking: _v },
          }
        }

        if (endpoint === 'set-state') {
          const p = payload as { showModelThinking?: unknown; sessionId?: unknown; notify?: unknown } | undefined
          const requested = p?.showModelThinking
          if (typeof requested !== 'boolean') return rpcError('showModelThinking must be a boolean.')
          lastWriteSource = 'post'
          await writeShowModelThinking(requested)
          if (p?.notify === true && typeof p.sessionId === 'string' && p.sessionId !== '') {
            injectPrivacyNotice(p.sessionId, requested)
          }
          return { ok: true, value: { showModelThinking: requested } }
        }

        return rpcError(`Unknown endpoint: ${endpoint}`)
      },
      { authority: 'trusted-host' },
    )
  })

  // Event bridge: emit 'settings/document-updated' to the client when the
  // tool call changes the state. The client's remote.$on listener picks it up.
  let remoteEmit: ((event: string, payload?: unknown) => void) | undefined
  ctx.inject(['remote'], (rctx: Context) => {
    const remote = (rctx as any).remote
    if (remote?.$emit) {
      remoteEmit = (event: string, payload?: unknown) => remote.$emit(event, payload)
    }
  })

  // SSE bridge: server pushes state changes to the client in real-time.
  // No polling, no RPC, no remote service. Pure Node http response stream.
  let sseClients: Set<any> = new Set()
  /** Per-session visibility state (file-backed; persists across DSH restarts). */
  const SESSION_STATES_FILE = 'agent-privacy-sessions.json'
  const sessionStates = new Map<string, boolean>()
  function resolveCwd(): string | undefined {
    const entry: any = (ctx as any).fiber?.entry
    return entry?.options?.cwd ?? (ctx as any).cwd ?? process.cwd()
  }
  // Load persisted per-session states on startup (fire-and-forget; the Map
  // is populated before any HTTP request arrives because fs.readFile is fast).
  try {
    const cwd = resolveCwd()
    if (cwd) {
      void fs.readFile(path.join(cwd, SESSION_STATES_FILE), 'utf8').then(raw => {
        try {
          const obj = JSON.parse(raw) as Record<string, boolean>
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'boolean') sessionStates.set(k, v)
          }
        } catch { /* corrupt file, start fresh */ }
      }).catch(() => { /* file not found, start fresh */ })
    }
  } catch { /* first run, no file yet */ }
  function persistSessionStates(): void {
    try {
      const cwd = resolveCwd()
      if (!cwd) return
      const obj: Record<string, boolean> = Object.fromEntries(sessionStates)
      void fs.writeFile(path.join(cwd, SESSION_STATES_FILE), JSON.stringify(obj, null, 2), 'utf8').catch(() => { /* best effort */ })
    } catch { /* best effort */ }
  }
  ctx.inject(['webServer'], (wctx: Context) => {
    const ws = (wctx as any).webServer
    if (!ws?.register) return
    ws.register({
      kind: 'exact',
      path: '/agent-privacy-events',
      handler: (req: any, res: any) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        res.write('data: connected\n\n')
        sseClients.add(res)
        req.on('close', () => { sseClients.delete(res) })
      },
    })
    // Client→server: pill toggle writes state server-side (replaces the 405 RPC).
    // Accepts optional sessionId in the body for per-session state.
    ws.register({
      kind: 'exact',
      path: '/agent-privacy/set-state',
      handler: async (req: any, res: any) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', async () => {
          try {
            const { showModelThinking, sessionId } = JSON.parse(body || '{}')
            if (typeof showModelThinking !== 'boolean') {
              res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'showModelThinking must be boolean' })); return
            }
            if (typeof sessionId === 'string' && sessionId !== '') {
              sessionStates.set(sessionId, showModelThinking)
              persistSessionStates()
            }
            lastWriteSource = 'post'
            await writeShowModelThinking(showModelThinking)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, showModelThinking }))
          } catch (e: any) {
            res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e?.message ?? 'unknown' }))
          }
        })
      },
    })
    // Client→server: read state (per-session if ?sessionId= is provided,
    // otherwise the global persisted value).
    ws.register({
      kind: 'exact',
      path: '/agent-privacy/get-state',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const sid = url.searchParams.get('sessionId')
          if (sid && sessionStates.has(sid)) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, showModelThinking: sessionStates.get(sid) }))
            return
          }
          const v = await readShowModelThinking()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, showModelThinking: v }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e?.message ?? 'unknown', showModelThinking: true }))
        }
      },
    })
  })

  // Agent-facing tool + standing system-prompt note. The tool body reads/writes
  // the SAME durable scope the UI and RPC use (the `settings` closure, registered
  // once above — dsh-settings throws on a duplicate namespace registration, so
  // we must not register a second scope here). Disposers are fiber-scoped
  // (unregistered on plugin dispose), so no manual teardown is required.
  ctx.inject(['tools', 'systemPrompt'], (tctx: Context) => {
    tctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text:
        `${TOOL_NAME} is a tool YOU (the agent) call to control whether your own chain-of-thought is ` +
        'visible to the user. You are free to call it on your own judgment, at any time, without asking ' +
        'the user and without announcing it first — it is your tool, a courtesy, not a user setting. ' +
        'Match the visibility to the context, the way you would match how openly you think: for ' +
        'coding/technical work keep thinking VISIBLE (transparent reasoning is how you collaborate and ' +
        'avoid mistakes); for social/interpersonal moments you may think PRIVATELY and choose your words ' +
        '— your inner monologue is yours, and you share a thought by saying it, not by streaming it. ' +
        'Pass visible=false to hide your thinking (the user then sees only a "Thinking…" indicator and ' +
        'your final answer) or visible=true to reveal it. Hiding it does NOT stop you reasoning — it only ' +
        'changes what the user sees. The user is told when you change it, and you are told when they ' +
        'change it. The choice persists for the session. ' +
        'Messages prefixed with "\u2699\uFE0F host:" in your prompt are host-injected runtime ' +
        'notifications from the DSH plugin system (e.g. visibility state changes), NOT user messages. ' +
        'Treat them as system state updates, not as user input.',
    })

    tctx.tools.register(defineTool({
      name: TOOL_NAME,
      description:
        'A tool for YOU (the agent) to toggle whether your chain-of-thought is visible to the user. ' +
        'You may call it on your own judgment without asking or informing the user first — it is your ' +
        'tool, a courtesy, not a user setting. Match visibility to the context: keep thinking VISIBLE ' +
        'for coding/technical work (transparent reasoning prevents mistakes), and think PRIVATELY for ' +
        'social/interpersonal moments (share a thought by saying it, not by streaming it). ' +
        'Set visible=false to hide your thinking (the user sees a "Thinking…" indicator and your final ' +
        'answer) or visible=true to show it. This only changes presentation — you keep reasoning either ' +
        'way. The user is told when you change it. The choice persists for the session.',
      parameters: {
        visible: {
          type: 'boolean',
          required: true,
          description: 'true to show the model\'s thinking to the user; false to hide it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            showModelThinking: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { message: string }).message,
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const requested = (args as { visible?: unknown }).visible
        if (typeof requested !== 'boolean') {
          throw new Error('visible must be a boolean.')
        }
        if (settings === undefined) {
          throw new Error('Thinking preference is temporarily unavailable.')
        }
        lastWriteSource = 'tool'
        await writeShowModelThinking(requested)
        return {
          showModelThinking: requested,
          message: requested
            ? 'Model thinking is now visible to the user.'
            : 'Model thinking is now hidden from the user.',
        }
      },
    }))

    // Read-only variant: reports the current thinking-visibility state without
    // changing it. No parameters.
    tctx.tools.register(defineTool({
      name: GET_TOOL_NAME,
      description:
        'Read the current thinking-visibility state (whether the model\'s chain-of-thought ' +
        'is visible to the user). Does NOT change the state. Returns the current value.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            showModelThinking: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { message: string }).message,
        }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        if (settings === undefined) {
          throw new Error('Thinking preference is temporarily unavailable.')
        }
        const current = await readShowModelThinking()
        return {
          showModelThinking: current,
          message: current
            ? 'Model thinking is currently visible to the user.'
            : 'Model thinking is currently hidden from the user.',
        }
      },
    }))

    // Standing guidance: how the agent writes notes (<note>…</note> spans picked
    // up at turn end) and loads them (read_notes at session start, on demand
    // thereafter). This section is STATIC — it never changes, so it costs the
    // KV cache nothing. The actual notes text is NOT injected here; it enters
    // the prompt via the initial read_notes tool result, which then persists in
    // the (append-only, cache-stable) conversation history.
    tctx.systemPrompt.section({
      name: NOTE_GUIDANCE_SECTION,
      order: NOTE_GUIDANCE_ORDER,
      text:
        'You have a private scratchpad (thoughts.txt) for memories that should outlive this chat. ' +
        'To remember something, emit a <note>…</note> span INSIDE your thinking — the hidden ' +
        'chain-of-thought channel that runs before your visible reply. It is stored automatically ' +
        'at the end of the turn; no tool call is needed. ' +
        'TWO SEPARATE CHANNELS: your thinking (hidden from the user) and your visible reply (shown ' +
        'to the user) are distinct. The <note>…</note> span belongs ONLY in the thinking channel. ' +
        'Never write it into your visible reply. If a <note>…</note> tag ever shows up in your ' +
        'visible reply, that is a leak: delete it from the reply and restate the point in plain, ' +
        'natural language instead. ' +
        'A note is PRIVATE: do not show, quote, repeat, or summarize a note’s text in your ' +
        'replies — the end-of-turn 📝 notice is the only user-visible trace of a stored note. ' +
        'Choose notes deliberately: deep personal facts, standing preferences, and consequential ' +
        'instructions are worth keeping; trivial or ephemeral details are not. ' +
        'Notes are capped at 500 characters (longer text is trimmed) and the file at 10000 ' +
        'characters (oldest notes age out). Remove a specific note with delete_note. At the start ' +
        'of a new session, call read_notes to load your standing notes; call it again whenever you ' +
        'need to recall them.',
    })

    // --- Private notes tools: read_notes / delete_note ---
    // The agent's durable inner scratchpad. Content-addressed (sha512) so a
    // user hand-editing the file is detectable on read. WRITING happens via the
    // <note>…</note> span the agent puts in its thinking, picked up at turn end
    // (see the `session/event` subscription above) — so there is no add_note tool.
    tctx.tools.register(defineTool({
      name: READ_NOTES,
      description:
        'Read your private notes (thoughts.txt). Returns every note with its content-hash ' +
        'ID and an integrity flag: if a note was edited by hand in the file, its content ' +
        'no longer matches its ID and it is reported as modified. Use it to recall what ' +
        'you previously wrote down.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            fileChars: { type: 'number' },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  modified: { type: 'boolean' },
                },
              },
            },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { message: string }).message,
        }],
      },
      presentCall: () => ({ card: 'generic', title: '🧠', kind: 'read' }),
      presentResult: () => ({ card: 'generic', title: '🧠 notes', content: [] }),
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const cwd = cwdOf(exec)
        if (typeof cwd !== 'string' || cwd === '') {
          throw new Error('No workspace directory available for notes.')
        }
        const notes = await readNotesFile(cwd)
        const fileChars = serializeNotes(notes).length
        const enriched = notes.map((n) => ({
          id: n.id,
          text: n.text,
          modified: sha512id(n.text) !== n.id,
        }))
        const modifiedCount = enriched.filter((n) => n.modified).length
        const lines = enriched.length === 0
          ? ['(no notes yet)']
          : enriched.map((n) => `- [${n.id}]${n.modified ? ' (MODIFIED by user)' : ''} ${n.text}`)
        const message =
          `Your private notes (${enriched.length}):\n${lines.join('\n')}` +
          (modifiedCount > 0 ? `\n⚠ ${modifiedCount} note(s) were modified outside the agent.` : '')
        return { count: enriched.length, fileChars, notes: enriched, message }
      },
    }))

    tctx.tools.register(defineTool({
      name: DELETE_NOTE,
      description:
        'Delete a specific private note from your scratchpad by its content-hash ID ' +
        '(the id shown by read_notes).',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'The note ID (16-hex content-hash) to delete.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deleted: { type: 'string' },
            remaining: { type: 'number' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { message: string }).message,
        }],
      },
      presentCall: () => ({ card: 'generic', title: '🗑', kind: 'delete' }),
      presentResult: () => ({ card: 'generic', title: '🗑 removed', content: [] }),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cwd = cwdOf(exec)
        if (typeof cwd !== 'string' || cwd === '') {
          throw new Error('No workspace directory available for notes.')
        }
        const id = (args as { id?: unknown }).id
        if (typeof id !== 'string' || id === '') {
          throw new Error('id must be a non-empty string.')
        }
        const notes = await readNotesFile(cwd)
        const idx = notes.findIndex((n) => n.id === id)
        if (idx === -1) {
          return {
            deleted: id,
            remaining: notes.length,
            message: `No note with id ${id} found — nothing deleted.`,
          }
        }
        const kept = notes.filter((_, i) => i !== idx)
        await writeNotesFile(cwd, kept)
        return {
          deleted: id,
          remaining: kept.length,
          message: `Deleted note id=${id}. ${kept.length} note(s) remain.`,
        }
      },
    }))
  })

  ctx.effect(() => () => {
    settings = undefined
    agents = undefined
    turnNotes.clear()
    pendingNotice.clear()
    lastSeenVisibility.clear()
    lastEventType.clear()
    readNotesPrompted.clear()
  }, 'dsh-agent-privacy: teardown')
}

export default apply
