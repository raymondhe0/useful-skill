import type { EngineInterface } from 'claude-code'

import type { BoardSession } from '../types'
import {
  asLiveFile,
  displayTitle,
  isListedWhenClosed,
  linkOf,
  liveToSession,
  summaryFromTranscript,
  transcriptMeta,
  type LiveFile,
  type TranscriptMeta,
} from './logic'

const SCAN_MS = 15_000
const CLOSED_LIMIT = 100
const READ_BATCH = 8
const META_TAIL = 65_536
const META_HEAD = 16_384
const PREVIEW_TAIL = 262_144
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

type Transcript = { id: string; path: string; mtimeMs: number }

let scannedAt = -Infinity
let index = new Map<string, Transcript>()
const metaCache = new Map<string, TranscriptMeta & { mtimeMs: number }>()

export async function claudeDir($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude` : undefined
}

async function readLiveFiles($: EngineInterface, root: string): Promise<LiveFile[]> {
  const dir = `${root}/sessions`
  const entries = await $.fs.list(dir)
  const out: LiveFile[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    try {
      const live = asLiveFile(JSON.parse(await $.fs.read(`${dir}/${e.name}`)))
      if (live) out.push(live)
    } catch {
      // a file being replaced or removed right now
    }
  }
  return out
}

// A session that crashed leaves its file behind. If ps itself cannot run, nothing is dropped.
async function dropDead($: EngineInterface, files: LiveFile[]): Promise<LiveFile[]> {
  if (files.length === 0) return files
  try {
    const { exitCode, stdout } = await $.process.run(['/bin/ps', '-o', 'pid=', '-p', files.map(f => f.pid).join(',')], { timeoutMs: 5_000 })
    const alive = new Set(stdout.split('\n').map(l => Number(l.trim())).filter(Boolean))
    if (exitCode === 0 && alive.size === 0) return files
    return files.filter(f => alive.has(f.pid))
  } catch {
    return files
  }
}

async function scanTranscripts($: EngineInterface, root: string): Promise<Map<string, Transcript>> {
  const out = new Map<string, Transcript>()
  const projects = `${root}/projects`
  let dirs: { name: string; kind: string }[]
  try {
    dirs = await $.fs.list(projects)
  } catch {
    return out
  }
  for (const d of dirs) {
    if (d.kind !== 'dir') continue
    try {
      for (const f of await $.fs.list(`${projects}/${d.name}`)) {
        if (f.kind !== 'file' || !SESSION_FILE.test(f.name)) continue
        const id = f.name.slice(0, -'.jsonl'.length)
        const seen = out.get(id)
        if (!seen || seen.mtimeMs < f.mtimeMs) out.set(id, { id, path: `${projects}/${d.name}/${f.name}`, mtimeMs: f.mtimeMs })
      }
    } catch {
      // a folder removed mid-scan
    }
  }
  return out
}

async function slice($: EngineInterface, tool: 'tail' | 'head', bytes: number, path: string): Promise<string> {
  // $.fs.read refuses large files, and a transcript's useful lines are at its ends.
  const { exitCode, stdout } = await $.process.run([`/usr/bin/${tool}`, '-c', String(bytes), path], { timeoutMs: 5_000 })
  return exitCode === 0 ? stdout : ''
}

export async function readTail($: EngineInterface, path: string): Promise<string> {
  return slice($, 'tail', PREVIEW_TAIL, path)
}

async function metaOf($: EngineInterface, t: Transcript): Promise<TranscriptMeta> {
  const cached = metaCache.get(t.id)
  if (cached && cached.mtimeMs === t.mtimeMs) return cached
  let meta: TranscriptMeta = {}
  try {
    meta = transcriptMeta(await slice($, 'tail', META_TAIL, t.path))
    if (!meta.title || !meta.entrypoint || !meta.cwd) {
      const head = transcriptMeta(await slice($, 'head', META_HEAD, t.path))
      meta = { title: meta.title ?? cached?.title ?? head.title, entrypoint: meta.entrypoint ?? head.entrypoint, cwd: meta.cwd ?? head.cwd }
    }
  } catch {
    meta = cached ?? {}
  }
  metaCache.set(t.id, { ...meta, mtimeMs: t.mtimeMs })
  return meta
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += READ_BATCH) out.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(work))))
  return out
}

// Every session this machine knows of, live or closed. Live ones are re-stated every poll; the folder scan
// behind closed ones runs less often, or at once when a live session has no transcript on record yet.
export async function readLocalSessions($: EngineInterface, now: number): Promise<BoardSession[]> {
  const root = await claudeDir($)
  if (!root) return []
  let live: LiveFile[]
  try {
    live = await dropDead($, await readLiveFiles($, root))
  } catch {
    live = []
  }
  if (now - scannedAt >= SCAN_MS || live.some(f => !index.has(f.sessionId))) {
    index = await scanTranscripts($, root)
    scannedAt = now
  }

  const liveRows = await inBatches(live, async f => {
    const known = index.get(f.sessionId)
    let transcript = known
    if (known) {
      try {
        transcript = { ...known, mtimeMs: (await $.fs.stat(known.path)).mtimeMs }
      } catch {
        transcript = known
      }
    }
    const meta = transcript ? await metaOf($, transcript) : {}
    return liveToSession(f, displayTitle(f, meta), transcript?.mtimeMs ?? 0, transcript?.path, now)
  })

  const liveIds = new Set(live.map(f => f.sessionId))
  const closed = [...index.values()].filter(t => !liveIds.has(t.id)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, CLOSED_LIMIT)
  const closedRows = await inBatches(closed, async (t): Promise<BoardSession | undefined> => {
    const meta = await metaOf($, t)
    if (!isListedWhenClosed(meta.entrypoint)) return undefined
    return {
      id: t.id,
      title: displayTitle(undefined, meta),
      cwd: meta.cwd ?? '',
      isRunning: false,
      isSelf: false,
      lastActivityAt: new Date(t.mtimeMs).toISOString(),
      link: linkOf(meta.entrypoint, t.id),
      isRemoteControlled: false,
      transcript: t.path,
    }
  })
  return [...liveRows, ...closedRows.filter((s): s is BoardSession => s !== undefined)]
}

export async function previewFromTranscript($: EngineInterface, path: string) {
  return summaryFromTranscript(await readTail($, path))
}

// This session's id on the board: its app id if it has one, else its transcript id.
export async function localSelfId($: EngineInterface): Promise<string | undefined> {
  let own: string
  try {
    own = await $.session.id()
  } catch {
    return undefined
  }
  const root = await claudeDir($)
  if (!root) return own
  try {
    const mine = (await readLiveFiles($, root)).find(f => f.sessionId === own)
    return mine?.hostSessionId ?? own
  } catch {
    return own
  }
}
