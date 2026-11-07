import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ago,
  asFiling,
  carryForward,
  COLUMN_COLORS,
  columnsOf,
  contextPercentOf,
  deliveryOf,
  finishedSince,
  groupByWorkspace,
  isPermanentPreviewError,
  matchesFilter,
  needsReasonOf,
  nestingOf,
  normalize,
  previewOf,
  previewTargets,
  pruneFiling,
  refreshMsOf,
  stepsOf,
  summaryFromMessages,
  summaryOf,
  unwrapCrossSession,
  usageOf,
  asLiveFile,
  displayTitle,
  isOpenableLink,
  liveToSession,
  mergeSessions,
  plainPreview,
  questionOf,
  rateLimitsOf,
  shouldLead,
  summaryFromTranscript,
  transcriptMeta,
} from '../hooks/logic'
import {
  EVENTS_ASKING,
  EVENTS_AWAITING,
  EVENTS_CROSS_SESSION,
  EVENTS_KEYWORD_ONLY,
  EVENTS_RESULT_ONLY,
  EVENTS_RUNNING,
  EVENTS_RUNNING_TOOLS_ONLY,
  EVENTS_UNAVAILABLE_ERROR,
  EVENTS_WITH_ANSWER,
  GET_SESSION_OTHER,
  GET_SESSION_SELF,
  GET_USAGE,
  GET_USAGE_CONTEXT_UNAVAILABLE,
  GET_USAGE_OTHER,
  LIST_SESSIONS,
  SEND_MESSAGE_QUEUED,
  SEND_MESSAGE_RESULT,
  SEND_MESSAGE_UNDELIVERED,
  SELF_MESSAGES,
  CHILD_SESSION,
  LIVE_DERIVED_NAME,
  LIVE_DESKTOP,
  LIVE_VSCODE,
  TRANSCRIPT_ASK_TOOL,
  TRANSCRIPT_ASKING,
  TRANSCRIPT_CODE_QUESTION,
  TRANSCRIPT_EARLIER_QUESTION,
  TRANSCRIPT_MID_PARAGRAPH,
  TRANSCRIPT_NEXT_STEP,
  TRANSCRIPT_NEXT_STEP_ANSWERED,
  TRANSCRIPT_RECAP_ONLY,
  TRANSCRIPT_DESKTOP,
  TRANSCRIPT_DONE,
  TRANSCRIPT_LOCAL_COMMAND,
  TRANSCRIPT_META_USER,
  TRANSCRIPT_NAMED,
  TRANSCRIPT_PARKED,
  TRANSCRIPT_SCRIPT,
  TRANSCRIPT_SIDECHAIN,
  TRANSCRIPT_TERMINAL,
  TRANSCRIPT_UNANSWERED,
} from './fixtures'

const NOW = Date.parse('2026-10-20T00:00:00Z')
const SELF = GET_SESSION_SELF.sessionId
const ANSWERED = 'local_f9f5129a-2c14-4c57-8834-5f6534747489'
const RECENT = 'local_d0516d05-fcfc-4019-9c4d-0402adf402dd'
const OLDEST = 'local_1dd9d8e2-15b6-468f-a2ff-a66263671296'
const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: 'Sessions',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
}

const ok = (body: unknown) => ({
  value: { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }], isError: false },
})
const fail = (body: string) => ({ value: { content: [{ type: 'text', text: body }], isError: true } })

type Raw = (typeof LIST_SESSIONS)[number]
type Patch = Partial<Raw>
// LIST_SESSIONS with some rows changed: running, made recent, moved to another folder, ...
const listWith = (patches: Record<string, Patch>) => ok(LIST_SESSIONS.map(s => ({ ...s, ...(patches[s.sessionId] ?? {}) })))
const RECENT_AT = '2026-10-19T21:00:00.000Z'

type Call = { tool: string; args: Record<string, unknown> }
const runs: string[][] = []
const toasts: string[] = []
const sends: { to: unknown; text: string }[] = []
// The machine as the local data source sees it: live session files, and transcripts by project folder.
type World = { live: unknown[]; dead?: number[]; projects: Record<string, Record<string, { text: string; mtimeMs: number }>>; me?: string; sendResult?: unknown; usage?: unknown }
let world: World = { live: [], projects: {} }
// What this session's own $.agent.list() returns, and each agent's own messages (absent: unreadable).
let ownAgents: { id: string; description: string; type: string; status: string; name?: string }[] = []
let agentMessages: Record<string, { role: 'user' | 'assistant'; text: string; toolUses: unknown[]; toolResults?: unknown[] }[]> = {}
type Overrides = Partial<Record<string, (args: Record<string, unknown>) => ReturnType<typeof ok>>>

function fakeServer(on: On, overrides: Overrides = {}): Call[] {
  const calls: Call[] = []
  runs.length = 0
  toasts.length = 0
  sends.length = 0
  world = { live: [], projects: {} }
  ownAgents = []
  agentMessages = {}
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [{ id: 'session-board', title: 'Sessions', isPlaced: true }] }) as never)
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const argv = e.argv
    if (argv[0]?.endsWith('/ps')) {
      const pids = (world.live as { pid: number }[]).map(f => f.pid).filter(p => !world.dead?.includes(p))
      return { value: { exitCode: pids.length ? 0 : 1, stdout: pids.join('\n'), stderr: '' } } as never
    }
    if (argv[0]?.endsWith('/tail') || argv[0]?.endsWith('/head')) {
      const path = String(argv.at(-1))
      const dir = path.split('/').at(-2) ?? ''
      const file = path.split('/').at(-1) ?? ''
      return { value: { exitCode: 0, stdout: world.projects[dir]?.[file]?.text ?? '', stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/me' : undefined }) as never)
  on('fs.list', ($, e) => {
    const path = (e as { path?: string }).path ?? ''
    const entry = (name: string, kind: string, size = 0, mtimeMs = 0) => ({ name, kind, size, mtimeMs, isLink: false })
    if (path === '/home/me/.claude/sessions') return { value: world.live.map(f => entry(`${(f as { pid: number }).pid}.json`, 'file')) } as never
    if (path === '/home/me/.claude/projects') return { value: Object.keys(world.projects).map(d => entry(d, 'dir')) } as never
    const dir = path.split('/').at(-1) ?? ''
    return { value: Object.entries(world.projects[dir] ?? {}).map(([name, t]) => entry(name, 'file', t.text.length, t.mtimeMs)) } as never
  })
  on('fs.read', ($, e) => {
    const name = String((e as { path: string }).path.split('/').at(-1))
    const f = (world.live as { pid: number }[]).find(l => `${l.pid}.json` === name)
    return { value: JSON.stringify(f ?? {}) } as never
  })
  on('fs.stat', ($, e) => {
    const parts = (e as { path: string }).path.split('/')
    const t = world.projects[parts.at(-2) ?? '']?.[parts.at(-1) ?? '']
    return { value: { kind: 'file', size: t?.text.length ?? 0, mtimeMs: t?.mtimeMs ?? 0, isLink: false } } as never
  })
  on('session.id', () => ({ value: world.me ?? 'ffffffff-0000-4000-8000-000000000000' }) as never)
  on('session.send', ($, e) => {
    sends.push({ to: e.to, text: e.text })
    return (world.sendResult ?? { isDelivered: true }) as never
  })
  on('session.usage', () => ({ value: world.usage ?? { startedAt: 0, context: { window: 1, percent: 12 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 8 }] } }) as never)
  on('session.messages', ($, e) => {
    const agentId = (e as { agentId?: string }).agentId
    if (agentId === undefined) return { value: SELF_MESSAGES } as never
    const rows = agentMessages[agentId]
    return { value: rows ?? { deny: `cannot read ${agentId}` } } as never
  })
  on('agent.list', () => ({ value: ownAgents }) as never)
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const override = overrides[e.tool]
    if (override) return override(e.args)
    switch (e.tool) {
      case 'list_sessions':
        return ok(LIST_SESSIONS)
      case 'get_session':
        return ok(e.args.session_id === 'self' ? GET_SESSION_SELF : { ...GET_SESSION_OTHER, sessionId: e.args.session_id })
      case 'get_usage':
        return ok(e.args.session_id === undefined ? GET_USAGE : GET_USAGE_OTHER)
      case 'list_events':
        return ok(e.args.session_id === ANSWERED ? EVENTS_WITH_ANSWER : EVENTS_RESULT_ONLY)
      case 'send_message':
        return ok(SEND_MESSAGE_RESULT)
      default:
        return ok('done')
    }
  })
  return calls
}

// The desktop draws a Link whose href is not https: as plain text, and a passing test hides that warning.
async function expectLinksClickable(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) {
  for (const link of await ui.findAll({ type: 'Link' })) {
    expect(String(link.props.href)).toMatch(/^https:/)
  }
}

// Fixed chrome (buttons, select labels, placeholders) is English; user content (titles, previews) is whatever it is.
async function expectChromeEnglish(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) {
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/
  for (const el of await ui.findAll({ type: 'Button' })) {
    expect(String(el.props.label)).not.toMatch(cjk)
  }
  for (const el of await ui.findAll({ type: 'Select' })) {
    expect(String(el.props.label ?? '')).not.toMatch(cjk)
    for (const o of el.props.options as { label?: string }[]) expect(String(o.label ?? '')).not.toMatch(cjk)
  }
  for (const el of await ui.findAll({ type: 'Input' })) {
    expect(String(el.props.placeholder ?? '')).not.toMatch(cjk)
    expect(String(el.props.submitLabel ?? '')).not.toMatch(cjk)
  }
}

// find() matches substrings outermost-first, so a header is looked up among Text elements by exact text.
async function header(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }, text: string) {
  return (await ui.findAll({ type: 'Text' })).find(t => t.text === text)
}

const count = (calls: Call[], tool: string) => calls.filter(c => c.tool === tool).length
const askedOf = (calls: Call[], tool: string) => calls.filter(c => c.tool === tool).map(c => c.args.session_id)

type Engine = Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[0]
const mountOn = (surface: (typeof SURFACES)[number]) => ($: Engine) =>
  $.ui.mount({ plugin: 'session-board', surface, component: 'Pane', props: PANE_PROPS, requestId: 'session-board' })

// L3: parsing on responses captured from the real tools

test('usageOf reads the 5-hour and weekly windows from the real get_usage', () => {
  expect(usageOf(GET_USAGE)).toEqual([
    { label: '5h', percent: 5, resetsIn: '4h 33m' },
    { label: 'Weekly', percent: 1, resetsIn: '3d 8h' },
  ])
  expect(usageOf({ plan: { status: 'not_applicable' } })).toEqual([])
  expect(usageOf(null)).toEqual([])
})

test('previewOf takes the last assistant answer, skipping tool-call stubs', () => {
  const preview = previewOf(EVENTS_WITH_ANSWER)
  expect(preview?.startsWith('测试服务的告警已解除，运行恢复正常。 之前触发原因')).toBe(true)
  expect(previewOf(EVENTS_RESULT_ONLY)).toBeUndefined()
  expect(previewOf('[assistant] (called Bash)')).toBeUndefined()
  const long = previewOf(`[assistant] ${'很长'.repeat(200)}`)
  expect(long?.length).toBe(140)
  expect(long?.endsWith('…')).toBe(true)
})

test('columnsOf on the real list: one recent, five idle', () => {
  const sessions = normalize({ sessions: LIST_SESSIONS.map(r => ({ id: r.sessionId, title: r.title, cwd: r.cwd, isRunning: r.isRunning, isSelf: false, lastActivityAt: r.lastActivityAt })) }).sessions
  const { running, needsMe, recent, idle } = columnsOf(sessions, NOW)
  expect(running).toHaveLength(0)
  expect(needsMe).toHaveLength(0)
  expect(recent.map(s => s.id)).toEqual([RECENT])
  expect(idle).toHaveLength(5)
})

test('isPermanentPreviewError matches the real cleaned-up transcript error only', () => {
  expect(isPermanentPreviewError(EVENTS_UNAVAILABLE_ERROR)).toBe(true)
  expect(isPermanentPreviewError('boom')).toBe(false)
  expect(isPermanentPreviewError('server not connected')).toBe(false)
})

test('summaryOf reads the task from the last user line and the progress from the last assistant text', () => {
  const running = summaryOf(EVENTS_RUNNING)
  expect(running.task?.startsWith('从之前的的测试上来看')).toBe(true)
  expect(running.task?.length).toBeLessThanOrEqual(140)
  expect(running.answer).toBe('我先看一下仓库里文档系统的代码结构和现有文档，再评估它是否满足"通用文档平台"的要求。')
  expect(summaryOf(EVENTS_RUNNING_TOOLS_ONLY).task).toBeUndefined()
  expect(summaryOf(EVENTS_RUNNING_TOOLS_ONLY).answer).toBeUndefined()
  expect(summaryOf(EVENTS_WITH_ANSWER).task).toBeUndefined()
})

test('contextPercentOf reads the context window of the real get_usage, undefined when unavailable', () => {
  expect(contextPercentOf(GET_USAGE)).toBe(16)
  expect(contextPercentOf(GET_USAGE_OTHER)).toBe(14)
  expect(contextPercentOf(GET_USAGE_CONTEXT_UNAVAILABLE)).toBeUndefined()
  expect(contextPercentOf(null)).toBeUndefined()
})

test('finishedSince lists sessions that stopped running, never self', () => {
  const mk = (id: string, isRunning: boolean, isSelf = false) => ({ id, title: id, cwd: '', isRunning, isSelf, lastActivityAt: '', isRemoteControlled: false })
  const prev = [mk('self', true, true), mk('a', true), mk('b', true), mk('c', false)]
  const next = [mk('self', false, true), mk('a', false), mk('b', true), mk('c', false)]
  expect(finishedSince(prev, next).map(s => s.id)).toEqual(['a'])
})

test('a cross-session message is shown as who sent it, not the wrapper tag; user text is kept as written', () => {
  expect(summaryOf(EVENTS_CROSS_SESSION).task).toBe('From Session 可视化管理插件: 你觉得这些备份可以删除吗')
  expect(unwrapCrossSession('<cross-session-message from="local_x">hi</cross-session-message>')).toBe('From another session: hi')
  expect(unwrapCrossSession('plain text')).toBe('plain text')
})

test('needs-me reasons: parked on a question tool, a user message never started on, an answer ending in ?; a keyword alone is not enough', () => {
  expect(summaryOf(EVENTS_AWAITING)).toMatchObject({ needsInput: true, reason: 'awaiting-answer' })
  expect(summaryOf(EVENTS_CROSS_SESSION)).toMatchObject({ lastRole: 'user', needsInput: true, reason: 'not-picked-up' })
  expect(summaryOf(EVENTS_ASKING)).toMatchObject({ lastRole: 'assistant', needsInput: true, reason: 'asked-question' })
  expect(summaryOf(EVENTS_WITH_ANSWER)).toMatchObject({ needsInput: false })
  expect(summaryOf(EVENTS_KEYWORD_ONLY)).toMatchObject({ needsInput: false })
  expect(summaryOf(EVENTS_RESULT_ONLY)).toMatchObject({ lastRole: 'result', needsInput: false })
  expect(summaryOf(EVENTS_RUNNING_TOOLS_ONLY).needsInput).toBe(false)
  expect(needsReasonOf({ role: 'assistant', text: 'Done. Should I also archive the other two?' })).toBe('asked-question')
  expect(needsReasonOf({ role: 'assistant', text: 'Let me know which account to use.' })).toBeUndefined()
  expect(needsReasonOf({ role: 'assistant', text: '(called ExitPlanMode)' })).toBe('awaiting-answer')
  expect(needsReasonOf({ role: 'assistant', text: '(called Bash)' })).toBeUndefined()
  expect(needsReasonOf(undefined)).toBeUndefined()
})

test('deliveryOf tells delivered, queued, pending (undelivered but kept) and failed apart', () => {
  expect(deliveryOf(SEND_MESSAGE_RESULT, false).state).toBe('delivered')
  expect(deliveryOf(SEND_MESSAGE_QUEUED, false).state).toBe('queued')
  expect(deliveryOf(SEND_MESSAGE_UNDELIVERED, true).state).toBe('pending')
  expect(deliveryOf('target session is archived', true).state).toBe('failed')
  expect(deliveryOf('(delivery: undelivered; message_id: x)', true).state).toBe('failed')
})

test('ago speaks English at every scale', () => {
  expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now')
  expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago')
  expect(ago(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h ago')
  expect(ago(new Date(NOW - 50 * 3600_000).toISOString(), NOW)).toBe('2d ago')
  expect(ago('', NOW)).toBe('')
})

test('matchesFilter looks at title, folder and group, case-insensitively; blank matches all', () => {
  const s = { id: 'x', title: '帮我结束测试服务的告警', cwd: '/Users/me/project', group: 'Work', isRunning: false, isSelf: false, lastActivityAt: '', isRemoteControlled: false }
  expect(matchesFilter(s, '')).toBe(true)
  expect(matchesFilter(s, '  ')).toBe(true)
  expect(matchesFilter(s, '测试服务')).toBe(true)
  expect(matchesFilter(s, 'project')).toBe(true)
  expect(matchesFilter(s, 'work')).toBe(true)
  expect(matchesFilter(s, 'nope')).toBe(false)
})

test('groupByWorkspace keeps order and groups by the last path segment', () => {
  const mk = (id: string, cwd: string) => ({ id, title: id, cwd, isRunning: false, isSelf: false, lastActivityAt: '', isRemoteControlled: false })
  const groups = groupByWorkspace([mk('a', '/x/alpha'), mk('b', '/y/beta'), mk('c', '/z/alpha')])
  expect(groups.map(g => g.workspace)).toEqual(['alpha', 'beta'])
  expect(groups[0]?.sessions.map(s => s.id)).toEqual(['a', 'c'])
})

test('asFiling keeps only string entries; pruneFiling drops unlisted or moved sessions', () => {
  expect(asFiling(undefined)).toEqual({})
  expect(asFiling({ a: '2026-10-19T00:00:00Z', b: 3, c: null })).toEqual({ a: '2026-10-19T00:00:00Z' })
  const mk = (id: string, at: string) => ({ id, title: id, cwd: '', isRunning: false, isSelf: false, lastActivityAt: at, isRemoteControlled: false })
  const filing = { a: 't1', b: 't1', gone: 't1' }
  expect(pruneFiling(filing, [mk('a', 't1'), mk('b', 't2')])).toEqual({ a: 't1' })
})

test('summaryFromMessages takes the last written assistant text and the last typed user message, skipping tool rows', () => {
  const summary = summaryFromMessages(SELF_MESSAGES as never)
  expect(summary.answer).toBe('明白：运行中的卡片要始终有 Progress 一行。')
  expect(summary.task).toBe('我想让progress一直在active的session的card里面')
  expect(summary.needsInput).toBe(false)
  expect(summaryFromMessages([])).toEqual({ task: undefined, answer: undefined, needsInput: false })
})

test('nestingOf nests under a card parent (also through a nested parent), never under an idle or missing one, and survives a cycle', () => {
  const mk = (id: string, parentId?: string) => ({ id, title: id, cwd: '', isRunning: false, isSelf: false, lastActivityAt: '', isRemoteControlled: false, parentId })
  const cardIds = new Set(['p', 'c', 'g'])
  const all = [mk('p'), mk('c', 'p'), mk('g', 'c'), mk('idleParent'), mk('orphan', 'idleParent'), mk('lost', 'gone'), mk('x', 'y'), mk('y', 'x')]
  const kids = nestingOf(all, s => cardIds.has(s.id))
  expect(kids.p?.map(s => s.id)).toEqual(['c'])
  expect(kids.c?.map(s => s.id)).toEqual(['g'])
  expect(kids.idleParent).toBeUndefined()
  expect(Object.values(kids).flat().map(s => s.id)).not.toContain('lost')
  expect(Object.values(kids).flat().map(s => s.id)).not.toContain('x')
})

test('carryForward stamps when the progress text first appeared, and keeps that time while the text is unchanged', () => {
  const first = carryForward({ at: 't1', text: 'a' }, undefined, true)
  expect(first.textAt).toBe('t1')
  const same = carryForward({ at: 't2', text: 'a' }, first, true)
  expect(same.textAt).toBe('t1')
  const carried = carryForward({ at: 't3' }, same, true)
  expect(carried).toMatchObject({ text: 'a', textAt: 't1' })
  const changed = carryForward({ at: 't4', text: 'b' }, carried, true)
  expect(changed.textAt).toBe('t4')
})

test('stepsOf turns an agent transcript into one line per step: task, words, tool calls with their target, errors; last 15 only', () => {
  const rows = [
    { role: 'user', text: 'Check the docs for wrong flags', toolUses: [] },
    { role: 'assistant', text: 'I will read the overview first.', toolUses: [{ id: 't1', tool: 'Read', input: { file_path: '/repo/docs/overview.md' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'file body', isError: false }] },
    { role: 'assistant', text: '', toolUses: [{ id: 't2', tool: 'Bash', input: { command: 'grep -n report-dir scripts/x.py' }, isError: true }] },
    { role: 'assistant', text: '', toolUses: [{ id: 't3', tool: 'Grep', input: { pattern: 'argparse' } }, { id: 't4', tool: 'TodoWrite', input: {} }] },
  ]
  expect(stepsOf(rows as never)).toEqual([
    'Task: Check the docs for wrong flags',
    'Said: I will read the overview first.',
    'Read: /repo/docs/overview.md',
    'Bash: grep -n report-dir scripts/x.py (error)',
    'Grep: argparse',
    'TodoWrite',
  ])
  const many = Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: '', toolUses: [{ id: `b${i}`, tool: 'Bash', input: { command: `echo ${i}` } }] }))
  const last = stepsOf(many as never)
  expect(last).toHaveLength(15)
  expect(last[0]).toBe('Bash: echo 5')
  expect(last[14]).toBe('Bash: echo 19')
  const long = stepsOf([{ role: 'assistant', text: 'x'.repeat(500), toolUses: [] }] as never)
  expect(long[0]?.length).toBeLessThanOrEqual(130)
})

test('normalize fills fields a v0.1 snapshot lacks', () => {
  const old = { sessions: [{ id: 'a', title: 't', cwd: '/', isRunning: false, lastActivityAt: '' }], refreshedAt: 1, error: null } as never
  const fixed = normalize(old)
  expect(fixed.usage).toEqual([])
  expect(fixed.previews).toEqual({})
  expect(fixed.context).toEqual({})
  expect(fixed.sessions[0]?.isSelf).toBe(false)
  expect(fixed.sessions[0]?.isRemoteControlled).toBe(false)
})

// L2: the pane on both surfaces

for (const surface of SURFACES) {
  const mount = mountOn(surface)

  test(`${surface}: real data sorts into columns, self on top without stop, usage in header, all chrome in English`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on)
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ text: 'Running' })).toBeDefined()
    expect(await ui.find({ text: 'Finished (24h)' })).toBeDefined()
    expect(await ui.find({ text: 'Idle' })).toBeDefined()
    expect(await ui.find({ text: /This session · Session board plugin/ })).toBeDefined()
    expect(await ui.find({ key: `stop-${SELF}` })).toBeUndefined()
    expect((await ui.find({ key: 'usage' }))?.text).toBe('Usage 5h 5% · Weekly 1%')
    expect(await ui.find({ text: /^Updated / })).toBeDefined()
    expect(await ui.find({ key: 'filter' })).toBeDefined()
    expect(calls.some(c => c.tool === 'list_events' && c.args.session_id === SELF)).toBe(false)
    await expectLinksClickable(ui)
    await expectChromeEnglish(ui)
  })

  test(`${surface}: only cards fetch previews; a card is fetched again only after new activity`, async ($, on) => {
    mock.clock(on, { now: NOW })
    let answeredAt = RECENT_AT
    const calls = fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { lastActivityAt: answeredAt } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(askedOf(calls, 'list_events').sort()).toEqual([ANSWERED, RECENT].sort())
    expect((await ui.find({ key: `preview-${ANSWERED}` }))?.text).toMatch(/^测试服务的告警已解除/)
    expect(await ui.find({ key: `preview-${RECENT}` })).toBeUndefined()

    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(2)

    answeredAt = '2026-10-19T23:00:00.000Z'
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(3)
  })

  test(`${surface}: a failed list_events is retried on the next refresh`, async ($, on) => {
    mock.clock(on, { now: NOW })
    let isDown = true
    const calls = fakeServer(on, { list_events: () => (isDown ? fail('boom') : ok(EVENTS_RESULT_ONLY)) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(1)
    isDown = false
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(2)
    expect(await ui.find({ text: /Could not load sessions/ })).toBeUndefined()
  })

  test(`${surface}: a cleaned-up transcript is not fetched again until the session moves`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, { list_events: () => fail(EVENTS_UNAVAILABLE_ERROR) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(1)
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_events')).toBe(1)
    expect(await ui.find({ key: `preview-${RECENT}` })).toBeUndefined()
  })

  test(`${surface}: get_usage and get_session failures degrade quietly`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { get_usage: () => fail('no usage'), get_session: () => fail('no self') })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ key: 'usage' })).toBeUndefined()
    expect(await ui.find({ text: /This session ·/ })).toBeUndefined()
    expect(await ui.find({ text: 'Idle' })).toBeDefined()
    expect(await ui.find({ text: /Could not load sessions/ })).toBeUndefined()
  })

  test(`${surface}: a failed list_sessions shows the error`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { list_sessions: () => fail('server not connected') })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ text: /Could not load sessions: server not connected/ })).toBeDefined()
  })

  test(`${surface}: stop calls stop_session for a running session that is not this one`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { isRunning: true } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `stop-${RECENT}` })

    expect(calls.some(c => c.tool === 'stop_session' && c.args.session_id === RECENT)).toBe(true)
    expect(toasts).toEqual(['Stopped: VSCode session import'])
  })

  test(`${surface}: open runs /usr/bin/open with the session link, and refuses a foreign link`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { link: 'https://evil.example/x' } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    await ui.press({ key: `open-${RECENT}` })
    expect(runs).toEqual([['/usr/bin/open', `claude://claude.ai/epitaxy/${RECENT}`]])

    await ui.press({ key: `open-${ANSWERED}` })
    expect(runs).toHaveLength(1)
    expect(toasts.at(-1)).toMatch(/^Cannot open: unexpected link/)
    expect(await ui.find({ key: `open-${SELF}` })).toBeUndefined()
  })

  test(`${surface}: Move to Idle files a finished card under Idle without touching the session, until it moves again`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    let at = LIST_SESSIONS[0]!.lastActivityAt
    const calls = fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: at } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    const columnOf = async (id: string) => {
      const answer = await $.tool.call({ tool: 'mcp__session-board__board_debug' })
      return JSON.parse(String((answer as { result?: unknown }).result ?? '')).sessions.find((s: { id: string }) => s.id === id)?.column
    }
    expect(await ui.find({ key: `shelve-${SELF}` })).toBeUndefined()
    expect(await ui.find({ key: `card-${RECENT}` })).toBeDefined()

    await ui.press({ key: `shelve-${RECENT}` })
    expect(await columnOf(RECENT)).toBe('idle')
    expect(await ui.find({ key: `card-${RECENT}` })).toBeUndefined()
    expect(await ui.find({ key: `idle-${RECENT}` })).toBeDefined()
    expect(count(calls, 'archive_session')).toBe(0)
    await ui.press({ key: 'refresh' })
    expect(await columnOf(RECENT)).toBe('idle')

    at = '2026-10-19T23:50:00.000Z'
    await ui.press({ key: 'refresh' })
    expect(await columnOf(RECENT)).toBe('recent')
    expect(await ui.find({ key: `card-${RECENT}` })).toBeDefined()
  })

  test(`${surface}: filing is shared through the store: another session's Move to Idle shows here, and ours is written for it`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const at = LIST_SESSIONS[0]!.lastActivityAt
    // what another session's board filed earlier
    mock.store(on, { shelved: { [RECENT]: at }, dismissed: { stale: 'old' } })
    fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { lastActivityAt: RECENT_AT } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    const columnOf = async (id: string) => {
      const answer = await $.tool.call({ tool: 'mcp__session-board__board_debug' })
      return JSON.parse(String((answer as { result?: unknown }).result ?? '')).sessions.find((s: { id: string }) => s.id === id)?.column
    }
    expect(await columnOf(RECENT)).toBe('idle')
    const debug = async () => JSON.parse(String(((await $.tool.call({ tool: 'mcp__session-board__board_debug' })) as { result?: unknown }).result ?? ''))
    expect((await debug()).dismissed).toEqual({})

    await ui.press({ key: `shelve-${ANSWERED}` })
    expect(await columnOf(ANSWERED)).toBe('idle')
    // a refresh takes the store as truth: the filing survives only if it was written there
    await ui.press({ key: 'refresh' })
    expect(await columnOf(ANSWERED)).toBe('idle')
    expect((await debug()).shelved).toEqual({ [RECENT]: at, [ANSWERED]: RECENT_AT })
  })

  test(`${surface}: this session's card shows its own latest update from session.messages, never via list_events`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on)
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `preview-${SELF}` }))?.text).toMatch(/^Progress \([^)]+\): 明白：运行中的卡片要始终有 Progress 一行。$/)
    expect((await ui.find({ key: `task-${SELF}` }))?.text).toMatch(/^Task: 我想让progress/)
    expect(calls.some(c => c.tool === 'list_events' && c.args.session_id === SELF)).toBe(false)
    expect(await ui.find({ key: `needs-${SELF}` })).toBeUndefined()
  })

  test(`${surface}: a running card always has a Progress line: placeholder before any text, then the last text carried forward`, async ($, on) => {
    mock.clock(on, { now: NOW })
    let at = RECENT_AT
    let events = EVENTS_RUNNING_TOOLS_ONLY
    const calls = fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { isRunning: true, lastActivityAt: at } }),
      list_events: () => ok(events),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `preview-${RECENT}` }))?.text).toBe('Progress: Working — no written update yet')
    expect(calls.find(c => c.tool === 'list_events' && c.args.session_id === RECENT)?.args.limit).toBe(60)

    events = EVENTS_RUNNING
    at = '2026-10-19T22:00:00.000Z'
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `preview-${RECENT}` }))?.text).toMatch(/^Progress \([^)]+\): 我先看一下仓库里/)

    events = EVENTS_RUNNING_TOOLS_ONLY
    at = '2026-10-19T22:30:00.000Z'
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `preview-${RECENT}` }))?.text).toMatch(/^Progress \([^)]+\): 我先看一下仓库里/)
    expect((await ui.find({ key: `task-${RECENT}` }))?.text).toMatch(/^Task: 从之前的的测试上来看/)
  })

  test(`${surface}: every card is fully shown, with model and effort on the title row; no More/Less toggle`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { isRunning: true } }),
      list_events: () => ok(EVENTS_RUNNING),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    for (const key of [`open-${RECENT}`, `stop-${RECENT}`, `preview-${RECENT}`, `task-${RECENT}`, `reply-${RECENT}`]) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ key: `expand-${RECENT}` })).toBeUndefined()
    // walk the drawn tree: the selects must sit inside the title row's Box
    type Node = { type: string; props?: Record<string, unknown>; children?: unknown }
    const kids = (n: Node): Node[] => (Array.isArray(n.children) ? (n.children as Node[]) : n.children && typeof n.children === 'object' ? [n.children as Node] : [])
    const findNode = (n: Node, key: string): Node | undefined =>
      n.props?.key === key ? n : kids(n).reduce<Node | undefined>((hit, c) => hit ?? (typeof c === 'object' && c ? findNode(c, key) : undefined), undefined)
    const head = findNode((await ui.drawn()) as Node, `head-${RECENT}`)
    expect(head).toBeDefined()
    expect(findNode(head!, `model-${RECENT}`)).toBeDefined()
    expect(findNode(head!, `effort-${RECENT}`)).toBeDefined()
    expect(findNode(head!, `title-${RECENT}`)).toBeDefined()
    expect((await ui.find({ key: `tune-${SELF}` }))?.text).toBe('Opus 5.5 · High')
  })

  test(`${surface}: the help button explains the columns`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on)
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: 'help-box' })).toBeUndefined()
    await ui.press({ key: 'help' })
    expect((await ui.find({ key: 'help-box' }))?.text).toMatch(/Needs me/)
    await ui.press({ key: 'help' })
    expect(await ui.find({ key: 'help-box' })).toBeUndefined()
  })

  test(`${surface}: Open on a card or row opens that session`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on)
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `open-${RECENT}` })
    await ui.press({ key: `open-${OLDEST}` })
    expect(runs).toEqual([
      ['/usr/bin/open', `claude://claude.ai/epitaxy/${RECENT}`],
      ['/usr/bin/open', `claude://claude.ai/epitaxy/${OLDEST}`],
    ])
    expect(await ui.find({ key: `open-${SELF}` })).toBeUndefined()
  })

  test(`${surface}: the card input sends a message, blank text sends nothing, self has no input`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on)
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ key: `msg-${SELF}` })).toBeUndefined()

    await ui.press({ key: `reply-${RECENT}` })
    await ui.input({ key: `msg-${RECENT}`, text: '   ' })
    expect(count(calls, 'send_message')).toBe(0)

    await ui.input({ key: `msg-${RECENT}`, text: ' 请把结论贴到 README ', kind: 'change' })
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe(' 请把结论贴到 README ')
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe(' 请把结论贴到 README ')

    await ui.input({ key: `msg-${RECENT}`, text: ' 请把结论贴到 README ' })
    const sent = calls.find(c => c.tool === 'send_message')
    expect(sent?.args).toEqual({ session_id: RECENT, message: '请把结论贴到 README' })
    expect(toasts).toEqual(['Sent — the session started on it: VSCode session import'])
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe('')
    expect((await ui.find({ key: `sent-${RECENT}` }))?.text).toBe('Sent — the session started on it · just now')
  })

  test(`${surface}: a message the target never picks up is shown as pending, the draft cleared so it is not resent`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, { send_message: () => fail(SEND_MESSAGE_UNDELIVERED) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `reply-${RECENT}` })
    await ui.input({ key: `msg-${RECENT}`, text: '你觉得这些备份可以删除吗' })

    expect(count(calls, 'send_message')).toBe(1)
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe('')
    const line = await ui.find({ key: `sent-${RECENT}` })
    expect(line?.text).toMatch(/^Delivered, but the session hasn't started on it within 20s/)
    expect(line?.text).not.toMatch(/Send failed/)
    expect(toasts).toEqual(['Not picked up yet: VSCode session import'])
    expect(await ui.find({ text: /Remote Control/ })).toBeDefined()
  })

  test(`${surface}: while a send is in flight the card shows a spinner that advances, and a second submit is ignored`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let finish: ((v: ReturnType<typeof ok>) => void) | undefined
    const calls = fakeServer(on, { send_message: () => new Promise<ReturnType<typeof ok>>(r => (finish = r)) as never })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    await ui.press({ key: `reply-${RECENT}` })
    const inFlight = ui.input({ key: `msg-${RECENT}`, text: 'hello' })
    await new Promise(r => setTimeout(r, 20))
    expect(count(calls, 'send_message')).toBe(1)
    expect((await ui.find({ key: `sending-${RECENT}` }))?.text).toMatch(/^⠋ Sending…/)
    expect(await ui.find({ key: `sent-${RECENT}` })).toBeUndefined()
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe('hello')

    await clock.advance(120)
    expect((await ui.find({ key: `sending-${RECENT}` }))?.text).toMatch(/^⠙ Sending…/)

    await ui.input({ key: `msg-${RECENT}`, text: 'hello again' })
    expect(count(calls, 'send_message')).toBe(1)

    finish?.(ok(SEND_MESSAGE_RESULT))
    await inFlight
    expect(await ui.find({ key: `sending-${RECENT}` })).toBeUndefined()
    expect((await ui.find({ key: `sent-${RECENT}` }))?.text).toMatch(/^Sent — the session started on it/)
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe('')
  })

  test(`${surface}: a failed send_message keeps the draft and says why`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { send_message: () => fail('target session is archived') })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `reply-${RECENT}` })
    await ui.input({ key: `msg-${RECENT}`, text: 'hi' })
    expect(toasts).toEqual(['Send failed: target session is archived'])
    expect((await ui.find({ key: `msg-${RECENT}` }))?.props.value).toBe('hi')
    expect((await ui.find({ key: `sent-${RECENT}` }))?.text).toMatch(/^Send failed: target session is archived/)
  })

  test(`${surface}: a running card shows its task and progress, fetched with a deeper limit; a finished card shows the answer only`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { isRunning: true }, [ANSWERED]: { lastActivityAt: RECENT_AT } }),
      list_events: () => ok(EVENTS_RUNNING),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: `task-${RECENT}` }))?.text).toMatch(/^Task: 从之前的的测试上来看/)
    expect((await ui.find({ key: `preview-${RECENT}` }))?.text).toMatch(/^Progress \([^)]+\): 我先看一下仓库里/)
    expect(await ui.find({ key: `task-${ANSWERED}` })).toBeUndefined()
    expect((await ui.find({ key: `preview-${ANSWERED}` }))?.text).toMatch(/^我先看一下仓库里/)

    const limits = Object.fromEntries(calls.filter(c => c.tool === 'list_events').map(c => [c.args.session_id, c.args.limit]))
    expect(limits[RECENT]).toBe(60)
    expect(limits[ANSWERED]).toBe(10)
  })

  test(`${surface}: running cards show context usage from get_usage with session_id; self from the plain call`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { isRunning: true } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: `context-${RECENT}` }))?.text).toBe('Context 14%')
    expect((await ui.find({ key: `context-${SELF}` }))?.text).toBe('Context 16%')
    expect(await ui.find({ key: `context-${ANSWERED}` })).toBeUndefined()
    expect(askedOf(calls, 'get_usage')).toEqual([undefined, RECENT])
  })

  test(`${surface}: a session that stops running raises one toast, not on first load, not for self`, async ($, on) => {
    mock.clock(on, { now: NOW })
    let isRunning = true
    let selfRunning = true
    fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { isRunning } }),
      get_session: args => ok(args.session_id === 'self' ? { ...GET_SESSION_SELF, isRunning: selfRunning } : { ...GET_SESSION_OTHER, sessionId: args.session_id }),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(toasts).toEqual([])

    isRunning = false
    selfRunning = false
    await ui.press({ key: 'refresh' })
    expect(toasts).toEqual(['Finished: VSCode session import'])

    await ui.press({ key: 'refresh' })
    expect(toasts).toHaveLength(1)
  })

  test(`${surface}: cards offer model and effort selects fed by get_session; self shows text; idle rows ask nothing`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const calls = fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { isRunning: true } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    const model = await ui.find({ key: `model-${RECENT}` })
    expect(model?.props.value).toBe('claude-opus-5-5')
    expect((model?.props.options as { value: string }[]).map(o => o.value)).toContain('claude-haiku-5-5')
    const effort = await ui.find({ key: `effort-${RECENT}` })
    expect(effort?.props.value).toBe('medium')
    expect((effort?.props.options as { label: string }[]).map(o => o.label)).toEqual(['Low', 'Medium', 'High', 'Very high', 'Max'])
    expect(await ui.find({ key: `model-${ANSWERED}` })).toBeDefined()
    expect(await ui.find({ key: `model-${SELF}` })).toBeUndefined()
    expect((await ui.find({ key: `tune-${SELF}` }))?.text).toBe('Opus 5.5 · High')
    expect(askedOf(calls, 'get_session').sort()).toEqual([RECENT, ANSWERED, 'self'].sort())

    await ui.select({ key: `model-${RECENT}`, value: 'claude-haiku-5-5' })
    expect(calls.find(c => c.tool === 'set_session_model')?.args).toEqual({ session_id: RECENT, model: 'claude-haiku-5-5' })
    await ui.select({ key: `effort-${RECENT}`, value: 'low' })
    expect(calls.find(c => c.tool === 'set_session_effort')?.args).toEqual({ session_id: RECENT, effort: 'low' })
    expect(toasts[0]).toMatch(/^Model set to claude-haiku-5-5: VSCode session import/)
    expect(toasts[1]).toMatch(/^Effort set to low: VSCode session import/)
  })

  test(`${surface}: a rejected model change is reported, not swallowed`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { set_session_model: () => fail('model "x" is not offered; pick one of claude-opus-5-5, claude-sonnet-5-5') })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    await ui.select({ key: `model-${RECENT}`, value: 'claude-haiku-5-5' })
    expect(toasts[0]).toMatch(/^Could not set model: model "x" is not offered/)
  })

  test(`${surface}: the filter narrows every section and says how many rows it hides`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { isRunning: true } }) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: 'Running' })).toBeDefined()

    await ui.input({ key: 'filter', text: 'vscode', kind: 'change' })
    expect(await ui.find({ key: `card-${SELF}` })).toBeUndefined()
    expect(await ui.find({ key: `card-${ANSWERED}` })).toBeUndefined()
    expect(await ui.find({ key: `card-${RECENT}` })).toBeDefined()
    expect(await ui.find({ key: `idle-${OLDEST}` })).toBeDefined()
    expect((await ui.find({ key: 'filter-note' }))?.text).toBe('4 hidden by filter')

    await ui.input({ key: 'filter', text: '', kind: 'change' })
    expect(await ui.find({ text: 'Running' })).toBeDefined()
    expect(await ui.find({ key: 'filter-note' })).toBeUndefined()
  })

  test(`${surface}: a finished session that asked a question, or never started on its last message, lands in Needs me; headers carry no counts`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const ASKING = 'local_55217ab7-6782-469b-a190-999d50dfa0df'
    fakeServer(on, {
      list_sessions: () => listWith({ [ANSWERED]: { lastActivityAt: RECENT_AT }, [ASKING]: { lastActivityAt: RECENT_AT } }),
      list_events: args =>
        ok(args.session_id === RECENT ? EVENTS_CROSS_SESSION : args.session_id === ASKING ? EVENTS_ASKING : EVENTS_WITH_ANSWER),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    for (const title of ['Running', 'Needs me', 'Finished (24h)', 'Idle']) expect(await header(ui, title)).toBeDefined()
    expect(await header(ui, 'Running 1')).toBeUndefined()
    const answer = await $.tool.call({ tool: 'mcp__session-board__board_debug' })
    const info = JSON.parse(String((answer as { result?: unknown }).result ?? ''))
    const columnOf = (id: string) => info.sessions.find((s: { id: string }) => s.id === id)?.column
    expect(columnOf(RECENT)).toBe('needsMe')
    expect(columnOf(ASKING)).toBe('needsMe')
    expect(columnOf(ANSWERED)).toBe('recent')
    expect(columnOf(SELF)).toBe('running')
    expect((await ui.find({ key: `needs-${RECENT}` }))?.text).toMatch(/^Message not picked up/)
    expect((await ui.find({ key: `needs-${ASKING}` }))?.text).toMatch(/^Asks: .*要不要我顺手清掉？/)
    expect(await ui.find({ key: `needs-${ANSWERED}` })).toBeUndefined()
    expect((await ui.find({ key: `card-${RECENT}` }))?.props.borderColor).toBe(COLUMN_COLORS.needsMe)
    expect((await ui.find({ key: `card-${ANSWERED}` }))?.props.borderColor).toBe(COLUMN_COLORS.recent)
    expect((await ui.find({ key: `card-${SELF}` }))?.props.borderColor).toBe(COLUMN_COLORS.running)
    expect((await header(ui, 'Needs me')) as { props?: { color?: string } } | undefined).toMatchObject({ props: { color: COLUMN_COLORS.needsMe } })
  })

  test(`${surface}: Dismiss moves a Needs-me card to Finished until the session moves again`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    let at = RECENT_AT
    fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { lastActivityAt: at } }),
      list_events: () => ok(EVENTS_AWAITING),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })
    const columnOf = async (id: string) => {
      const answer = await $.tool.call({ tool: 'mcp__session-board__board_debug' })
      return JSON.parse(String((answer as { result?: unknown }).result ?? '')).sessions.find((s: { id: string }) => s.id === id)?.column
    }
    expect(await columnOf(RECENT)).toBe('needsMe')
    expect((await ui.find({ key: `needs-${RECENT}` }))?.text).toMatch(/^Waiting for your answer/)

    await ui.press({ key: `dismiss-${RECENT}` })
    expect(await columnOf(RECENT)).toBe('recent')
    expect(await ui.find({ key: `needs-${RECENT}` })).toBeUndefined()
    await ui.press({ key: 'refresh' })
    expect(await columnOf(RECENT)).toBe('recent')

    at = '2026-10-19T23:30:00.000Z'
    await ui.press({ key: 'refresh' })
    expect(await columnOf(RECENT)).toBe('needsMe')
  })

  test(`${surface}: idle rows are grouped by folder once there is more than one folder`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, {
      list_sessions: () => listWith({ [ANSWERED]: { cwd: '/Users/me/Documents/Other_Repo' }, [OLDEST]: { cwd: '/Users/me/Documents/Other_Repo' } }),
    })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'ws-project' }))?.text).toMatch(/^project 3/)
    expect((await ui.find({ key: 'ws-Other_Repo' }))?.text).toMatch(/^Other_Repo 2/)
    expect(await ui.find({ key: `idle-${ANSWERED}` })).toBeDefined()
  })

  test(`${surface}: with one folder idle rows stay flat, capped at 8 with a Show all toggle`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...LIST_SESSIONS[1]!,
      sessionId: `local_idle_${i}`,
      title: `Idle task ${i}`,
      link: `claude://claude.ai/epitaxy/local_idle_${i}`,
    }))
    fakeServer(on, { list_sessions: () => ok(many) })
    const ui = await mount($)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ text: 'Idle' })).toBeDefined()
    expect(await ui.find({ key: 'ws-project' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Button' }).then(all => all.filter(b => String(b.props.key).startsWith('open-local_idle_')))).toHaveLength(8)
    expect((await ui.find({ key: 'toggle-idle' }))?.props.label).toBe('Show all 12')

    await ui.press({ key: 'toggle-idle' })
    expect(await ui.findAll({ type: 'Button' }).then(all => all.filter(b => String(b.props.key).startsWith('open-local_idle_')))).toHaveLength(12)
    expect((await ui.find({ key: 'toggle-idle' }))?.props.label).toBe('Show fewer')
  })
}

// Auto-open: the board is there when a session starts, unless the option turns it off

function sessionStartHarness(on: On, isPaneOpen: boolean, calls: string[] = [], isPlaced = true) {
  const opens: string[] = []
  on('ui.panes', () => ({ value: isPaneOpen ? [{ id: 'session-board', title: 'Sessions', isPlaced: true }] : [] }) as never)
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no surface has placed it yet' } } as never
  })
  on('mcp.call', ($, e) => {
    calls.push(e.tool)
    return ok(LIST_SESSIONS)
  })
  on('session.start', ($, e) => {
    opens.push('next')
    return { cwd: e.cwd } as never
  })
  on('tool.register', () => ({ value: { tool: 'mcp__session-board__board_debug' } }) as never)
  on('command.register', () => ({ value: { command: 'board' } }) as never)
  return opens
}

const START = { cwd: '/Users/me/project', surface: 'desktop' as const, isInteractive: true }

test('session.start lets the session start, then opens the board, then refreshes after a short delay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls: string[] = []
  const opens = sessionStartHarness(on, false, calls)
  await $.session.start(START as never)
  expect(opens).toEqual(['next', 'session-board'])
  expect(calls).toEqual([])
  await clock.advance(1500)
  await new Promise(r => setTimeout(r, 50))
  expect(calls).toContain('list_sessions')
})

// What the fresh-session probe measured: paneOpen true, timerActive false, refreshedAt 0.
// At session start the surface has not placed the pane yet, so open() answers isPlaced false; polling must start anyway.
test('session.start starts polling even when the surface has not placed the pane yet', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls: string[] = []
  const opens = sessionStartHarness(on, false, calls, false)
  await $.session.start(START as never)
  expect(opens).toEqual(['next', 'session-board'])
  await clock.advance(1500)
  await new Promise(r => setTimeout(r, 50))
  expect(calls).toContain('list_sessions')
})

test('session.start leaves an already open board alone but still refreshes it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls: string[] = []
  const opens = sessionStartHarness(on, true, calls)
  await $.session.start(START as never)
  expect(opens).toEqual(['next'])
  await clock.advance(1500)
  await new Promise(r => setTimeout(r, 50))
  expect(calls).toContain('list_sessions')
})

test('session.start does not open the board when autoOpen is off', { options: { autoOpen: false } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens = sessionStartHarness(on, false)
  await $.session.start(START as never)
  expect(opens).toEqual(['next'])
})

for (const surface of SURFACES) {
  test(`${surface}: a pane drawn while no polling runs starts polling by itself`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const calls = fakeServer(on)
    await mountOn(surface)($)
    expect(count(calls, 'list_sessions')).toBe(0)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(1)
    await clock.advance(3_000)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(2)
  })

  test(`${surface}: refreshSeconds sets the polling period, clamped to 1-60`, { options: { refreshSeconds: 1 } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const calls = fakeServer(on)
    await mountOn(surface)($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(1)
    await clock.advance(1_000)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(2)
    await clock.advance(1_000)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(3)
  })
}

test('refreshMsOf clamps and defaults', () => {
  expect(refreshMsOf(undefined)).toBe(3000)
  expect(refreshMsOf(0)).toBe(1000)
  expect(refreshMsOf(600)).toBe(60_000)
  expect(refreshMsOf(5)).toBe(5000)
  expect(refreshMsOf('x')).toBe(3000)
})

// Sub-sessions: a session another one started is drawn inside its parent's card

const CHILD = CHILD_SESSION.sessionId

for (const surface of SURFACES) {
  test(`${surface}: a sub-session is drawn inside its parent's card, once, in its own column color, and can be collapsed`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { list_sessions: () => ok([CHILD_SESSION, ...LIST_SESSIONS]) })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })

    const box = await ui.find({ key: `children-${RECENT}` })
    expect(box?.text).toContain('文档清理')
    expect((await ui.findAll({ type: 'Box' })).filter(b => b.key === `card-${CHILD}`)).toHaveLength(1)
    expect((await ui.find({ key: `card-${CHILD}` }))?.props.borderColor).toBe(COLUMN_COLORS.running)
    expect((await ui.find({ key: `toggle-children-${RECENT}` }))?.props.label).toBe('▾ 1 sub-session')
    expect(await ui.find({ key: `stop-${CHILD}` })).toBeDefined()
    await ui.press({ key: `reply-${CHILD}` })
    expect(await ui.find({ key: `msg-${CHILD}` })).toBeDefined()

    await ui.press({ key: `toggle-children-${RECENT}` })
    expect(await ui.find({ key: `card-${CHILD}` })).toBeUndefined()
    expect((await ui.find({ key: `toggle-children-${RECENT}` }))?.props.label).toBe('▸ 1 sub-session')
  })

  test(`${surface}: a sub-session whose parent is idle stands on its own in its column`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, { list_sessions: () => ok([{ ...CHILD_SESSION, startedBy: OLDEST }, ...LIST_SESSIONS]) })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: `children-${OLDEST}` })).toBeUndefined()
    expect(await ui.find({ key: `card-${CHILD}` })).toBeDefined()
    expect(await ui.find({ key: `idle-${OLDEST}` })).toBeDefined()
  })

  test(`${surface}: a sub-session that needs you is flagged on its parent`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeServer(on, {
      list_sessions: () => ok([{ ...CHILD_SESSION, isRunning: false }, ...LIST_SESSIONS]),
      list_events: args => ok(args.session_id === CHILD ? EVENTS_AWAITING : EVENTS_RESULT_ONLY),
    })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `children-needs-${RECENT}` }))?.text).toBe('1 needs you')
    expect((await ui.find({ key: `card-${CHILD}` }))?.props.borderColor).toBe(COLUMN_COLORS.needsMe)
    expect(await ui.find({ key: `needs-${CHILD}` })).toBeDefined()
  })
}

// Subagents: each session reports its own Agent-tool helpers to the store; every board shows them under the parent card

const AGENT_ROWS = [
  { id: 'a1', description: 'Fact-check backtest docs', type: 'general-purpose', status: 'completed' },
  { id: 'a2', description: 'Fact-check commands and universe docs', type: 'general-purpose', status: 'running' },
  { id: 'a3', description: 'Fact-check the guide', type: 'general-purpose', status: 'completed' },
]

for (const surface of SURFACES) {
  test(`${surface}: this session reports its own subagents, with their latest progress, to the store`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = fakeStore(on)
    fakeServer(on)
    ownAgents = AGENT_ROWS.slice(0, 2)
    agentMessages = { a2: [{ role: 'assistant', text: 'Checked 4 of 8 files so far.', toolUses: [] }] }
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })

    const reported = store.get(`agents:${SELF}`) as { at: number; agents: { id: string; status: string; progress?: string }[] }
    expect(reported.at).toBe(NOW)
    expect(reported.agents.map(a => a.id)).toEqual(['a1', 'a2'])
    expect(reported.agents.find(a => a.id === 'a2')?.progress).toBe('Checked 4 of 8 files so far.')
    expect(reported.agents.find(a => a.id === 'a1')?.progress).toBeUndefined()
  })

  test(`${surface}: another session's subagents show under its card as a summary and one row each, collapsible, with no message box`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeStore(on, { [`agents:${RECENT}`]: { at: NOW - 2000, agents: AGENT_ROWS.map((a, i) => (i === 1 ? { ...a, progress: 'Checked 4 of 8 files so far.' } : a)) } })
    fakeServer(on)
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: `toggle-agents-${RECENT}` }))?.props.label).toBe('▾ 3 agents · 1 running · 2 done')
    expect((await ui.find({ key: `agent-a2` }))?.text).toMatch(/Fact-check commands and universe docs · running — Checked 4 of 8 files so far\./)
    expect(await ui.find({ key: `agent-a1` })).toBeDefined()
    expect((await ui.findAll({ type: 'Input' })).some(el => String(el.key).includes('a1') || String(el.key).includes('a2'))).toBe(false)

    await ui.press({ key: `toggle-agents-${RECENT}` })
    expect(await ui.find({ key: `agent-a2` })).toBeUndefined()
    expect((await ui.find({ key: `toggle-agents-${RECENT}` }))?.props.label).toBe('▸ 3 agents · 1 running · 2 done')
  })

  test(`${surface}: the report carries each agent's recent steps`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = fakeStore(on)
    fakeServer(on)
    ownAgents = [AGENT_ROWS[1]!]
    agentMessages = {
      a2: [
        { role: 'user', text: 'Fact-check the commands docs', toolUses: [] },
        { role: 'assistant', text: 'Reading strategy-iteration.md.', toolUses: [{ id: 't1', tool: 'Read', input: { file_path: '.claude/commands/strategy-iteration.md' } }] },
      ],
    }
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    const reported = store.get(`agents:${SELF}`) as { agents: { steps?: string[] }[] }
    expect(reported.agents[0]?.steps).toEqual(['Task: Fact-check the commands docs', 'Said: Reading strategy-iteration.md.', 'Read: .claude/commands/strategy-iteration.md'])
  })

  test(`${surface}: View opens an agent's recent steps under its row and Hide closes them; no View without steps`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const steps = ['Task: Fact-check the commands docs', 'Read: .claude/commands/strategy-iteration.md', 'Bash: grep -n report-dir (error)']
    fakeStore(on, { [`agents:${RECENT}`]: { at: NOW - 2000, agents: [{ ...AGENT_ROWS[1]!, steps }, AGENT_ROWS[0]!] } })
    fakeServer(on)
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'view-agent-a2' }))?.props.label).toBe('View')
    expect(await ui.find({ key: 'view-agent-a1' })).toBeUndefined()
    expect(await ui.find({ key: 'agent-steps-a2' })).toBeUndefined()

    await ui.press({ key: 'view-agent-a2' })
    const box = await ui.find({ key: 'agent-steps-a2' })
    for (const step of steps) expect(box?.text).toContain(step)
    expect((await ui.find({ key: 'view-agent-a2' }))?.props.label).toBe('Hide')

    await ui.press({ key: 'view-agent-a2' })
    expect(await ui.find({ key: 'agent-steps-a2' })).toBeUndefined()
  })

  test(`${surface}: subagents whose session stopped reporting a while ago are not shown`, async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeStore(on, { [`agents:${RECENT}`]: { at: NOW - 120_000, agents: AGENT_ROWS } })
    fakeServer(on)
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: `agents-${RECENT}` })).toBeUndefined()
  })
}

// Single poller: one session holds a lease in the store, polls the app and publishes the board; the others read it.

const LEADER = 'local_leader-0000'

function fakeStore(on: On, initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  return store
}

// What a leader in another session published: the app's list as that leader saw it (it includes us, not itself) plus itself.
function publishedBoard(refreshedAt: number) {
  const sessions = [
    { id: LEADER, title: 'Leader session', cwd: '/x/project', isRunning: true, isSelf: false, lastActivityAt: iso(NOW - 60_000), isRemoteControlled: false },
    { id: SELF, title: 'Session board plugin', cwd: '/x/project', isRunning: true, isSelf: false, lastActivityAt: iso(NOW - 60_000), isRemoteControlled: false },
    { id: OLDEST, title: 'VSCode existing sessions access', cwd: '/x/project', isRunning: false, isSelf: false, lastActivityAt: '2026-05-25T23:15:19.920Z', isRemoteControlled: false },
  ]
  return { sessions, usage: [{ label: '5h', percent: 42, resetsIn: '1h' }], previews: {}, context: {}, refreshedAt, error: null }
}
function iso(ms: number) {
  return new Date(ms).toISOString()
}

async function debugOf($: Engine) {
  return JSON.parse(String(((await $.tool.call({ tool: 'mcp__session-board__board_debug' })) as { result?: unknown }).result ?? ''))
}

for (const surface of SURFACES) {
  test(`${surface}: with no lease this session polls, then publishes the board and takes the lease`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = fakeStore(on)
    const calls = fakeServer(on)
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })

    expect(count(calls, 'list_sessions')).toBe(1)
    expect(store.get('lease')).toEqual({ id: SELF, until: NOW + 9000 })
    const board = store.get('board') as { sessions: { id: string; isSelf: boolean }[]; refreshedAt: number }
    expect(board.refreshedAt).toBe(NOW)
    expect(board.sessions.map(s => s.id)).toContain(SELF)
    expect(board.sessions.every(s => s.isSelf === false)).toBe(true)
    expect((await debugOf($)).role).toBe('leader')
  })

  test(`${surface}: while another session holds the lease this one reads the published board and never polls the app`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    fakeStore(on, { lease: { id: LEADER, until: NOW + 9000 }, board: publishedBoard(NOW - 1000) })
    const calls = fakeServer(on)
    const ui = await mountOn(surface)($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))

    expect(count(calls, 'list_sessions')).toBe(0)
    expect(count(calls, 'list_events')).toBe(0)
    expect(count(calls, 'get_usage')).toBe(0)
    expect(await ui.find({ text: /This session · Session board plugin/ })).toBeDefined()
    expect(await ui.find({ key: `card-${LEADER}` })).toBeDefined()
    expect((await ui.find({ key: 'usage' }))?.text).toBe('Usage 5h 42%')
    const info = await debugOf($)
    expect(info.role).toBe('follower')
    expect(info.leaseHolder).toBe(LEADER)
    expect(info.sessions[0]).toMatchObject({ id: SELF, isSelf: true })
  })

  test(`${surface}: as a follower, this session's own card shows its own latest update`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    fakeStore(on, { lease: { id: LEADER, until: NOW + 9000 }, board: publishedBoard(NOW - 1000) })
    fakeServer(on)
    const ui = await mountOn(surface)($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect((await debugOf($)).role).toBe('follower')
    expect((await ui.find({ key: `preview-${SELF}` }))?.text).toMatch(/^Progress \([^)]+\): 明白：运行中的卡片要始终有 Progress 一行。$/)
  })

  test(`${surface}: an expired lease is taken over`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = fakeStore(on, { lease: { id: LEADER, until: NOW - 1 }, board: publishedBoard(NOW - 20_000) })
    const calls = fakeServer(on)
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_sessions')).toBe(1)
    expect((store.get('lease') as { id: string }).id).toBe(SELF)
  })

  test(`${surface}: a stale board under a live lease is not trusted; this session polls`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    fakeStore(on, { lease: { id: LEADER, until: NOW + 9000 }, board: publishedBoard(NOW - 60_000) })
    const calls = fakeServer(on)
    await mountOn(surface)($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(1)
  })

  test(`${surface}: Refresh polls here even as a follower, and takes the lease`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const store = fakeStore(on, { lease: { id: LEADER, until: NOW + 9000 }, board: publishedBoard(NOW - 1000) })
    const calls = fakeServer(on)
    const ui = await mountOn(surface)($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect(count(calls, 'list_sessions')).toBe(0)

    await ui.press({ key: 'refresh' })
    expect(count(calls, 'list_sessions')).toBe(1)
    expect((store.get('lease') as { id: string }).id).toBe(SELF)
  })
}

// L4 support: the debug tool reports state without transcript text

test('board_debug reports columns, model, usage and preview lengths, never preview text', async ($, on) => {
  mock.clock(on, { now: NOW })
  fakeServer(on, { list_sessions: () => listWith({ [ANSWERED]: { lastActivityAt: RECENT_AT } }) })
  const ui = await mountOn('desktop')($)
  await ui.press({ key: 'refresh' })

  const answer = await $.tool.call({ tool: 'mcp__session-board__board_debug' })
  const text = String((answer as { result?: unknown }).result ?? '')
  const info = JSON.parse(text)

  expect(info.version).toBe('0.22.0')
  expect(info.paneOpen).toBe(true)
  expect(info.canRunProcess).toBe(true)
  expect(info.error).toBeNull()
  expect(info.filter).toBe('')
  expect(info.sessions).toHaveLength(7)
  expect(info.sessions[0]).toEqual({ id: SELF, isRunning: true, isSelf: true, column: 'running', model: 'claude-opus-5-5', effort: 'high', parentId: null })
  expect(info.sessions.find((s: { id: string }) => s.id === RECENT)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  expect(info.sessions.find((s: { id: string }) => s.id === OLDEST)).toMatchObject({ model: null })
  expect(info.usage).toEqual(usageOf(GET_USAGE))
  expect(info.previewChars[ANSWERED]).toBeGreaterThan(0)
  expect(text.includes('告警')).toBe(false)
})

// Across surfaces: the local data source (session files and transcripts), merged with the desktop tools where they exist.

const VS = LIVE_VSCODE.sessionId
const DERIVED = LIVE_DERIVED_NAME.sessionId
const CLOSED = 'dddddddd-4444-4444-8444-444444444444'
const CLOSED_DESKTOP = 'eeeeeeee-5555-4555-8555-555555555555'
const CLOSED_SCRIPT = '99999999-6666-4666-8666-666666666666'
const CLOSED_TERMINAL = '88888888-7777-4777-8777-777777777777'
const MTIME = NOW - 60_000
const jsonl = (id: string) => `${id}.jsonl`
const NO_APP = Object.fromEntries(
  ['list_sessions', 'get_session', 'get_usage', 'list_events', 'send_message', 'stop_session', 'set_session_model', 'set_session_effort'].map(t => [t, () => fail('server not connected')]),
)
const machine = (): World => ({
  live: [LIVE_VSCODE, LIVE_DERIVED_NAME, LIVE_DESKTOP],
  me: VS,
  projects: {
    '-Users-me-project': {
      [jsonl(VS)]: { text: TRANSCRIPT_DONE, mtimeMs: MTIME },
      [jsonl(DERIVED)]: { text: TRANSCRIPT_ASKING, mtimeMs: MTIME },
      [jsonl(LIVE_DESKTOP.sessionId)]: { text: TRANSCRIPT_DESKTOP, mtimeMs: MTIME },
      [jsonl(CLOSED)]: { text: TRANSCRIPT_NAMED, mtimeMs: MTIME - 1000 },
      [jsonl(CLOSED_DESKTOP)]: { text: TRANSCRIPT_DESKTOP, mtimeMs: MTIME - 2000 },
      [jsonl(CLOSED_SCRIPT)]: { text: TRANSCRIPT_SCRIPT, mtimeMs: MTIME - 3000 },
      [jsonl(CLOSED_TERMINAL)]: { text: TRANSCRIPT_TERMINAL, mtimeMs: MTIME - 4000 },
      'not-a-session.jsonl': { text: TRANSCRIPT_DONE, mtimeMs: MTIME },
    },
  },
})

test('asLiveFile keeps real session files and refuses anything else', () => {
  expect(asLiveFile(LIVE_VSCODE)?.sessionId).toBe(VS)
  expect(asLiveFile({ pid: 1 })).toBeUndefined()
  expect(asLiveFile(null)).toBeUndefined()
  expect(asLiveFile({ ...LIVE_VSCODE, kind: 'print' })).toBeUndefined()
  expect(asLiveFile({ ...LIVE_VSCODE, entrypoint: 'sdk-cli' })).toBeUndefined()
})

test('liveToSession: a desktop session keeps its app id and link, a VS Code one gets its own link, a terminal one none', () => {
  const desktop = liveToSession(asLiveFile(LIVE_DESKTOP)!, 'x', MTIME, '/t', NOW)
  expect(desktop.id).toBe(LIVE_DESKTOP.hostSessionId)
  expect(desktop.link).toBe(`claude://claude.ai/epitaxy/${LIVE_DESKTOP.hostSessionId}`)
  expect(desktop.peerId).toBe(LIVE_DESKTOP.sessionId)
  expect(desktop.waitingFor).toBe('input needed')
  const vs = liveToSession(asLiveFile(LIVE_VSCODE)!, 'x', MTIME, '/t', NOW)
  expect(vs.id).toBe(VS)
  expect(vs.link).toBe(`vscode://anthropic.claude-code/open?session=${VS}`)
  expect(liveToSession(asLiveFile({ ...LIVE_VSCODE, entrypoint: 'cli' })!, 'x', MTIME, '/t', NOW).link).toBeUndefined()
  expect(liveToSession(asLiveFile({ ...LIVE_VSCODE, status: 'busy' })!, 'x', MTIME, '/t', NOW).isRunning).toBe(true)
  // an idle session's time is its transcript's: reopening VS Code rewrites the status, and that is not activity
  expect(vs.lastActivityAt).toBe(new Date(MTIME).toISOString())
  expect(liveToSession(asLiveFile(LIVE_VSCODE)!, 'x', 0, undefined, NOW).lastActivityAt).toBe(new Date(LIVE_VSCODE.statusUpdatedAt).toISOString())
  const busy = asLiveFile({ ...LIVE_VSCODE, status: 'busy' })!
  expect(liveToSession(busy, 'x', LIVE_VSCODE.statusUpdatedAt - 5, '/t', NOW).lastActivityAt).toBe(new Date(LIVE_VSCODE.statusUpdatedAt).toISOString())
})

test('liveToSession: "waiting" is believed only until the transcript moves on (real case: a session kept saying so through its next turn)', () => {
  const at = LIVE_DESKTOP.statusUpdatedAt
  const fresh = liveToSession(asLiveFile(LIVE_DESKTOP)!, 'x', at + 20_000, '/t', at + 25_000)
  expect(fresh.waitingFor).toBe('input needed')
  expect(fresh.isRunning).toBe(false)
  const stale = liveToSession(asLiveFile(LIVE_DESKTOP)!, 'x', at + 600_000, '/t', at + 601_000)
  expect(stale.waitingFor).toBeUndefined()
  expect(stale.isRunning).toBe(true)
  const staleAndQuiet = liveToSession(asLiveFile(LIVE_DESKTOP)!, 'x', at + 600_000, '/t', at + 900_000)
  expect(staleAndQuiet.waitingFor).toBeUndefined()
  expect(staleAndQuiet.isRunning).toBe(false)
})

test('displayTitle: a real name wins, a derived folder-style name loses to the transcript title', () => {
  expect(displayTitle(asLiveFile(LIVE_VSCODE), { title: 'From transcript' })).toBe('Saving data')
  expect(displayTitle(asLiveFile(LIVE_DERIVED_NAME), { title: 'From transcript' })).toBe('From transcript')
  expect(displayTitle(asLiveFile(LIVE_DERIVED_NAME), {})).toBe('project-bd')
  expect(displayTitle(undefined, { title: 'From transcript' })).toBe('From transcript')
  expect(displayTitle(undefined, {})).toBe('(untitled session)')
})

test('transcriptMeta: titles rank custom over ai over prompt, and the last entrypoint is reported', () => {
  expect(transcriptMeta(TRANSCRIPT_DONE)).toEqual({ title: 'Saving the data', entrypoint: 'claude-vscode' })
  expect(transcriptMeta(TRANSCRIPT_NAMED).title).toBe('My own title')
  expect(transcriptMeta(TRANSCRIPT_SCRIPT).entrypoint).toBe('sdk-cli')
  expect(transcriptMeta('garbage\n{"cut').title).toBeUndefined()
})

test('summaryFromTranscript: same answers and Needs me rules as list_events, on real line structure', () => {
  const done = summaryFromTranscript(TRANSCRIPT_DONE)
  expect(done.answer).toBe('Saved everything.')
  expect(done.task).toBe('Please save the data')
  expect(done.needsInput).toBe(false)
  expect(done.model).toBe('claude-opus-5-5')
  expect(summaryFromTranscript(TRANSCRIPT_ASKING).reason).toBe('asked-question')
  expect(summaryFromTranscript(TRANSCRIPT_PARKED).reason).toBe('awaiting-answer')
  expect(summaryFromTranscript(TRANSCRIPT_UNANSWERED).reason).toBe('not-picked-up')
  expect(summaryFromTranscript(TRANSCRIPT_UNANSWERED).task).toBe('One more thing')
  expect(summaryFromTranscript(TRANSCRIPT_SIDECHAIN).answer).toBe('Saved everything.')
  expect(summaryFromTranscript(TRANSCRIPT_META_USER).needsInput).toBe(false)
  expect(summaryFromTranscript(TRANSCRIPT_META_USER).task).toBe('Please save the data')
  // a slash command is a task, not an unanswered message (real case: /board shown as "Message not picked up")
  const command = summaryFromTranscript(TRANSCRIPT_LOCAL_COMMAND)
  expect(command.needsInput).toBe(false)
  expect(command.answer).toBe('Saved everything.')
  expect(command.task).toBe('/board')
  // a tail cut before any message still gives the last prompt, from its own line
  expect(summaryFromTranscript('{"type":"last-prompt","lastPrompt":"Earlier ask"}').task).toBe('Earlier ask')
  expect(summaryFromTranscript('').answer).toBeUndefined()
})

test('mergeSessions: one row per session, app metadata wins, local rows only for sessions the app cannot know', () => {
  const app = normalize({ sessions: [{ id: 'local_a', title: 'App', cwd: '/x', isRunning: true, isSelf: false, lastActivityAt: '2026-10-19T00:00:00.000Z', model: 'm', isRemoteControlled: false }] }).sessions
  const base = { cwd: '/x', isRunning: false, isSelf: false, lastActivityAt: '2026-10-19T12:00:00.000Z', isRemoteControlled: false }
  const local = [
    { ...base, id: 'local_a', title: 'Local', peerId: 'u1', transcript: '/t', waitingFor: 'input needed' },
    { ...base, id: 'local_gone', title: 'Not listed by the app' },
    { ...base, id: VS, title: 'VS Code', peerId: VS },
  ]
  const merged = mergeSessions(app, local)
  expect(merged.map(s => s.id)).toEqual([VS, 'local_a'])
  const a = merged.find(s => s.id === 'local_a')
  expect(a?.title).toBe('App')
  expect(a?.model).toBe('m')
  expect(a?.peerId).toBe('u1')
  expect(a?.waitingFor).toBe('input needed')
  // with no local rows the app's own order and rows are untouched
  expect(mergeSessions(app, [])).toEqual(app)
  // with no app, every local row stands
  expect(mergeSessions(undefined, local).map(s => s.id).sort()).toEqual(['local_a', 'local_gone', VS].sort())
})

test('shouldLead: a session with the app tools takes over from a local-only lease, not the reverse', () => {
  const held = { id: 'other', until: NOW + 9000, local: true }
  expect(shouldLead(held, 'me', NOW, true)).toBe(true)
  expect(shouldLead(held, 'me', NOW, false)).toBe(false)
  expect(shouldLead({ id: 'other', until: NOW + 9000 }, 'me', NOW, true)).toBe(false)
})

test('columnsOf: a session marked waiting needs the person, even mid-run, until dismissed; this session never does', () => {
  const base = { id: 'w', title: 't', cwd: '/x', isRunning: true, isSelf: false, lastActivityAt: new Date(NOW - 1000).toISOString(), isRemoteControlled: false, waitingFor: 'input needed' }
  expect(columnsOf([base], NOW).needsMe.map(s => s.id)).toEqual(['w'])
  expect(columnsOf([base], NOW, {}, { w: base.lastActivityAt }).running.map(s => s.id)).toEqual(['w'])
  expect(columnsOf([{ ...base, isSelf: true }], NOW).needsMe).toHaveLength(0)
  expect(columnsOf([{ ...base, isRunning: false }], NOW, {}, { w: base.lastActivityAt }).recent.map(s => s.id)).toEqual(['w'])
})

test('isOpenableLink takes the app and VS Code session links only', () => {
  expect(isOpenableLink(`claude://claude.ai/epitaxy/${LIVE_DESKTOP.hostSessionId}`)).toBe(true)
  expect(isOpenableLink(`vscode://anthropic.claude-code/open?session=${VS}`)).toBe(true)
  expect(isOpenableLink('vscode://anthropic.claude-code/install-plugin?plugin=x')).toBe(false)
  expect(isOpenableLink(`vscode://anthropic.claude-code/open?session=${VS}&x=1`)).toBe(false)
  expect(isOpenableLink('https://example.com')).toBe(false)
  expect(isOpenableLink(undefined)).toBe(false)
})

test('rateLimitsOf names the two windows and skips the rest', () => {
  expect(rateLimitsOf([{ kind: 'five_hour', percentUsed: 10.4 }, { kind: 'seven_day', percentUsed: 8 }, { kind: 'other', percentUsed: 1 }])).toEqual([
    { label: '5h', percent: 10, resetsIn: '' },
    { label: 'Weekly', percent: 8, resetsIn: '' },
  ])
  expect(rateLimitsOf([])).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  const mountHere = mountOn(surface)
  const mountBoard = async ($: Engine, on: On, overrides: Overrides = NO_APP) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const calls = fakeServer(on, overrides)
    world = machine()
    const ui = await mountHere($)
    await ui.press({ key: 'refresh' })
    return { ui, calls }
  }

  test(`${surface}: with no app tools the board draws from local files, with no error`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    expect(await ui.find({ text: /Could not load sessions/ })).toBeUndefined()
    expect(await ui.find({ text: /This session · Saving data/ })).toBeDefined()
    expect(await ui.find({ text: /A desktop session/ })).toBeDefined()
    expect(await ui.find({ text: /Saving the data/ })).toBeDefined() // the derived-name session's transcript title
    expect(await ui.find({ text: /My own title/ })).toBeDefined() // closed VS Code session
    await ui.unmount()
  })

  test(`${surface}: dead processes, script runs and closed desktop sessions stay off a local board`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    expect((await debugOf($)).liveIds).toContain(DERIVED)
    world.dead = [LIVE_DERIVED_NAME.pid]
    await ui.press({ key: 'refresh' })
    const info = await debugOf($)
    expect(info.liveIds).not.toContain(DERIVED) // its process is gone: it is a closed session now
    expect(await ui.find({ key: `reply-${DERIVED}` })).toBeUndefined()
    const ids = info.sessions.map((s: { id: string }) => s.id)
    expect(ids).not.toContain(CLOSED_DESKTOP)
    expect(ids).not.toContain(CLOSED_SCRIPT)
    expect(ids).toContain(CLOSED_TERMINAL)
    expect(ids).toContain(VS)
    expect(ids).toContain(LIVE_DESKTOP.hostSessionId)
    await ui.unmount()
  })

  test(`${surface}: neither source available shows the error`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, NO_APP)
    const ui = await mountHere($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /Could not load sessions: server not connected/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: without the tools, no Stop and no selects; the model is plain text`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    world.live = [LIVE_VSCODE, { ...LIVE_DERIVED_NAME, status: 'busy' }]
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: `stop-${DERIVED}` })).toBeUndefined()
    expect(await ui.find({ key: `card-${DERIVED}` })).toBeDefined()
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
    expect(await ui.find({ text: /Opus 5\.5/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: on the desktop, app sessions keep Stop and selects and VS Code ones appear beside them without`, async ($, on) => {
    const { ui, calls } = await mountBoard($, on, {
      list_sessions: () => listWith({ [RECENT]: { isRunning: true } }),
    })
    world.live = [{ ...LIVE_VSCODE, status: 'busy' }, { ...LIVE_DESKTOP, hostSessionId: RECENT, status: 'busy', waitingFor: undefined }]
    await ui.press({ key: 'refresh' })
    const info = await debugOf($)
    const ids = info.sessions.map((s: { id: string }) => s.id)
    expect(ids.filter((id: string) => id === RECENT)).toHaveLength(1)
    expect(ids).toContain(VS)
    expect(await ui.find({ key: `stop-${RECENT}` })).toBeDefined()
    expect(await ui.find({ key: `model-${RECENT}` })).toBeDefined()
    expect(await ui.find({ key: `stop-${VS}` })).toBeUndefined()
    expect(await ui.find({ key: `model-${VS}` })).toBeUndefined()
    // the app tools are not asked about a session they cannot know
    expect(askedOf(calls, 'get_session')).not.toContain(VS)
    expect(askedOf(calls, 'list_events')).not.toContain(VS)
    expect(askedOf(calls, 'get_usage')).not.toContain(VS)
    await ui.unmount()
  })

  test(`${surface}: a message to a live local session goes through session.send and says it starts a turn`, async ($, on) => {
    const { ui, calls } = await mountBoard($, on)
    await ui.input({ key: `msg-${DERIVED}`, text: 'hello' })
    expect(JSON.stringify(sends[0]?.to)).toContain(DERIVED)
    expect(sends[0]?.text).toBe('hello')
    expect(count(calls, 'send_message')).toBe(0)
    expect(await ui.find({ text: /starts a turn/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a refused session.send is shown as failed and keeps the draft`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    world.sendResult = { isDelivered: false, reason: 'no such peer' }
    await ui.input({ key: `msg-${DERIVED}`, text: 'hello' })
    expect(await ui.find({ text: /Send failed: no such peer/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a closed session has no message box`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    expect(await ui.find({ key: `reply-${CLOSED}` })).toBeUndefined()
    expect(await ui.find({ key: `msg-${CLOSED}` })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: Open on a VS Code session uses its link; a terminal session has no Open`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    await ui.press({ key: `open-${DERIVED}` })
    expect(runs.some(r => r[0] === '/usr/bin/open' && r[1] === `vscode://anthropic.claude-code/open?session=${DERIVED}`)).toBe(true)
    expect(await ui.find({ key: `open-${CLOSED_TERMINAL}` })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a waiting session sits in Needs me with its reason`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    expect(await ui.find({ text: /Waiting for you: input needed/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: usage and own context come from the session itself when there are no tools`, async ($, on) => {
    const { ui } = await mountBoard($, on)
    expect(await ui.find({ text: /Usage 5h 10% · Weekly 8%/ })).toBeDefined()
    const info = await debugOf($)
    expect(info.context[VS]).toBe(12)
    expect(info.hasApp).toBe(false)
    await ui.unmount()
  })

  test(`${surface}: a local-only leader marks its lease, and a session with the tools takes over`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = fakeStore(on)
    fakeServer(on, NO_APP)
    world = machine()
    const ui = await mountHere($)
    await ui.press({ key: 'refresh' })
    expect(store.get('lease')).toEqual({ id: VS, until: NOW + 9000, local: true })
    await ui.unmount()
  })

  test(`${surface}: the app tools take the lease from a local-only holder`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const store = fakeStore(on, { lease: { id: 'someone-in-vscode', until: NOW + 9000, local: true } })
    fakeServer(on)
    const ui = await mountHere($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect((store.get('lease') as { id: string }).id).toBe(SELF)
    await ui.unmount()
  })

  test(`${surface}: a session without tools follows a fresh board the desktop published`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const store = fakeStore(on, { lease: { id: SELF, until: NOW + 9000 }, board: { sessions: [{ id: 'local_x', title: 'Published', cwd: '/x', isRunning: false, isSelf: false, lastActivityAt: new Date(NOW - 1000).toISOString(), isRemoteControlled: false }, { id: VS, title: 'Me', cwd: '/x', isRunning: false, isSelf: false, lastActivityAt: new Date(NOW - 1000).toISOString(), isRemoteControlled: false }], usage: [], previews: {}, context: {}, refreshedAt: NOW - 1000, error: null } })
    const calls = fakeServer(on, NO_APP)
    world = machine()
    const ui = await mountHere($)
    await clock.advance(200)
    await new Promise(r => setTimeout(r, 50))
    expect(await ui.find({ text: /Published/ })).toBeDefined()
    expect(await ui.find({ text: /This session · Me/ })).toBeDefined()
    expect(count(calls, 'list_sessions')).toBe(0)
    expect((store.get('lease') as { id: string }).id).toBe(SELF)
    await ui.unmount()
  })
}

// Interface: what the real panel showed (solid blue buttons everywhere, raw markdown, a message box on every card)

test('plainPreview drops markdown marks and keeps the words', () => {
  expect(plainPreview('**核查通过：** 今天 `size` 列')).toBe('核查通过： 今天 size 列')
  expect(plainPreview('## 还没收尾的事 1. **API**')).toBe('还没收尾的事 1. API')
  expect(plainPreview('| 账户 | 运行时间 |\n|---|---|\n| a | b |')).toBe('账户 · 运行时间\na · b')
  expect(plainPreview('- first\n- second\n* third')).toBe('first\nsecond\nthird')
  expect(plainPreview('[the doc](https://x.y/z) and snake_case_name 2*3*4')).toBe('the doc and snake_case_name 2*3*4')
})

test('a summary long enough to clip is cleaned before it is clipped', () => {
  const s = summaryFromTranscript(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"**${'字'.repeat(138)}**"}]}}`)
  expect(s.answer).toBe('字'.repeat(138))
})

for (const surface of ['terminal', 'desktop'] as const) {
  const mountBoard = async ($: Engine, on: On, patches: Record<string, Patch> = {}) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT }, ...patches }) })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    return ui
  }

  test(`${surface}: a title is plain text with no button; opening is the Open button's job`, async ($, on) => {
    const ui = await mountBoard($, on)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.filter(b => String(b.props.key).startsWith('title-'))).toHaveLength(0)
    await ui.press({ key: `open-${RECENT}` })
    expect(runs.some(r => r[0] === '/usr/bin/open')).toBe(true)
    await ui.unmount()
  })

  test(`${surface}: the message box stays folded until Reply, and Reply again folds it`, async ($, on) => {
    const ui = await mountBoard($, on)
    expect(await ui.find({ key: `msg-${RECENT}` })).toBeUndefined()
    await ui.press({ key: `reply-${RECENT}` })
    expect(await ui.find({ key: `msg-${RECENT}` })).toBeDefined()
    await ui.press({ key: `reply-${RECENT}` })
    expect(await ui.find({ key: `msg-${RECENT}` })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a card in Needs me has its box open, since answering is what it wants`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }), list_events: () => ok(EVENTS_ASKING) })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: `msg-${RECENT}` })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: cards with the same title show their task; a one-off title does not`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT, title: 'Same' }, [ANSWERED]: { lastActivityAt: RECENT_AT, title: 'Same' } }), list_events: () => ok(EVENTS_RUNNING) })
    const twins = await mountOn(surface)($)
    await twins.press({ key: 'refresh' })
    expect(await twins.find({ key: `task-${RECENT}` })).toBeDefined()
    expect(await twins.find({ key: `task-${ANSWERED}` })).toBeDefined()
    await twins.unmount()
  })

  test(`${surface}: a finished card with its own title draws no task`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }), list_events: () => ok(EVENTS_RUNNING) })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: `task-${RECENT}` })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: this session's card comes last in its column`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, {
      list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }),
      get_session: args => ok(args.session_id === 'self' ? { ...GET_SESSION_SELF, isRunning: false, lastActivityAt: RECENT_AT } : { ...GET_SESSION_OTHER, sessionId: args.session_id }),
    })
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    const keys = (await ui.findAll({ type: 'Box' })).map(b => String(b.props.key)).filter(k => k.startsWith('card-'))
    expect(keys.indexOf(`card-${SELF}`)).toBeGreaterThan(keys.indexOf(`card-${RECENT}`))
    await ui.unmount()
  })

  test(`${surface}: housekeeping buttons are marked secondary, Open is not`, async ($, on) => {
    const ui = await mountBoard($, on)
    expect((await ui.find({ key: `shelve-${RECENT}` }))?.props.variant).toBe('secondary')
    expect((await ui.find({ key: 'refresh' }))?.props.variant).toBe('secondary')
    expect((await ui.find({ key: `open-${RECENT}` }))?.props.variant).toBeUndefined()
    await ui.unmount()
  })
}

// Needs me: whenever the agent asks for an opinion or a decision (user's definition, 2026-11-06)

test('a question in the next-step box counts, with the question itself, until it is answered', () => {
  const asked = summaryFromTranscript(TRANSCRIPT_NEXT_STEP)
  expect(asked.reason).toBe('next-step')
  expect(asked.needsInput).toBe(true)
  expect(asked.question).toBe('Deploy it to the server?')
  expect(asked.answer).toBe('All of it passed.')
  const answered = summaryFromTranscript(TRANSCRIPT_NEXT_STEP_ANSWERED)
  expect(answered.needsInput).toBe(false)
  expect(answered.question).toBeUndefined()
  // answered, and the turn after it has no box of its own
  const after = `${TRANSCRIPT_NEXT_STEP}\n{"type":"user","message":{"role":"user","content":"Yes"}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Deployed."}]}}`
  expect(summaryFromTranscript(after).needsInput).toBe(false)
})

test('a next-step box that only recaps is not a question', () => {
  expect(summaryFromTranscript(TRANSCRIPT_RECAP_ONLY).needsInput).toBe(false)
})

test('a question tool gives its question', () => {
  const s = summaryFromTranscript(TRANSCRIPT_ASK_TOOL)
  expect(s.reason).toBe('awaiting-answer')
  expect(s.question).toBe('Which folder?')
})

test('a question anywhere in the last paragraph counts, and is picked out of it', () => {
  const s = summaryFromTranscript(TRANSCRIPT_MID_PARAGRAPH)
  expect(s.reason).toBe('asked-question')
  expect(s.question).toBe('Should I do it now?')
  expect(summaryFromTranscript(TRANSCRIPT_ASKING).question).toBe('Should I push it?')
})

test('a question mark earlier in the reply, in code or in a link does not count', () => {
  expect(summaryFromTranscript(TRANSCRIPT_EARLIER_QUESTION).needsInput).toBe(false)
  expect(summaryFromTranscript(TRANSCRIPT_CODE_QUESTION).needsInput).toBe(false)
})

test('questionOf handles Chinese punctuation and has an answer only for a real question', () => {
  expect(questionOf('我建议先跑测试。要现在做吗？另外，请告诉我比例。')).toBe('要现在做吗？')
  expect(questionOf('第一段。\n\n没有问题。')).toBeUndefined()
  expect(summaryOf('[assistant] 改好了。要提交吗？另外记得看日志。').reason).toBe('asked-question')
  expect(summaryOf('[assistant] 改好了。要提交吗？另外记得看日志。').question).toBe('要提交吗？')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a desktop session's transcript supplies its next-step question, and the card shows it`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const calls = fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }) })
    world = {
      live: [{ ...LIVE_DESKTOP, hostSessionId: RECENT, status: 'idle', waitingFor: undefined }],
      projects: { p: { [jsonl(LIVE_DESKTOP.sessionId)]: { text: TRANSCRIPT_NEXT_STEP, mtimeMs: MTIME } } },
    }
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `needs-${RECENT}` }))?.text).toContain('Asks: Deploy it to the server?')
    expect(askedOf(calls, 'list_events')).not.toContain(RECENT)
    await ui.unmount()
  })

  test(`${surface}: a transcript with nothing readable falls back to the app's events`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const calls = fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }) })
    world = {
      live: [{ ...LIVE_DESKTOP, hostSessionId: RECENT, status: 'idle', waitingFor: undefined }],
      projects: { p: { [jsonl(LIVE_DESKTOP.sessionId)]: { text: '', mtimeMs: MTIME } } },
    }
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect(askedOf(calls, 'list_events')).toContain(RECENT)
    await ui.unmount()
  })

  test(`${surface}: a closed desktop session is still read when its transcript has the same name`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    fakeServer(on, { list_sessions: () => listWith({ [RECENT]: { lastActivityAt: RECENT_AT } }) })
    world = { live: [], projects: { p: { [jsonl(RECENT.slice('local_'.length))]: { text: TRANSCRIPT_NEXT_STEP.replaceAll('claude-vscode', 'claude-desktop'), mtimeMs: MTIME } } } }
    const ui = await mountOn(surface)($)
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: `needs-${RECENT}` }))?.text).toContain('Asks: Deploy it to the server?')
    await ui.unmount()
  })
}
