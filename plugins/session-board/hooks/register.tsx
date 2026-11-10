import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, BoardSession, BoardSnapshot, Compose, Preview } from '../types'
import type { Filing } from './logic'
import { localSelfId, previewFromTranscript, readLocalSessions, transcriptNamedAfter } from './local'
import {
  AGENT_REPORT_PREFIX,
  AGENT_STALE_MS,
  agentSummary,
  ago,
  asAgentReport,
  asFiling,
  asLease,
  asShared,
  carryForward,
  COLUMN_COLORS,
  columnsOf,
  contextPercentOf,
  deliveryOf,
  EFFORTS,
  eventLimitFor,
  finishedSince,
  groupByWorkspace,
  isOpenableLink,
  isPermanentPreviewError,
  labelOf,
  leaseMs,
  matchesFilter,
  applyJudgement,
  judgePrompt,
  JUDGE_SYSTEM,
  judgeTargets,
  type Judged,
  byActivity,
  mergeSessions,
  modelLabel,
  nextUsage,
  parseJudgement,
  textKeyOf,
  modelOptions,
  needsDetail,
  nestedIds,
  nestingOf,
  normalize,
  previewTargets,
  pruneFiling,
  rateLimitsOf,
  REASON_LABELS,
  refreshMsOf,
  shouldLead,
  stepsOf,
  summaryFromMessages,
  summaryOf,
  textOf,
  toSession,
  usageOf,
  viewFor,
  workspaceOf,
  type RawSession,
} from './logic'

const VERSION = '0.25.0'
const PANE = 'session-board'
const SERVER = 'ccd_session_mgmt'
const DEBUG_TOOL = 'board_debug'
const DEFAULT_REFRESH_S = 3
const FIRST_REFRESH_MS = 1_500
const LIST_LIMIT = 100
const IDLE_PREVIEW = 8
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_MS = 120

const empty: BoardSnapshot = { sessions: [], usage: [], previews: {}, context: {}, agents: {}, refreshedAt: 0, error: null }
const snapshot = atom({ plugin: 'session-board', key: 'snapshot' } as const, empty)
const showAllIdle = atom({ plugin: 'session-board', key: 'showAllIdle' } as const, false)
const compose = atom({ plugin: 'session-board', key: 'compose' } as const, {} as Record<string, Compose>)
const filter = atom({ plugin: 'session-board', key: 'filter' } as const, '')
const dismissed = atom({ plugin: 'session-board', key: 'dismissed' } as const, {} as Record<string, string>)
const shelved = atom({ plugin: 'session-board', key: 'shelved' } as const, {} as Record<string, string>)
const collapsed = atom({ plugin: 'session-board', key: 'collapsed' } as const, {} as Record<string, boolean>)
const agentOpen = atom({ plugin: 'session-board', key: 'agentOpen' } as const, {} as Record<string, boolean>)
const showHelp = atom({ plugin: 'session-board', key: 'showHelp' } as const, false)
const tuneOpen = atom({ plugin: 'session-board', key: 'tuneOpen' } as const, {} as Record<string, boolean>)

type FilingKind = 'shelved' | 'dismissed'

// The state scanner wants a literal atom per call, so the two kinds are written out.
function setFilingState($: EngineInterface, kind: FilingKind, value: Filing): Promise<unknown> {
  return kind === 'shelved' ? update($, shelved, () => value) : update($, dismissed, () => value)
}

async function readFiling($: EngineInterface, kind: FilingKind): Promise<Filing> {
  try {
    return asFiling(await $.store.get(kind))
  } catch {
    return {}
  }
}

// Writes the filing to the shared store (read-modify-write) and mirrors it into this session's state.
async function file($: EngineInterface, kind: FilingKind, s: BoardSession): Promise<void> {
  const next = { ...(await readFiling($, kind)), [s.id]: s.lastActivityAt }
  try {
    await $.store.set(kind, next)
  } catch (err) {
    $.ui.toast(`Could not save: ${messageOf(err)}`)
  }
  await setFilingState($, kind, next)
}

// Every refresh takes the store as truth, so filing done in another session shows here within one period.
async function syncFiling($: EngineInterface, kind: FilingKind, sessions: BoardSession[]): Promise<void> {
  const stored = await readFiling($, kind)
  const pruned = pruneFiling(stored, sessions)
  if (Object.keys(pruned).length !== Object.keys(stored).length) {
    try {
      await $.store.set(kind, pruned)
    } catch {
      // the stale entries are harmless; they are dropped again next time
    }
  }
  await setFilingState($, kind, pruned)
}

// State holds JSON only, so a field set to undefined is dropped rather than written.
function setCompose($: EngineInterface, id: string, patch: Partial<Compose>): Promise<unknown> {
  return update($, compose, all => {
    const merged: Record<string, unknown> = { draft: '', ...all[id], ...patch }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    return { ...all, [id]: merged as Compose }
  })
}

let timer: Timer | undefined
let spinner: Timer | undefined
let autoOpen = true
let judgeOn = false
const JUDGE_MODEL = 'haiku'
const JUDGE_PER_RUN = 3
const JUDGED_KEPT = 60
// Which replies were sent this run, whatever came back: a failure is not paid for twice.
const judgeTried = new Set<string>()
const judgeStats = { calls: 0, failed: 0, yes: 0, inputTokens: 0, outputTokens: 0 }
let judging = false
let refreshMs = DEFAULT_REFRESH_S * 1000

// One timer advances every in-flight send's spinner frame; it stops itself once none is in flight.
function startSpinner($: EngineInterface): void {
  if (spinner) return
  spinner = $.clock.every(SPINNER_MS, async () => {
    const all = await read($, compose)
    const inFlight = Object.keys(all).filter(id => all[id]?.isSending)
    if (inFlight.length === 0) {
      spinner?.cancel()
      spinner = undefined
      return
    }
    await update($, compose, prev => {
      const next = { ...prev }
      for (const id of inFlight) {
        const c = next[id]
        if (c) next[id] = { ...c, frame: ((c.frame ?? 0) + 1) % SPINNER.length }
      }
      return next
    })
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function callText($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = textOf(result)
  if (result.isError) throw new Error(text || `${tool} failed`)
  return text
}

async function callJson($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return JSON.parse(await callText($, tool, args))
}

// Whether the desktop app's tools can act on this session: they exist here, and the session is the app's own.
function isAppSession(s: BoardSession): boolean {
  return s.id.startsWith('local_')
}

async function fetchPreview($: EngineInterface, s: BoardSession, cached: Preview | undefined): Promise<[string, Preview] | null> {
  try {
    // The raw transcript is read first where there is one: only it holds the question in a next-step box.
    // This session reads its own too, or the board it publishes would say it is not waiting for anyone.
    const path = s.transcript ?? (isAppSession(s) ? transcriptNamedAfter(s.id) : undefined)
    if (s.isSelf && !path) {
      const rows = await $.session.messages()
      const { task, answer } = summaryFromMessages(rows.slice(-40))
      return [s.id, carryForward({ at: s.lastActivityAt, text: answer, task, needsInput: false, textKey: '' }, cached, s.isRunning)]
    }
    if (path) {
      const { task, answer, needsInput, reason, question, lastRole, model, finalText } = await previewFromTranscript($, path)
      if (lastRole !== undefined || !appAvailable || !isAppSession(s)) {
        return [s.id, carryForward({ at: s.lastActivityAt, text: answer, task, needsInput, reason, textKey: finalText ? textKeyOf(finalText) : '', ...(question ? { question } : {}), ...(model ? { model } : {}) }, cached, s.isRunning)]
      }
    } else if (!appAvailable || !isAppSession(s)) {
      return [s.id, { at: s.lastActivityAt, needsInput: false, textKey: '' }]
    }
    const events = await callText($, 'list_events', { session_id: s.id, limit: eventLimitFor(s) })
    const { task, answer, needsInput, reason, question } = summaryOf(events)
    return [s.id, carryForward({ at: s.lastActivityAt, text: answer, task, needsInput, reason, textKey: '', ...(question ? { question } : {}) }, cached, s.isRunning)]
  } catch (err) {
    return isPermanentPreviewError(messageOf(err)) ? [s.id, { at: s.lastActivityAt, needsInput: false, textKey: '' }] : null
  }
}

function asJudged(raw: unknown): Record<string, Judged> {
  return raw && typeof raw === 'object' ? (raw as Record<string, Judged>) : {}
}

// One reply at a time, in the background: a slow answer must not hold the board up. The next poll shows the result.
async function judgeReplies($: EngineInterface, sessions: BoardSession[], previews: Record<string, Preview>, known: Record<string, Judged>, now: number): Promise<void> {
  const judged = { ...known }
  for (const s of judgeTargets(sessions, previews, judged, judgeTried, now).slice(0, JUDGE_PER_RUN)) {
    const key = previews[s.id]?.textKey ?? ''
    judgeTried.add(`${s.id}:${key}`)
    const path = s.transcript ?? (isAppSession(s) ? transcriptNamedAfter(s.id) : undefined)
    if (!path) continue
    try {
      const { finalText } = await previewFromTranscript($, path)
      if (!finalText || textKeyOf(finalText) !== key) continue // it moved on since the poll
      judgeStats.calls++
      const reply = await $.model.complete({ model: JUDGE_MODEL, system: JUDGE_SYSTEM, prompt: judgePrompt(finalText), effort: 'low', maxTokens: 80, timeoutMs: 20_000 })
      judgeStats.inputTokens += reply.usage?.input_tokens ?? 0
      judgeStats.outputTokens += reply.usage?.output_tokens ?? 0
      if (!reply.isAnswered) {
        judgeStats.failed++
        continue
      }
      const { needs, ask } = parseJudgement(reply.text)
      if (needs) judgeStats.yes++
      delete judged[s.id] // re-added last, so the oldest answers are the ones dropped
      judged[s.id] = { key, needs, ...(ask ? { ask } : {}) }
      const kept = Object.fromEntries(Object.entries(judged).slice(-JUDGED_KEPT))
      await $.store.set('judged', kept)
    } catch (err) {
      judgeStats.failed++
      $.ui.log(`session-board: could not judge a reply: ${messageOf(err)}`, { to: 'debug' })
    }
  }
}

let inFlight: Promise<void> | undefined
let myId: string | undefined
// Learned from the last call to the app's tools; absent on VS Code and the terminal.
let appAvailable = false
let role: 'leader' | 'follower' | 'unknown' = 'unknown'

// A forced refresh (the Refresh button) polls here, taking the lease if another session held it.
function refresh($: EngineInterface, force = false): Promise<void> {
  if (!inFlight) {
    inFlight = refreshOnce($, force).finally(() => {
      inFlight = undefined
    })
  }
  return inFlight
}

async function selfId($: EngineInterface): Promise<string | undefined> {
  if (myId && appAvailable) return myId
  try {
    myId = ((await callJson($, 'get_session', { session_id: 'self' })) as RawSession).sessionId
    appAvailable = true
  } catch {
    appAvailable = false
    myId = await localSelfId($)
  }
  return myId
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

// This session's own subagents, with the last written line of each, go to `agents:<my id>`.
async function reportAgents($: EngineInterface, now: number): Promise<void> {
  if (!myId) return
  let listed: { id: string; description: string; type: string; status: string }[]
  try {
    listed = await $.agent.list()
  } catch {
    return
  }
  const agents: AgentRow[] = []
  for (const a of listed) {
    let progress: string | undefined
    let steps: string[] = []
    try {
      const rows = await $.session.messages({ agentId: a.id })
      if (Array.isArray(rows)) {
        progress = summaryFromMessages(rows.slice(-30)).answer
        steps = stepsOf(rows.slice(-60))
      }
    } catch {
      progress = undefined
    }
    agents.push({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status,
      ...(progress ? { progress } : {}),
      ...(steps.length ? { steps } : {}),
    })
  }
  try {
    await $.store.set(`${AGENT_REPORT_PREFIX}${myId}`, { at: now, agents })
  } catch {
    // the board still shows everything else
  }
}

async function readAgents($: EngineInterface, now: number): Promise<Record<string, AgentRow[]>> {
  const out: Record<string, AgentRow[]> = {}
  let keys: string[]
  try {
    keys = await $.store.keys()
  } catch {
    return out
  }
  for (const key of keys) {
    if (!key.startsWith(AGENT_REPORT_PREFIX)) continue
    const report = asAgentReport(await storeGet($, key))
    if (report && now - report.at < AGENT_STALE_MS && report.agents.length > 0) out[key.slice(AGENT_REPORT_PREFIX.length)] = report.agents
  }
  return out
}

async function publish($: EngineInterface, next: BoardSnapshot, prev: BoardSnapshot): Promise<void> {
  const now = await $.clock.now()
  await reportAgents($, now)
  const { hasApp: _published, ...rest } = next
  next = { ...rest, ...(appAvailable ? {} : { hasApp: false }), agents: await readAgents($, now) }
  // Filing first: a card drawn from the new snapshot must already know where it is filed.
  await syncFiling($, 'shelved', next.sessions)
  await syncFiling($, 'dismissed', next.sessions)
  await update($, snapshot, () => next)
  if (prev.refreshedAt > 0) {
    for (const s of finishedSince(prev.sessions, next.sessions)) $.ui.toast(`Finished: ${s.title}`)
  }
}

async function refreshOnce($: EngineInterface, force: boolean): Promise<void> {
  const now = await $.clock.now()
  const prev = normalize(await read($, snapshot))
  const lease = force ? undefined : asLease(await storeGet($, 'lease'))
  // Who we are matters only when someone holds a lease; the poll below learns it anyway.
  const me = lease ? await selfId($) : myId

  if (me && lease && !shouldLead(lease, me, now, appAvailable, VERSION)) {
    const shared = asShared(await storeGet($, 'board'))
    if (shared && now - shared.refreshedAt < leaseMs(refreshMs)) {
      role = 'follower'
      const sessions = viewFor(shared, me)
      const own = sessions.find(s => s.isSelf)
      const previews = { ...shared.previews }
      // Only where the leader could not read this session: every board shows the same answer otherwise.
      if (own && previews[own.id]?.text === undefined) {
        const entry = await fetchPreview($, own, prev.previews[own.id])
        if (entry) previews[entry[0]] = entry[1]
      }
      await publish($, { ...shared, sessions, previews }, prev)
      return
    }
  }

  role = 'leader'
  await poll($, now, prev)
  if (myId) {
    try {
      await $.store.set('lease', { id: myId, until: now + leaseMs(refreshMs), version: VERSION, ...(appAvailable ? {} : { local: true }) })
    } catch {
      // without the lease others may poll too; harmless
    }
  }
}

async function poll($: EngineInterface, refreshedAt: number, prev: BoardSnapshot): Promise<void> {
  let local: BoardSession[] = []
  try {
    local = await readLocalSessions($, refreshedAt)
  } catch (err) {
    $.ui.log(`session-board: could not read local sessions: ${messageOf(err)}`, { to: 'debug' })
  }

  let listed: BoardSession[] | undefined
  let appError = ''
  try {
    listed = ((await callJson($, 'list_sessions', { limit: LIST_LIMIT })) as RawSession[]).map(raw => toSession(raw))
    appAvailable = true
  } catch (err) {
    appAvailable = false
    appError = messageOf(err)
  }
  // No app tools is normal off the desktop; it is an error only when nothing else can draw the board.
  if (!listed && local.length === 0) {
    await update($, snapshot, p => ({ ...normalize(p), refreshedAt, error: appError }))
    return
  }
  const merged = mergeSessions(listed, local)

  let self: BoardSession | undefined
  if (appAvailable) {
    try {
      const own = toSession((await callJson($, 'get_session', { session_id: 'self' })) as RawSession, true)
      myId = own.id
      // list_sessions leaves this session out, so it gains its transcript and date here.
      self = mergeSessions([own], local.filter(l => l.id === own.id))[0] ?? own
    } catch {
      self = undefined
    }
  } else {
    const me = await selfId($)
    const row = merged.find(s => s.id === me)
    self = row ? { ...row, isSelf: true } : undefined
  }

  let usage = prev.usage
  const context: Record<string, number> = {}
  if (appAvailable) {
    try {
      const own = await callJson($, 'get_usage', {})
      usage = nextUsage(usageOf(own), prev.usage)
      const ownContext = contextPercentOf(own)
      if (self && ownContext !== undefined) context[self.id] = ownContext
    } catch {
      usage = prev.usage
    }
  } else {
    try {
      const own = await $.session.usage()
      const windows = rateLimitsOf(own.rateLimits)
      if (windows.length > 0) usage = windows
      if (self && own.context.percent !== undefined) context[self.id] = Math.round(own.context.percent)
    } catch {
      usage = prev.usage
    }
  }

  const sessions = self ? [self, ...merged.filter(s => s.id !== self.id)].sort(byActivity) : merged
  await Promise.all(
    sessions.map(async (s, i) => {
      if (!appAvailable || !isAppSession(s) || !needsDetail(s, refreshedAt)) return
      try {
        const detail = toSession((await callJson($, 'get_session', { session_id: s.id })) as RawSession)
        sessions[i] = { ...s, model: detail.model, effort: detail.effort }
      } catch {
        // the card then shows no model controls
      }
    }),
  )
  await Promise.all(
    sessions
      .filter(s => appAvailable && isAppSession(s) && s.isRunning && !s.isSelf)
      .map(async s => {
        try {
          const percent = contextPercentOf(await callJson($, 'get_usage', { session_id: s.id }))
          if (percent !== undefined) context[s.id] = percent
        } catch {
          // a session whose process is gone reports nothing; the card just omits it
        }
      }),
  )
  const fetched = await Promise.all(previewTargets(sessions, prev.previews, refreshedAt).map(s => fetchPreview($, s, prev.previews[s.id])))
  const previews: Record<string, Preview> = {}
  for (const s of sessions) {
    const cached = prev.previews[s.id]
    if (cached) previews[s.id] = cached
  }
  for (const entry of fetched) {
    if (entry) previews[entry[0]] = entry[1]
  }
  if (judgeOn) {
    const judged = asJudged(await storeGet($, 'judged'))
    for (const id of Object.keys(previews)) previews[id] = applyJudgement(previews[id] as Preview, judged[id])
    if (!judging) {
      judging = true
      void judgeReplies($, sessions, previews, judged, refreshedAt).finally(() => {
        judging = false
      })
    }
  }

  const next: BoardSnapshot = { sessions, usage, previews, context, refreshedAt, error: null }
  try {
    await $.store.set('board', { ...next, sessions: sessions.map(s => ({ ...s, isSelf: false })) })
  } catch {
    // followers fall back to polling themselves once the board goes stale
  }
  await publish($, next, prev)
}

async function stop($: EngineInterface, s: BoardSession): Promise<void> {
  try {
    await callText($, 'stop_session', { session_id: s.id })
    $.ui.toast(`Stopped: ${s.title}`)
  } catch (err) {
    $.ui.toast(`Stop failed: ${messageOf(err)}`)
  }
  await refresh($)
}

// Shelving is the board's own filing: the card moves to Idle until the session has new activity. Nothing is archived.
function shelve($: EngineInterface, s: BoardSession): Promise<void> {
  return file($, 'shelved', s)
}

async function sendMessage($: EngineInterface, s: BoardSession, message: string): Promise<void> {
  const text = message.trim()
  if (!text) return
  if ((await read($, compose))[s.id]?.isSending) return
  const at = await $.clock.now()
  await setCompose($, s.id, { draft: text, isSending: true, frame: 0, status: undefined, tone: undefined })
  startSpinner($)
  if (!appAvailable || !isAppSession(s)) {
    await sendAsPeer($, s, text, at)
    await refresh($)
    return
  }
  let result: { content: { type: string; text?: string }[]; isError: boolean }
  try {
    result = await $.mcp.call(SERVER, 'send_message', { session_id: s.id, message: text })
  } catch (err) {
    await setCompose($, s.id, { draft: text, status: `Send failed: ${messageOf(err)}`, tone: 'error', at, isSending: false })
    $.ui.toast(`Send failed: ${messageOf(err)}`)
    return
  }
  const delivery = deliveryOf(textOf(result), result.isError)
  switch (delivery.state) {
    case 'delivered':
    case 'queued': {
      const status = delivery.state === 'delivered' ? 'Sent — the session started on it' : 'Sent — queued behind its current work'
      await setCompose($, s.id, { draft: '', status, tone: 'success', at, isSending: false })
      $.ui.toast(`${status}: ${s.title}`)
      break
    }
    case 'pending': {
      const status = "Delivered, but the session hasn't started on it within 20s — it may be waiting for your approval there. Open it; no need to resend."
      await setCompose($, s.id, { draft: '', status, tone: 'warning', at, isSending: false })
      $.ui.toast(`Not picked up yet: ${s.title}`)
      break
    }
    default: {
      const status = `Send failed: ${delivery.detail || 'send_message failed'}`
      await setCompose($, s.id, { draft: text, status, tone: 'error', at, isSending: false })
      $.ui.toast(status)
    }
  }
  await refresh($)
}

// Off the app's tools a message goes the way SendMessage does: it reaches the session as another session's, and starts a turn.
async function sendAsPeer($: EngineInterface, s: BoardSession, text: string, at: number): Promise<void> {
  let reason: string | undefined
  try {
    if (!s.peerId) throw new Error('this session is not running')
    const sent = await $.session.send({ to: { sessionId: s.peerId }, text })
    if (!sent.isDelivered) reason = sent.reason
  } catch (err) {
    reason = messageOf(err)
  }
  if (reason !== undefined) {
    await setCompose($, s.id, { draft: text, status: `Send failed: ${reason}`, tone: 'error', at, isSending: false })
    $.ui.toast(`Send failed: ${reason}`)
    return
  }
  const status = 'Sent as a message from another session — it starts a turn there'
  await setCompose($, s.id, { draft: '', status, tone: 'success', at, isSending: false })
  $.ui.toast(`${status}: ${s.title}`)
}

async function tune($: EngineInterface, s: BoardSession, what: 'model' | 'effort', value: string): Promise<void> {
  const tool = what === 'model' ? 'set_session_model' : 'set_session_effort'
  const label = what === 'model' ? 'Model' : 'Effort'
  try {
    const answer = await callText($, tool, { session_id: s.id, [what]: value })
    $.ui.toast(`${label} set to ${value}: ${s.title}${answer.trim() ? ` (${answer.trim().slice(0, 80)})` : ''}`)
  } catch (err) {
    $.ui.toast(`Could not set ${label.toLowerCase()}: ${messageOf(err)}`)
  }
  await refresh($)
}

async function openLink($: EngineInterface, link: string): Promise<{ exitCode: number; stderr: string }> {
  try {
    const opened = await $.process.run(['/usr/bin/open', link], { timeoutMs: 10_000 })
    if (opened.exitCode !== 127) return opened
  } catch {
    // no such program: not a Mac
  }
  return $.process.run(['xdg-open', link], { timeoutMs: 10_000 })
}

async function openSession($: EngineInterface, s: BoardSession): Promise<void> {
  if (!s.link || !isOpenableLink(s.link)) {
    $.ui.toast(`Cannot open: unexpected link (${s.link ?? 'none'})`)
    return
  }
  try {
    const { exitCode, stderr } = await openLink($, s.link)
    if (exitCode !== 0) $.ui.toast(`Open failed: ${stderr.trim() || `exit ${exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Open failed: ${messageOf(err)}`)
  }
}

async function isPaneOpen($: EngineInterface): Promise<boolean | null> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return null
  }
}

async function canRunProcess($: EngineInterface): Promise<boolean> {
  try {
    return (await $.process.run(['/usr/bin/true'], { timeoutMs: 5_000 })).exitCode === 0
  } catch {
    return false
  }
}

function startPolling($: EngineInterface, firstDelayMs = 0): void {
  timer?.cancel()
  if (firstDelayMs > 0) $.clock.after(firstDelayMs, () => void refresh($).catch(() => undefined))
  else void refresh($).catch(() => undefined)
  timer = $.clock.every(refreshMs, async () => {
    try {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (!isOpen) {
        timer?.cancel()
        timer = undefined
        return
      }
      await refresh($)
    } catch (err) {
      $.ui.log(`session-board: refresh failed: ${messageOf(err)}`, { to: 'debug' })
    }
  })
}

async function debugInfo($: EngineInterface) {
  const snap = normalize(await read($, snapshot))
  const now = await $.clock.now()
  const { running, needsMe, recent, idle } = columnsOf(snap.sessions, snap.refreshedAt, snap.previews, await read($, dismissed), await read($, shelved))
  const column = (s: BoardSession) =>
    running.includes(s) ? 'running' : needsMe.includes(s) ? 'needsMe' : recent.includes(s) ? 'recent' : idle.includes(s) ? 'idle' : '?'
  const previewChars: Record<string, number> = {}
  const taskChars: Record<string, number> = {}
  for (const [id, p] of Object.entries(snap.previews)) {
    previewChars[id] = p.text?.length ?? 0
    taskChars[id] = p.task?.length ?? 0
  }

  return {
    version: VERSION,
    judge: { enabled: judgeOn, ...judgeStats },
    hasApp: appAvailable,
    paneOpen: await isPaneOpen($),
    canRunProcess: await canRunProcess($),
    timerActive: timer !== undefined,
    spinnerActive: spinner !== undefined,
    now,
    refreshedAt: snap.refreshedAt,
    ageMs: snap.refreshedAt ? now - snap.refreshedAt : null,
    error: snap.error,
    filter: await read($, filter),
    autoOpen,
    refreshMs,
    role,
    myId: myId ?? null,
    leaseHolder: asLease(await storeGet($, 'lease'))?.id ?? null,
    sessions: snap.sessions.map(s => ({
      id: s.id,
      isRunning: s.isRunning,
      isSelf: s.isSelf,
      column: column(s),
      model: s.model ?? null,
      effort: s.effort ?? null,
      parentId: s.parentId ?? null,
    })),
    liveIds: snap.sessions.filter(s => s.peerId !== undefined).map(s => s.id),
    waiting: Object.fromEntries(snap.sessions.filter(s => s.waitingFor).map(s => [s.id, s.waitingFor])),
    usage: snap.usage,
    previewChars,
    taskChars,
    context: snap.context,
    agents: Object.fromEntries(Object.entries(snap.agents).map(([id, list]) => [id, list.map(a => ({ id: a.id, status: a.status, progressChars: a.progress?.length ?? 0 }))])),
    shelved: await read($, shelved),
    dismissed: await read($, dismissed),
  }
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false
  judgeOn = options.modelJudge === true
  refreshMs = refreshMsOf(options.refreshSeconds)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Open the session board: running / finished / idle sessions' })
    try {
      await $.tool.register({
        name: DEBUG_TOOL,
        description:
          'Read-only self-check of the session-board plugin: the session ids on the board, their columns, model and effort, usage, refresh time and preview lengths. Never transcript text.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
    } catch (err) {
      $.ui.log(`session-board: could not register board_debug: ${messageOf(err)}`)
    }
    const started = await next(e)

    try {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (!isOpen && autoOpen) await $.ui.open({ id: PANE, title: 'Sessions' })
      // The surface may place the pane only after the session has started, so polling never waits for isPlaced.
      if (isOpen || autoOpen) startPolling($, FIRST_REFRESH_MS)
    } catch (err) {
      $.ui.log(`session-board: could not open the board at start: ${messageOf(err)}`, { to: 'debug' })
    }

    return started
  })

  on('tool.call', { tool: `mcp__session-board__${DEBUG_TOOL}` }, async $ => ({
    result: JSON.stringify(await debugInfo($), null, 2),
  }))

  on('command.run', { command: 'board' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Sessions' })
    if (!opened.isPlaced) return { text: 'The session board could not be placed on this surface.' }
    startPolling($)

    return { text: 'Session board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const isTuneOpen = await read($, tuneOpen)
    const snap = normalize(await read($, snapshot))
    const hasApp = snap.hasApp !== false
    const isAllIdle = await read($, showAllIdle)
    const composing = await read($, compose)
    const query = await read($, filter)
    const dismissedAt = await read($, dismissed)
    const shelvedAt = await read($, shelved)
    // A pane drawn before polling started (opened at session start, placed later) starts it here.
    if (!timer) startPolling($, 200)
    const now = snap.refreshedAt
    const shown = snap.sessions.filter(s => matchesFilter(s, query))
    const hidden = snap.sessions.length - shown.length
    const columns = columnsOf(shown, now, snap.previews, dismissedAt, shelvedAt)
    const isCardOnTop = (s: BoardSession) => !columns.idle.includes(s)
    const children = nestingOf(shown, isCardOnTop)
    const nested = nestedIds(children)
    const onTop = (list: BoardSession[]) => list.filter(s => !nested.has(s.id))
    const running = onTop(columns.running)
    const needsMe = onTop(columns.needsMe)
    const recent = onTop(columns.recent)
    const idle = onTop(columns.idle)
    const isCollapsed = await read($, collapsed)
    const isAgentOpen = await read($, agentOpen)
    const isHelpOpen = await read($, showHelp)
    const isUsageHigh = snap.usage.some(w => w.percent >= 80)

    const seenTitles = new Set<string>()
    const sharedTitles = new Set<string>()
    for (const s of shown) {
      if (seenTitles.has(s.title)) sharedTitles.add(s.title)
      seenTitles.add(s.title)
    }

    const columnColorOf = (s: BoardSession) =>
      columns.running.includes(s)
        ? COLUMN_COLORS.running
        : columns.needsMe.includes(s)
          ? COLUMN_COLORS.needsMe
          : columns.idle.includes(s)
            ? COLUMN_COLORS.idle
            : COLUMN_COLORS.recent

    const agentColor = (status: string) =>
      status === 'running' || status === 'pending' || status === 'waiting'
        ? COLUMN_COLORS.running
        : status === 'completed'
          ? COLUMN_COLORS.recent
          : status === 'failed' || status === 'killed'
            ? 'error'
            : COLUMN_COLORS.idle

    const card = (s: BoardSession): JSX.Element => {
      const color = columnColorOf(s)
      const kids = children[s.id] ?? []
      const kidsNeedingMe = kids.filter(k => columns.needsMe.includes(k)).length
      const preview = snap.previews[s.id]?.text
      // A finished card's task is noise unless two cards share a title and it is what tells them apart.
      const task = s.isRunning || sharedTitles.has(s.title) ? snap.previews[s.id]?.task : undefined
      const context = s.isRunning ? snap.context[s.id] : undefined
      const note = composing[s.id]
      const textAt = snap.previews[s.id]?.textAt
      // What needs the app's tools shows only where they exist and for the app's own sessions.
      const canControl = hasApp && isAppSession(s) && !s.isSelf
      const canMessage = !s.isSelf && (canControl || s.peerId !== undefined)
      const isBoxOpen = canMessage && (note !== undefined ? note.isClosed !== true : columns.needsMe.includes(s))
      const model = s.model ?? snap.previews[s.id]?.model
      return (
        <Box
          key={`card-${s.id}`}
          flexDirection="column"
          gap="xs"
          borderStyle="round"
          borderColor={color}
          paddingX="sm"
          paddingY="xs"
        >
          <Box key={`head-${s.id}`} flexDirection="row" flexWrap="wrap" columnGap="sm" alignItems="center">
            <Box key={`title-${s.id}`} flexShrink={1}>
              <Text size="footnote" weight="semibold" wrap="truncate-end">
                <Text color={color}>● </Text>
                {s.isSelf ? 'This session · ' : ''}
                {s.title}
              </Text>
            </Box>
            {/* A tint under colored text; a terminal has no translucency, so there the color alone marks it. */}
            <Box key={`ago-${s.id}`} flexShrink={0} {...(isTerminal ? {} : { backgroundColor: `${color}26`, paddingX: 'xs' as const })}>
              <Text size="footnote" weight="semibold" color={color}>
                {ago(s.lastActivityAt, now)}
              </Text>
            </Box>
            {!canControl && model ? (
              <Box key={`tune-${s.id}`}>
                <Text size="caption" dimColor>
                  {modelLabel(model)}
                  {s.effort ? ` · ${labelOf(EFFORTS, s.effort)}` : ''}
                </Text>
              </Box>
            ) : null}
            {canControl && s.model ? (
              <Button
                key={`tune-${s.id}`}
                label={`${modelLabel(s.model)}${s.effort ? ` · ${labelOf(EFFORTS, s.effort)}` : ''} ${isTuneOpen[s.id] ? '▴' : '▾'}`}
                plain
                dimColor
                onPress={() => void update($, tuneOpen, all => ({ ...all, [s.id]: !all[s.id] }))}
              />
            ) : null}
            {canControl && s.model && isTuneOpen[s.id] ? (
              <Select
                key={`model-${s.id}`}
                options={modelOptions(s.model)}
                value={s.model}
                onSelect={value => void tune($, s, 'model', value)}
              />
            ) : null}
            {canControl && s.model && isTuneOpen[s.id] ? (
              <Select key={`effort-${s.id}`} options={EFFORTS} value={s.effort} onSelect={value => void tune($, s, 'effort', value)} />
            ) : null}
          </Box>
          <Box key={`meta-${s.id}`} flexDirection="row" flexWrap="wrap" columnGap="sm" alignItems="center">
            <Text size="caption" dimColor>
              {workspaceOf(s.cwd)}
              {s.group ? ` · ${s.group}` : ''}
              {s.isRemoteControlled ? ' · Remote Control' : ''}
            </Text>
            {context !== undefined ? (
              <Box key={`context-${s.id}`}>
                <Text size="caption" color={context >= 80 ? 'warning' : 'subtle'}>
                  Context {context}%
                </Text>
              </Box>
            ) : null}
            <Box key={`spacer-${s.id}`} flexGrow={1} />
            {!s.isSelf && s.link ? <Button key={`open-${s.id}`} label="Open" variant="primary" onPress={() => void openSession($, s)} /> : null}
            {canMessage ? (
              <Button
                key={`reply-${s.id}`}
                label={isBoxOpen ? 'Hide reply' : 'Reply'}
                variant="secondary"
                onPress={() => void setCompose($, s.id, { isClosed: isBoxOpen })}
              />
            ) : null}
            {canControl && s.isRunning ? <Button key={`stop-${s.id}`} label="Stop" variant="secondary" onPress={() => void stop($, s)} /> : null}
            {!s.isSelf && !s.isRunning ? <Button key={`shelve-${s.id}`} label="Move to Idle" variant="secondary" onPress={() => void shelve($, s)} /> : null}
          </Box>
          {columns.needsMe.includes(s) ? (
            <Box key={`needs-${s.id}`} flexDirection="row" flexWrap="wrap" columnGap="sm" alignItems="center">
              <Text size="caption" weight="semibold" color={COLUMN_COLORS.needsMe}>
                {snap.previews[s.id]?.question
                  ? `Asks: ${snap.previews[s.id]?.question}`
                  : s.waitingFor
                    ? `Waiting for you: ${s.waitingFor}`
                    : REASON_LABELS[snap.previews[s.id]?.reason ?? 'asked-question']}
              </Text>
              <Button key={`dismiss-${s.id}`} label="Dismiss" variant="secondary" onPress={() => void file($, 'dismissed', s)} />
            </Box>
          ) : null}
          {task ? (
            <Box key={`task-${s.id}`}>
              <Text size="caption" wrap="wrap">
                Task: {task}
              </Text>
            </Box>
          ) : null}
          {preview || s.isRunning ? (
            <Box key={`preview-${s.id}`}>
              <Text size="caption" wrap="wrap" dimColor={s.isRunning}>
                {s.isRunning ? `Progress${textAt ? ` (${ago(textAt, now)})` : ''}: ` : ''}
                {preview ?? 'Working — no written update yet'}
              </Text>
            </Box>
          ) : null}
          {isBoxOpen ? (
            <Box flexDirection="row" marginTop="xs">
              <Box flexGrow={1} minWidth={24}>
                <Input
                  key={`msg-${s.id}`}
                  placeholder="Message this session…"
                  submitLabel="Send"
                  value={note?.draft ?? ''}
                  onInput={value => void setCompose($, s.id, { draft: value })}
                  onSubmit={value => void sendMessage($, s, value)}
                />
              </Box>
            </Box>
          ) : null}
          {!s.isSelf && note?.isSending ? (
            <Box key={`sending-${s.id}`}>
              <Text size="caption" color="claude">
                {SPINNER[(note.frame ?? 0) % SPINNER.length]} Sending… (up to 20s while the session picks it up)
              </Text>
            </Box>
          ) : null}
          {!s.isSelf && !note?.isSending && note?.status ? (
            <Box key={`sent-${s.id}`}>
              <Text size="caption" color={note.tone ?? 'success'}>
                {note.status}
                {note.at ? ` · ${ago(new Date(note.at).toISOString(), now)}` : ''}
              </Text>
            </Box>
          ) : null}
          {kids.length > 0 ? (
            <Box key={`children-${s.id}`} flexDirection="column" gap="xs" marginTop="xs">
              <Box flexDirection="row" gap="sm" alignItems="center">
                <Button
                  key={`toggle-children-${s.id}`}
                  plain
                  label={`${isCollapsed[s.id] ? '▸' : '▾'} ${kids.length} sub-session${kids.length > 1 ? 's' : ''}`}
                  onPress={() => void update($, collapsed, all => ({ ...all, [s.id]: !all[s.id] }))}
                />
                {kidsNeedingMe > 0 ? (
                  <Box key={`children-needs-${s.id}`}>
                    <Text size="caption" weight="semibold" color={COLUMN_COLORS.needsMe}>
                      {kidsNeedingMe} need{kidsNeedingMe > 1 ? '' : 's'} you
                    </Text>
                  </Box>
                ) : null}
              </Box>
              {isCollapsed[s.id] ? null : kids.map(card)}
            </Box>
          ) : null}
          {(snap.agents[s.id] ?? []).length > 0 ? (
            <Box key={`agents-${s.id}`} flexDirection="column" marginTop="xs">
              <Button
                key={`toggle-agents-${s.id}`}
                plain
                label={`${isCollapsed[`agents:${s.id}`] ? '▸' : '▾'} ${agentSummary(snap.agents[s.id] ?? [])}`}
                onPress={() => void update($, collapsed, all => ({ ...all, [`agents:${s.id}`]: !all[`agents:${s.id}`] }))}
              />
              {isCollapsed[`agents:${s.id}`]
                ? null
                : (snap.agents[s.id] ?? []).map(a => (
                    <Box key={`agent-row-${a.id}`} flexDirection="column">
                      <Box flexDirection="row" columnGap="sm" alignItems="center">
                        <Box key={`agent-${a.id}`} flexShrink={1}>
                          <Text size="caption" wrap="truncate-end">
                            <Text color={agentColor(a.status)}>● </Text>
                            {a.description} · {a.status}
                            {a.progress ? ` — ${a.progress}` : ''}
                          </Text>
                        </Box>
                        {a.steps?.length ? (
                          <Button
                            key={`view-agent-${a.id}`}
                            label={isAgentOpen[a.id] ? 'Hide' : 'View'}
                            plain
                            onPress={() => void update($, agentOpen, all => ({ ...all, [a.id]: !all[a.id] }))}
                          />
                        ) : null}
                      </Box>
                      {isAgentOpen[a.id] && a.steps?.length ? (
                        <Box key={`agent-steps-${a.id}`} flexDirection="column" paddingLeft="md">
                          {a.steps.map((step, i) => (
                            <Text key={`step-${a.id}-${i}`} size="caption" dimColor wrap="truncate-end">
                              {step}
                            </Text>
                          ))}
                        </Box>
                      ) : null}
                    </Box>
                  ))}
            </Box>
          ) : null}
        </Box>
      )
    }

    const column = (title: string, color: string, list: BoardSession[]) =>
      list.length === 0 ? (
        <Box key={`col-${title}`} flexDirection="row" gap="sm" minWidth={20}>
          <Text weight="bold" color={color}>
            {title}
          </Text>
          <Text dimColor>None</Text>
        </Box>
      ) : (
        <Box key={`col-${title}`} flexDirection="column" flexGrow={1} minWidth={28} gap="md">
          <Text weight="bold" color={color}>
            {title}
          </Text>
          {list.map(card)}
        </Box>
      )

    const idleShown = isAllIdle ? idle : idle.slice(0, IDLE_PREVIEW)
    const idleGroups = groupByWorkspace(idleShown)
    const hasManyWorkspaces = groupByWorkspace(idle).length > 1

    const idleRow = (s: BoardSession) => (
      <Box key={`idle-${s.id}`} flexDirection="row" gap="sm" alignItems="center">
        {hasManyWorkspaces ? null : (
          <Text dimColor size="caption">
            {workspaceOf(s.cwd)}
          </Text>
        )}
        <Box key={`title-${s.id}`} flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={COLUMN_COLORS.idle}>● </Text>
            {s.title}
          </Text>
        </Box>
        <Text key={`ago-${s.id}`} size="caption" weight="semibold">
          {ago(s.lastActivityAt, now)}
        </Text>
        {s.link ? <Button key={`open-${s.id}`} label="Open" variant="primary" onPress={() => void openSession($, s)} /> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
          <Text weight="bold" size="heading">
            Session Board
          </Text>
          {snap.usage.length > 0 ? (
            <Box key="usage">
              <Text size="caption" color={isUsageHigh ? 'warning' : 'subtle'}>
                Usage {snap.usage.map(w => `${w.label} ${w.percent}%`).join(' · ')}
              </Text>
            </Box>
          ) : null}
          <Text dimColor size="caption">
            {now ? `Updated ${new Date(now).toLocaleTimeString()}` : 'Loading…'}
          </Text>
          <Button key="refresh" label="Refresh" variant="secondary" onPress={() => void refresh($, true)} />
          <Button key="help" label="?" variant="secondary" onPress={() => void update($, showHelp, v => !v)} />
          <Box flexGrow={1} minWidth={24}>
            <Input
              key="filter"
              placeholder="Filter by title or folder…"
              value={query}
              onInput={value => void update($, filter, () => value)}
              onSubmit={value => void update($, filter, () => value)}
            />
          </Box>
          {hidden > 0 ? (
            <Box key="filter-note">
              <Text dimColor size="caption">
                {hidden} hidden by filter
              </Text>
            </Box>
          ) : null}
        </Box>
        {isHelpOpen ? (
          <Box key="help-box" flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" paddingX="sm">
            <Text size="caption">
              <Text weight="semibold" color={COLUMN_COLORS.running}>Running</Text> — working now.{' '}
              <Text weight="semibold" color={COLUMN_COLORS.needsMe}>Needs me</Text> — it asked you something: in its next-step box, with a question tool, or in the last paragraph of its reply; or it says it is waiting for you, or has not started on your last message.{judgeOn ? ' A small model also reads replies with no question mark, to catch requests like “please review this”.' : ''}{' '}
              <Text weight="semibold" color={COLUMN_COLORS.recent}>Finished (24h)</Text> — idle, active in the last 24 hours.{' '}
              <Text weight="semibold" color={COLUMN_COLORS.idle}>Idle</Text> — older, or moved there with Move to Idle.
            </Text>
            <Text size="caption" dimColor>
              Click a title to open that session; the two selects next to it change its model and effort. Sub-sessions sit inside the card of the session that started them. Sessions from the desktop app, VS Code and the terminal all appear; Stop and the selects need the desktop app, so they show only there and only for its sessions. A message sent to a session starts a turn in it. A closed session can be opened but not messaged. A request with no question mark, like "please review the diff", does not count.
            </Text>
          </Box>
        ) : null}
        {snap.error ? <Text color="error">Could not load sessions: {snap.error}</Text> : null}
        <Box flexDirection="row" flexWrap="wrap" gap="md">
          {column('Running', COLUMN_COLORS.running, running)}
          {column('Needs me', COLUMN_COLORS.needsMe, needsMe)}
          {column('Finished (24h)', COLUMN_COLORS.recent, recent)}
        </Box>
        <Box flexDirection="column" gap="xs">
          <Text weight="bold" color={COLUMN_COLORS.idle}>
            Idle
          </Text>
          {idle.length === 0 ? <Text dimColor>None</Text> : null}
          {hasManyWorkspaces
            ? idleGroups.map(g => (
                <Box key={`ws-${g.workspace}`} flexDirection="column" gap="xs">
                  <Text size="caption" weight="semibold" dimColor>
                    {g.workspace} {g.sessions.length}
                  </Text>
                  {g.sessions.map(idleRow)}
                </Box>
              ))
            : idleShown.map(idleRow)}
          {idle.length > IDLE_PREVIEW ? (
            <Button
              key="toggle-idle"
              label={isAllIdle ? 'Show fewer' : `Show all ${idle.length}`}
              plain
              onPress={() => void update($, showAllIdle, v => !v)}
            />
          ) : null}
        </Box>
      </Box>
    )
  })
}

