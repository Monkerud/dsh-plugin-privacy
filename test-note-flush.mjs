// Behavioral test: the <note> notice must NEVER land between a tool/call and
// its tool/result. Simulates the exact crash sequence from session 791dcdd7.
import { apply } from './lib/index.js'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function mkdtemp() {
  const d = path.join(tmpdir(), `dsh-ap-priv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(d, { recursive: true })
  return d
}
const cwd = await mkdtemp()

// logOrder: the true event sequence (agent-loop events + plugin-appended notices).
const logOrder = []
const notices = [] // the plugin-appended notice messages (with data)
const session = {
  id: 'test-session',
  header: { cwd },
  append(type, data, _intent) {
    logOrder.push({ type })
    if (type === 'user/message') notices.push(data)
    return { type, data, seq: logOrder.length }
  },
}

const handlers = {}
const ctx = {
  inject(_names, cb) {
    cb({
      settings: { describe: async () => [], update: async () => {} },
      agents: { get: () => undefined, list: () => [] },
      connection: { rpc: { handle: () => {} } },
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
    })
  },
  on(type, cb) { (handlers[type] ??= []).push(cb) },
  effect() {},
}
apply(ctx, { showModelThinking: false })

// emit an agent-loop event: records order AND drives the plugin observer.
const emit = (type, data = {}) => {
  logOrder.push({ type })
  for (const cb of handlers['session/event'] ?? []) cb(session, { type, data })
}
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

const noticeAt = () => logOrder.findIndex((e, i) => e.type === 'user/message' && /notes? stored/i.test(notices[i]?.content?.[0]?.text ?? ''))
// notices[] is indexed by position among user/messages; map to logOrder index:
function noticeIndices() {
  const out = []
  let n = 0
  for (let i = 0; i < logOrder.length; i++) if (logOrder[i].type === 'user/message') { if (/notes? stored/i.test(notices[n]?.content?.[0]?.text ?? '')) out.push(i); n++ }
  return out
}
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1 } else console.log(`ok: ${msg}`) }

// === Scenario A: the ORIGINAL CRASH — persist resolves MID-STEP of next turn ===
emit('turn/start')
emit('step/start')
emit('assistant/message', { message: { content: [
  { type: 'reasoning', text: 'remember <note>Restart the 3081 web server after the plugin change lands.</note>' },
] } })
emit('tool/call', { callId: 'call_1', name: 'edit' })
emit('tool/result', { message: { source: { callId: 'call_1' } } })
emit('step/end')
emit('turn/end')                       // persist starts (slow)
emit('turn/start')
emit('step/start')
emit('assistant/message', { message: { content: [{ type: 'text', text: 'continuing' }] } })
emit('tool/call', { callId: 'call_2', name: 'read' })
await tick()                           // persist resolves HERE — mid-step, before call_2's result
emit('tool/result', { message: { source: { callId: 'call_2' } } })   // safe boundary -> flush
await tick()
{
  const idxs = noticeIndices()
  assert(idxs.length === 1, 'A: exactly one notice appended')
  if (idxs.length === 1) {
    const i = idxs[0]
    // find call_2 / its result positions
    let call2 = -1, res2 = -1
    for (let k = 0; k < logOrder.length; k++) {
      if (logOrder[k].type === 'tool/call') call2 = k
      if (logOrder[k].type === 'tool/result') res2 = k
    }
    assert(i > res2, `A: notice (idx ${i}) lands AFTER the last tool/result (idx ${res2}) — not wedged`)
    assert(notices[0]?.id !== undefined && notices[0]?.source?.kind === 'user', 'A: notice has id + source (validator-safe)')
  }
}

// === Scenario B: fast persist — notice flushes right at the turn/end boundary ===
logOrder.length = 0; notices.length = 0
await writeFile(path.join(cwd, 'thoughts.txt'), '')
emit('turn/start')
emit('step/start')
emit('assistant/message', { message: { content: [
  { type: 'reasoning', text: '<note>A second distinct note long enough to survive the length filter.</note>' },
] } })
emit('step/end')
emit('turn/end')
await tick()
{
  const idxs = noticeIndices()
  assert(idxs.length === 1, 'B: notice appended for fast persist')
  if (idxs.length === 1) assert(logOrder[idxs[0] - 1]?.type === 'turn/end', 'B: notice lands immediately after turn/end (fast path)')
}

// === Scenario C: idle resolve — notice flushes at the turn/end boundary (last event is a safe boundary) ===
logOrder.length = 0; notices.length = 0
await writeFile(path.join(cwd, 'thoughts.txt'), '')
emit('turn/start')
emit('step/start')
emit('assistant/message', { message: { content: [
  { type: 'text', text: '<note>A third distinct note to exercise the idle-resolve flush path.</note>' },
] } })
emit('step/end')
emit('turn/end')
await tick()   // persist resolves while idle; last event was turn/end (safe) -> flushed
{
  const idxs = noticeIndices()
  assert(idxs.length === 1, 'C: notice appended on idle resolve at a safe boundary')
}

// === Invariant sweep over the whole final log: no notice strictly between a call and its result ===
{
  let ok = true
  const nIdx = noticeIndices()
  for (const i of nIdx) {
    let callBefore = -1
    for (let j = i - 1; j >= 0; j--) if (logOrder[j].type === 'tool/call') { callBefore = j; break }
    if (callBefore === -1) continue
    let resultAfter = -1
    for (let j = callBefore + 1; j < logOrder.length; j++) if (logOrder[j].type === 'tool/result') { resultAfter = j; break }
    if (resultAfter !== -1 && i > callBefore && i < resultAfter) { ok = false; console.error(`  wedged notice at ${i} between call ${callBefore} and result ${resultAfter}`) }
  }
  assert(ok, 'invariant: no notice is wedged between a tool/call and its tool/result')
}

// === One-shot read_notes reminder: once at first turn/start, again after compaction/end ===
logOrder.length = 0; notices.length = 0
{
  // Fresh session id: a "new chat" as far as the plugin's set is concerned.
  const session2 = {
    id: 'test-session-2',
    header: { cwd },
    append(type, data, _intent) {
      logOrder.push({ type })
      if (type === 'user/message') notices.push(data)
      return { type, data, seq: logOrder.length }
    },
  }
  const emit2 = (type, data = {}) => {
    logOrder.push({ type })
    for (const cb of handlers['session/event'] ?? []) cb(session2, { type, data })
  }
  const oneShots = () => {
    const out = []
    let n = 0
    for (let i = 0; i < logOrder.length; i++) if (logOrder[i].type === 'user/message') { if (/One-shot: call read_notes now/.test(notices[n]?.content?.[0]?.text ?? '')) out.push(i); n++ }
    return out
  }
  emit2('turn/start')      // new-chat start -> one-shot reminder
  await tick()
  assert(oneShots().length === 1, 'oneshot: reminder appended at first turn/start')
  assert(notices[0]?.id !== undefined && notices[0]?.source?.kind === 'user', 'oneshot: reminder has id + source (validator-safe)')
  emit2('turn/end')
  emit2('turn/start')      // second turn of the same session -> NO new reminder
  emit2('turn/end')
  assert(oneShots().length === 1, 'oneshot: no reminder on later turns of the same session')
  emit2('compaction/end')  // pre-fill start -> reminder again for the new window
  await tick()
  assert(oneShots().length === 2, 'oneshot: reminder re-lands after compaction/end (pre-fill)')
  const idx = oneShots()[1]
  assert(logOrder[idx - 1]?.type === 'compaction/end', 'oneshot: pre-fill reminder lands immediately after compaction/end')
}

await rm(cwd, { recursive: true, force: true })
console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED')
