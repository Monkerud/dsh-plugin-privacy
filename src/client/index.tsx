/**
 * dsh-agent-privacy (client) — in-chat privacy switch + settings row.
 * Independent evolution of easonz1989/dsh-hide-my-thinking.
 * Full credit: https://github.com/easonz1989/dsh-hide-my-thinking
 */
import type { Context } from '@deepseek-ai/cordis'
import { useState, useEffect, useSyncExternalStore } from 'react'

const NS = 'agent-privacy'
const CHANNEL = '/agent-privacy'

/** UI-only toast: brief visual confirmation of a visibility change.
 *  Not in the session log, not in the agent prompt. Purely cosmetic. */
let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showVisibilityToast(visible: boolean): void {
  const text = visible
    ? '\u{1F514} Thinking visible (privacy off)'
    : '\u{1F515} Thinking hidden (privacy on)'
  if (!toastEl || !toastEl.isConnected) {
    toastEl = document.createElement('div')
    toastEl.style.cssText = [
      'position:fixed', 'z-index:99999',
      'padding:6px 12px', 'border-radius:6px', 'font-size:12px',
      'font-family:system-ui,sans-serif', 'color:#fff',
      'background:rgba(30,30,30,0.92)', 'backdrop-filter:blur(8px)',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.25s ease',
      'white-space:nowrap',
    ].join(';')
    document.body.appendChild(toastEl)
  }
  // Position above the privacy pill if found, else top-center fallback.
  const pill = document.querySelector('.hmt-privacy') as HTMLElement | null
  if (pill) {
    const r = pill.getBoundingClientRect()
    toastEl.style.left = `${r.left + r.width / 2}px`
    toastEl.style.top = `${r.top - 8}px`
    toastEl.style.transform = 'translate(-50%, -100%)'
  } else {
    toastEl.style.left = '50%'
    toastEl.style.top = '24px'
    toastEl.style.transform = 'translateX(-50%)'
  }
  toastEl.textContent = text
  requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = '1' })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0'
    setTimeout(() => { if (toastEl && toastEl.isConnected) toastEl.remove(); toastEl = null }, 350)
  }, 2000)
}

interface PreferenceSnapshot {
  ready: boolean
  showModelThinking: boolean
  error: string
}

interface StateResponse {
  showModelThinking: boolean
}

const dictionaries = {
  zh: {
    title: '显示模型思考过程',
    description: '关闭时仅显示动态脑图标和“思考中…”，模型完成后直接显示正式回答。',
    show: '显示模型思考过程',
    thinking: '思考中…',
    unavailable: '暂时无法保存此设置。',
    privacy: '隐私',
    privacyOn: '思考已隐藏（隐私开启）',
    privacyOff: '思考可见（隐私关闭）',
  },
  en: {
    title: 'Model privacy',
    description: 'When model privacy is ON - you will only see a blue dot in chat when the agent is thinking - can also be turned ON/OFF in the chat-panel',
    show: 'Model privacy',
    thinking: 'Thinking…',
    unavailable: 'This setting could not be saved right now.',
    privacy: 'Privacy',
    privacyOn: 'Thinking hidden (privacy on)',
    privacyOff: 'Thinking visible (privacy off)',
  },
} as const

let snapshot: PreferenceSnapshot = { ready: false, showModelThinking: true, error: '' }
const listeners = new Set<() => void>()
let activeLabel = 'Thinking…'

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): PreferenceSnapshot {
  return snapshot
}

function publish(next: Partial<PreferenceSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  applyPresentation()
  for (const listener of listeners) listener()
}

function pushToServer(value: boolean, sessionId?: string): void {
  fetch('/agent-privacy/set-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showModelThinking: value, sessionId }),
  }).catch(() => { /* server offline, local state holds */ })
}

function syncReasoningAccessibility(showModelThinking: boolean): void {
  for (const row of document.querySelectorAll<HTMLElement>('[data-variant="think"]')) {
    const hidden = !showModelThinking
    const running = row.dataset['state'] === 'running'
    if (!hidden) {
      row.removeAttribute('aria-hidden')
      row.removeAttribute('aria-label')
      row.removeAttribute('aria-live')
      row.removeAttribute('role')
      for (const child of row.querySelectorAll<HTMLElement>('[data-hmt-original]')) {
        child.removeAttribute('aria-hidden')
        delete child.dataset['hmtOriginal']
      }
      continue
    }

    if (running) {
      row.removeAttribute('aria-hidden')
      row.setAttribute('role', 'status')
      row.setAttribute('aria-live', 'polite')
      row.setAttribute('aria-label', activeLabel)
    } else {
      row.setAttribute('aria-hidden', 'true')
      row.removeAttribute('aria-label')
      row.removeAttribute('aria-live')
      row.removeAttribute('role')
    }
    for (const child of Array.from(row.children)) {
      if (!(child instanceof HTMLElement)) continue
      child.dataset['hmtOriginal'] = 'true'
      child.setAttribute('aria-hidden', 'true')
    }
  }
}

function applyPresentation(): void {
  const root = document.documentElement
  root.dataset['dshShowModelThinking'] = String(snapshot.showModelThinking)
  root.style.setProperty('--dsh-hmt-thinking-label', JSON.stringify(activeLabel))
  syncReasoningAccessibility(snapshot.showModelThinking)
  console.log('[agent-privacy:client] applyPresentation: showModelThinking=', snapshot.showModelThinking, '; attr=', root.dataset['dshShowModelThinking'])
}

const styles = `
html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='ok']{display:none!important}
html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']{box-sizing:border-box;display:flex!important;flex-direction:row!important;justify-content:flex-start;align-items:center;gap:8px;min-height:24px;padding:2px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']>*{display:none!important}
html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:dsh-hmt-pulse 1.3s ease-in-out infinite}
html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']::after{content:var(--dsh-hmt-thinking-label,'Thinking…');color:var(--dsw-alias-label-tertiary);background:linear-gradient(90deg,var(--dsw-alias-label-tertiary) 20%,var(--dsw-alias-label-primary) 48%,var(--dsw-alias-label-tertiary) 76%);background-size:220% 100%;background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:dsh-hmt-text 1.7s linear infinite}
@keyframes dsh-hmt-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@keyframes dsh-hmt-text{0%{background-position:120% 0}100%{background-position:-120% 0}}
.hmt-row{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.hmt-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px;padding-right:28px}.hmt-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.hmt-description{max-width:560px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.hmt-switch{position:relative;flex:none;width:40px;height:22px;padding:0;border:0;border-radius:11px;background:var(--dsw-alias-bg-module-platform);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);cursor:pointer;transition:background .16s ease}.hmt-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .16s ease,background .16s ease}.hmt-switch[data-enabled='true']{background:var(--dsw-alias-button-primary-fill);box-shadow:none}.hmt-switch[data-enabled='true']::after{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}.hmt-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.hmt-switch:disabled{cursor:default;opacity:.45}.hmt-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.hmt-privacy{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;vertical-align:middle;cursor:pointer;transition:background .14s ease,color .14s ease}.hmt-privacy:hover{background:var(--dsw-alias-bg-module-hover);color:var(--dsw-alias-label-primary)}.hmt-privacy:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.hmt-privacy:disabled{cursor:default;opacity:.5}
.hmt-privacy .hmt-dot{width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-tertiary);box-shadow:inset 0 0 0 1.5px var(--dsw-alias-border-l3);transition:background .16s ease,box-shadow .16s ease;flex:none}
.hmt-privacy[data-on='true']{color:var(--dsw-alias-state-success-primary)}
.hmt-privacy[data-on='true'] .hmt-dot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}
@media(prefers-reduced-motion:reduce){html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']::before,html[data-dsh-show-model-thinking='false'] [data-variant='think'][data-state='running']::after{animation:none}}
/* Force the composer's control row onto a SINGLE line AND widen the card by
   10px on each side, so every item (including "Full access" and "Privacy")
   fits on one row without colliding. The no-wrap is what keeps "Full access"
   on the main row; the extra card width is what pays for it. Scoped to this
   plugin's <style> element, so it is fully reverted on uninstall. uV2eYG_*
   are the core composer's CSS-module classes (row / tools / trailing / card). */
.uV2eYG_row{flex-wrap:nowrap!important}
.uV2eYG_tools{display:flex;align-items:center}
.uV2eYG_trailing{min-width:0}
/* !important: the core conversation CSS declares an equal-specificity
   .uV2eYG_card{max-width:var(--dsh-composer-card-max-width)} and can land
   AFTER our injected <style>, silently winning the tie. !important keeps the
   widening regardless of style order. The base is
   calc(var(--dsh-chat-content-width) + 32px); we add 120px so the bottom
   panel is clearly wider than the chat column. */
.uV2eYG_card{max-width:calc(var(--dsh-composer-card-max-width) + 120px)!important}

`

interface RowProps {
  call: (endpoint: string, payload?: Record<string, unknown>) => Promise<unknown>
  t: (key: string) => string
}

function ThinkingPreferenceRow({ call, t }: RowProps) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [saving, setSaving] = useState(false)

  const toggle = () => {
    if (saving || !current.ready) return
    const next = !current.showModelThinking
    publish({ showModelThinking: next, error: '' })
    pushToServer(next)
    showVisibilityToast(next)
  }

  return (
    <div className="hmt-row">
      <div className="hmt-copy">
        <div className="hmt-title">{t('title')}</div>
        <div className="hmt-description">{t('description')}</div>
        {current.error !== '' && <div className="hmt-error" role="status">{current.error}</div>}
      </div>
      <button
        type="button"
        className="hmt-switch"
        role="switch"
        aria-label={t('show')}
        aria-checked={!current.showModelThinking}
        data-enabled={!current.showModelThinking}
        disabled={!current.ready || saving}
        onClick={() => { void toggle() }}
      />
    </div>
  )
}

/**
 * In-chat "Privacy" switch in the composer's left tool row (beside the
 * "Full access" access-mode chrome). Green = privacy ON (thinking hidden),
 * gray = privacy OFF (thinking visible). Toggling it also notifies the agent
 * via the server (which injects a user-role notice into its inbox).
 */
function ThinkingPrivacyComposerButton({ call, t, session }: RowProps & { session?: { sessionId?: string } }) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [saving, setSaving] = useState(false)
  const privacyOn = !current.showModelThinking
  const sessionId = session?.sessionId

  // Fetch per-session state on mount / session change.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    fetch(`/agent-privacy/get-state?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((data: { ok?: boolean; showModelThinking?: boolean }) => {
        if (cancelled) return
        if (typeof data.showModelThinking === 'boolean') {
          publish({ ready: true, showModelThinking: data.showModelThinking, error: '' })
        }
      })
      .catch(() => { /* server offline, local state holds */ })
    return () => { cancelled = true }
  }, [sessionId])

  const toggle = () => {
    if (saving || !current.ready) return
    const next = !current.showModelThinking
    publish({ showModelThinking: next, error: '' })
    pushToServer(next, sessionId)
    showVisibilityToast(next)
  }

  const hint = privacyOn ? t('privacyOn') : t('privacyOff')
  return (
    <button
      type="button"
      className="hmt-privacy"
      title={hint}
      aria-label={hint}
      data-on={privacyOn}
      disabled={!current.ready || saving}
      onClick={() => { void toggle() }}
    >
      <span className="hmt-dot" aria-hidden="true" />
      <span>{t('privacy')}</span>
    </button>
  )
}

export const name = 'dsh-agent-privacy'
export const inject = ['slots', 'locale', 'connection', 'remote']

export async function apply(ctx: Context): Promise<void> {
  const slots = ctx.get('slots') as
    | { inject(key: string, callback: () => unknown): unknown; register(options: unknown, component: unknown): unknown }
    | undefined
  const locale = ctx.get('locale') as
    | { bind(ns: string): (key: string) => string; register(ns: string, value: unknown): unknown }
    | undefined
  const connection = ctx.get('connection') as
    | { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
    | undefined
  const remote = ctx.get('remote') as
    | { $on(event: string, listener: (...args: unknown[]) => void): () => void }
    | undefined
  if (slots === undefined || locale === undefined || connection === undefined) return

  // Mark ready immediately so the toggle is interactive from the first render.
  // The per-session fetch (in the composer button) will refine the value.
  publish({ ready: true, showModelThinking: snapshot.showModelThinking, error: '' })

  const t = locale.bind(NS as never)
  const call = async (endpoint: string, payload: Record<string, unknown> = {}) => {
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (result.ok) return result.value
    throw new Error(result.error?.message ?? 'Thinking preference RPC failed')
  }

  const resync = (payload?: any) => {
    const value = payload?.showModelThinking ?? payload?.value?.showModelThinking
    publish({ ready: true, showModelThinking: typeof value === 'boolean' ? value : true, error: '' })
  }

  ctx.effect(() => {
    const dispose = locale.register(NS as never, dictionaries as never)
    return () => { if (typeof dispose === 'function') dispose() }
  }, 'dsh-agent-privacy: dictionaries')

  activeLabel = t('thinking')
  applyPresentation()

  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset['dshModelPrivacy'] = 'true'
    element.textContent = styles
    document.head.append(element)
    return () => { element.remove() }
  }, 'dsh-agent-privacy: styles')

  // No DOM hijack needed: the .hmt-host-note CSS class (injected below)
  // handles all styling. The :has() selector right-aligns the flowItem
  // wrapper without touching the DOM at runtime.

  ctx.effect(() => {
    const observer = new MutationObserver(() => {
      const nextLabel = t('thinking')
      if (nextLabel !== activeLabel) {
        activeLabel = nextLabel
        document.documentElement.style.setProperty('--dsh-hmt-thinking-label', JSON.stringify(activeLabel))
      }
      syncReasoningAccessibility(snapshot.showModelThinking)
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
    return () => { observer.disconnect() }
  }, 'dsh-agent-privacy: reasoning accessibility')

  // CSS-inject: restyle host-injected `⚙️ host:` message bubbles (centered,
  // smaller, grayed) so they are visually distinct from real user messages.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = [
      '.hmt-host-note {',
      '  font-size: 11px !important;',
      '  color: #888 !important;',
      '  background: transparent !important;',
      '  box-shadow: none !important;',
      '  padding: 2px 8px !important;',
      '  margin: 4px 0 !important;',
      '  max-width: 80% !important;',
      '  width: fit-content;',
      '}',
      // Hide host-note message blocks (bubble + metadata) without touching
      // sibling messages in the same flowItem.
      '[class*="Sixlwa_userRow"].hmt-host-note {',
      '  display: none !important;',
      '}',
      '[class*="ydEAna_root"].hmt-host-note {',
      '  display: none !important;',
      '}',
      '.hmt-host-note {',
      '  display: none !important;',
      '}',

    ].join('\n')
    document.head.appendChild(style)

    const HOST_PREFIX = '\u2699\uFE0F host:'
    function tagHostNotes(root: Node): void {
      const walk = (node: Node): void => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement
          const txt = el.textContent ?? ''
          // Only tag the innermost element that carries the host prefix.
          // Skip ancestors: if a child also starts with the prefix, this
          // element is a container, not the message itself.
          const childAlsoHas = Array.from(el.children).some(
            (c) => (c.textContent ?? '').startsWith(HOST_PREFIX)
          )
          if (
            txt.startsWith(HOST_PREFIX) &&
            !el.classList.contains('hmt-host-note') &&
            !childAlsoHas
          ) {
            // Scope guard: only tag elements inside the chat flow area,
            // skip the sidebar session list and header.
            if (!el.closest('[data-chat-flow-kind]')) return
            el.classList.add('hmt-host-note')
            // Hide the message block (bubble + metadata) without touching
            // sibling messages in the same flowItem.
            // UserStyleBubble-rendered notes: hide the userRow, but only
            // if the row's own text starts with the host prefix (not if
            // the row also contains an agent answer that mentions it).
            const row = el.closest('[class*="Sixlwa_userRow"]')
            if (row && (row.textContent ?? '').startsWith(HOST_PREFIX)) {
              row.classList.add('hmt-host-note')
            }
            // Markdown-rendered notes (read_notes etc): hide the ydEAna_root,
            // but only if the root's own text starts with the host prefix.
            const yd = el.closest('[class*="ydEAna_root"]') as HTMLElement | null
            if (yd && (yd.textContent ?? '').startsWith(HOST_PREFIX)) {
              yd.classList.add('hmt-host-note')
              yd.style.display = 'none'
            }
          }
        }
        for (const child of node.childNodes) walk(child)
      }
      walk(root)
    }
    tagHostNotes(document.body)
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) tagHostNotes(n)
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => { mo.disconnect(); style.remove() }
  }, 'dsh-agent-privacy: host-note CSS restyle')

  // Real-time, event-based resync via SSE: the server pushes state changes
  // through /agent-privacy-events. No polling, no RPC, no remote service.
  ctx.effect(() => {
    const es = new EventSource('/agent-privacy-events')
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (typeof data.showModelThinking === 'boolean') {
          publish({ ready: true, showModelThinking: data.showModelThinking, error: '' })
          showVisibilityToast(data.showModelThinking)
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => { /* EventSource auto-reconnects */ }
    return () => { es.close() }
  }, 'dsh-agent-privacy: SSE state bridge')

  // Settings → General row (durable preference).
  slots.inject('settings.general.item', () => slots.register({
    name: 'settings.general.item',
    id: 'show-model-thinking',
    order: 20,
    locale: NS as never,
    inject: () => ({ call, t }),
  }, ThinkingPreferenceRow))

  // In-chat "Privacy" switch: the composer's RIGHT/trailing group, alongside the
  // plugin-injected "Subagent Model" and "Voice" controls and the model-picker.
  // Living in the trailing group means it wraps TOGETHER with the main controls
  // when the composer is narrow, instead of stranding on its own row.
  slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'agent-privacy-thinking-visibility',
    order: 10,
    locale: NS as never,
    inject: () => ({ call, t }),
  }, ThinkingPrivacyComposerButton))

  ctx.effect(() => () => {
    syncReasoningAccessibility(true)
    delete document.documentElement.dataset['dshShowModelThinking']
    document.documentElement.style.removeProperty('--dsh-hmt-thinking-label')
    listeners.clear()
    snapshot = { ready: false, showModelThinking: true, error: '' }
  }, 'dsh-agent-privacy: presentation teardown')
}
