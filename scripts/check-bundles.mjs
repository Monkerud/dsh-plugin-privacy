import { readFile } from 'node:fs/promises'

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

for (const marker of [
  'window.__ModuleLoader__.load({',
  'id: "dsh-agent-privacy"',
  'settings.general.item',
  'show-model-thinking',
  // In-chat "Privacy" switch (right/trailing group, with the main controls).
  'conversation.input.right',
  'agent-privacy-thinking-visibility',
  'hmt-privacy',
  // SSE bridge: server pushes state changes via /agent-privacy-events.
  'agent-privacy-events',
  'EventSource',
  "data-variant='think'",
  "data-state='running'",
  "data-state='ok'",
  'dsh-hmt-pulse',
  'justify-content:flex-start',
  // Single-row composer: force no-wrap AND widen the card (clearly wider panel).
  'flex-wrap:nowrap',
  '--dsh-composer-card-max-width) + 120px',
  'aria-checked',
  'prefers-reduced-motion',
]) {
  if (!client.includes(marker)) throw new Error(`client bundle missing required marker: ${marker}`)
}

if (/^import\s/m.test(client)) {
  throw new Error('client bundle contains a top-level ESM import')
}

for (const marker of [
  '/agent-privacy',
  'agent-privacy-events',
  'showModelThinking',
  // 0.2.0 settings API: read via SettingsForms.describe, write via .update.
  'describe(',
  // Agent-facing tool + standing system-prompt note.
  'set_model_thinking_visibility',
  'get_model_thinking_visibility',
  'tool:agent-privacy',
  'tools.register',
  'systemPrompt.section',
  // Read-notes reminder and privacy notice are written as user/message in the
  // session log. The validator patch (dsh-session-format-v3-to-v4) retroactively
  // sets protectedHead when a system/message lands after a non-system head,
  // so these no longer corrupt the session log.
  'createUserMessage',
  'user/message',
  // SSE bridge for real-time GUI updates.
  'sseClients',
  // Private notes: content-addressed scratchpad (thoughts.txt).
  // Writing is the <note>…</note> span picked up at turn end (no add_note tool).
  // Reading is on-demand read_notes; the notes text enters the prompt via the
  // initial read_notes result (persisted in history), NOT a per-turn section.
  'read_notes',
  'delete_note',
  'thoughts.txt',
  'sha512',
  'agent-privacy:note-writing',
  'load your standing notes',
  // One-shot read_notes reminder (conversation message, NOT a prompt line):
  // once at first turn/start, and after each compaction/end (pre-fill).
  '⚙️ host: call read_notes now',
  'readNotesPrompted',
  // Event-based <note> pickup: one session/event subscription, no polling.
  // Notes persist to thoughts.txt; the "Note stored" notice is STAGED at
  // turn/end and flushed ONLY at safe boundaries (tool/result, turn/end,
  // turn/start, compaction/end) so it can never land between a tool/call
  // and its result.
  'session/event',
  'assistant/message',
  'Note stored',
  'flushPendingNotice',
  'SAFE_BOUNDARIES',
  // Compact UI presenters: note tools render as a single glyph, no args/body.
  'presentCall',
]) {
  if (!host.includes(marker)) throw new Error(`host bundle missing required marker: ${marker}`)
}

console.log('dsh-agent-privacy bundle contracts: pass')
