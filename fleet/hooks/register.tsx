import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetPlace, FleetWorker, WorkerState } from '../types'

type $ = EngineInterface

const workersAtom = atom({ plugin: 'fleet', key: 'workers' } as const, [])
const orchestratingAtom = atom({ plugin: 'fleet', key: 'isOrchestrating' } as const, false)
const placeAtom = atom({ plugin: 'fleet', key: 'place' } as const, null)
const briefingAtom = atom({ plugin: 'fleet', key: 'briefing' } as const, null)

// The live worker table. A hook that runs long reads $.state as it stood when the hook began, so the
// timer's updates would stay invisible to it; module memory is one table every hook and the timer
// share. $.state keeps a copy for drawing and for the next load of the module.
let table: FleetWorker[] | null = null

async function loadWorkers($: $): Promise<FleetWorker[]> {
  table ??= await read($, workersAtom)

  return table
}

async function updateWorkers($: $, change: (list: FleetWorker[]) => FleetWorker[]): Promise<FleetWorker[]> {
  const next = change(await loadWorkers($))
  table = next
  await update($, workersAtom, () => next)

  return next
}

const PANE = 'fleet'
const POLL_MS = 3000
// polls a worker's pane may sit idle with no DONE before it counts as stopped
const QUIET_POLLS = 3
const LIVE: readonly WorkerState[] = ['starting', 'working', 'idle', 'blocked']
// nested agent CLIs started from a shell: work the ledger and the grid never see
const NESTED_AGENT_RE = /(^|[;&|(`\s])(claude\s+(-p|--print)\b|codex\s+exec\b|opencode\s+run\b)/

// the older fleet stacks: a herdr-fleet skill or its wrapper script would run a second fleet beside horch
const OLD_FLEET_SKILL_RE = /^(herdr-fleet:|herdr:)?herdr-(orchestrate|orchestrator|worker|architect)$/
const OLD_FLEET_SCRIPT_RE = /herdr-fleet\.sh\b/
const OLD_FLEET =
  'fleet: this session orchestrates with horch. The herdr-fleet skills and herdr-fleet.sh are an older, separate fleet; use `horch spawn`, `horch assign`, `horch tell` and `horch sessions` instead.'

const isLive = (w: FleetWorker) => LIVE.includes(w.state)

// ---- horch and herdr ----

async function horchBin($: $): Promise<string> {
  const pinned = (await $.env.get('HORCH_BIN')) ?? ''
  if (pinned !== '') {
    return pinned
  }
  const installed = `${(await $.env.get('HOME')) ?? ''}/.local/bin/horch`

  return (await $.fs.exists(installed)) ? installed : 'horch'
}

type Ran = { code: number; out: string }

async function horch($: $, project: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15_000): Promise<Ran> {
  try {
    const ran = await $.process.run([await horchBin($), ...args], {
      cwd: project,
      env: { HORCH_PROJECT_DIR: project, ...env },
      timeoutMs,
    })

    return { code: ran.exitCode, out: [ran.stdout, ran.stderr].filter(Boolean).join('\n').trim() }
  } catch (error) {
    return { code: 127, out: `horch ${args[0] ?? ''} did not run: ${String(error)}` }
  }
}

// The herdr pane this session runs in, and its workspace. Null outside herdr.
async function findPlace($: $, project: string): Promise<FleetPlace | null> {
  const paneId = ((await $.env.get('HERDR_PANE_ID')) ?? '').trim()
  if (paneId === '') {
    return null
  }
  try {
    const ran = await $.process.run(['herdr', 'pane', 'get', paneId], { timeoutMs: 5000 })
    const pane = (JSON.parse(ran.stdout) as { result: { pane: { pane_id: string; workspace_id?: string } } }).result.pane
    if (pane.workspace_id === undefined) {
      return null
    }

    return { workspace: pane.workspace_id, paneId: pane.pane_id, project }
  } catch {
    return null
  }
}

async function paneStates($: $): Promise<Map<string, string> | null> {
  try {
    const ran = await $.process.run(['herdr', 'pane', 'list'], { timeoutMs: 5000 })
    if (ran.exitCode !== 0) {
      return null
    }
    const panes = (JSON.parse(ran.stdout) as { result: { panes: { pane_id: string; agent_status?: string }[] } }).result.panes

    return new Map(panes.map(p => [p.pane_id, p.agent_status ?? 'unknown']))
  } catch {
    return null
  }
}

// Registered roles in this workspace's mailbox, role -> pane id, as `horch inbox` prints them.
async function inbox($: $, place: FleetPlace): Promise<Map<string, string> | null> {
  const ran = await horch($, place.project, ['inbox'], { HORCH_WORKSPACE_ID: place.workspace })
  if (ran.code !== 0) {
    return null
  }
  const roles = new Map<string, string>()
  for (const line of ran.out.split('\n')) {
    const [role, pane] = line.trim().split(/\s+/)
    if (role !== undefined && pane !== undefined && /^[\w-]+$/.test(role) && pane.includes(':')) {
      roles.set(role, pane)
    }
  }

  return roles
}

type LedgerRecord = { role: string; tier: string; model: string; effort?: string | null; status: string; task: string; updated_at: string }

// The project's session ledger, newest record per role.
async function ledger($: $, place: FleetPlace): Promise<Map<string, LedgerRecord> | null> {
  const ran = await horch($, place.project, ['sessions', '--json'])
  if (ran.code !== 0) {
    return null
  }
  try {
    const records = JSON.parse(ran.out) as LedgerRecord[]
    const byRole = new Map<string, LedgerRecord>()
    for (const r of records) {
      const seen = byRole.get(r.role)
      if (seen === undefined || seen.updated_at <= r.updated_at) {
        byRole.set(r.role, r)
      }
    }

    return byRole
  } catch {
    return null
  }
}

// ---- the orchestrator role ----

// The role, kept in the store by session id: $.state is gone after a restart or resume, and an
// orchestrator that forgets its role silently stops being supervised.
const roleKey = (session: string) => `orchestrating:${session}`

type SavedRole = { project: string }

const briefingPath = (root: string, tag: string) => `${root}/briefing-${tag}.md`

const stateRoot = async ($: $) => `${(await $.env.get('HOME')) ?? ''}/.local/state/horch/fleet-mod`

// Becomes the workspace's orchestrator the way `horch fleet` makes one: `horch pane-launch` registers
// this pane as `orchestrator` and renders the briefing for a fresh claude. A stand-in claude records
// that launch instead of starting one, so this session takes the briefing horch would have given.
async function becomeOrchestrator($: $, project: string): Promise<{ briefing: string } | { problem: string }> {
  const place = await findPlace($, project)
  if (place === null) {
    return { problem: 'This session is not running inside a herdr pane, so horch cannot reach it. Start Claude Code from a herdr pane and run /orchestrate again.' }
  }
  const root = await stateRoot($)
  const tag = (await $.session.id()).slice(0, 8)
  const capture = `${root}/launch-${tag}.json`
  const kept = `${root}/bundle-${tag}`
  const standIn = `${root}/stand-in-claude.sh`
  await $.process.run(['mkdir', '-p', root])
  await $.fs.write(
    standIn,
    [
      '#!/bin/sh',
      '# Records the claude launch `horch pane-launch` would make, and keeps its skill bundle.',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "--plugin-dir" ]; then rm -rf "$FLEET_BUNDLE"; cp -R "$arg" "$FLEET_BUNDLE"; fi',
      '  prev="$arg"',
      'done',
      'python3 -c \'import json, os, sys; json.dump(sys.argv[1:], open(os.environ["FLEET_CAPTURE"], "w"))\' "$@"',
      '',
    ].join('\n'),
  )
  await $.process.run(['chmod', '+x', standIn])
  await $.process.run(['rm', '-f', capture])
  const launched = await horch(
    $,
    project,
    ['pane-launch', '--role', 'orchestrator', '--kind', 'fleet-orchestrator', '--model', 'opus'],
    { HORCH_CLAUDE_BIN: standIn, FLEET_CAPTURE: capture, FLEET_BUNDLE: kept, HERDR_PANE_ID: place.paneId },
    60_000,
  )
  if (!(await $.fs.exists(capture))) {
    return { problem: `horch could not make this pane the orchestrator:\n${launched.out}` }
  }
  const argv = JSON.parse(await $.fs.read(capture)) as string[]
  const prompt = argv[argv.length - 1] ?? ''
  const bundle = argv[argv.indexOf('--plugin-dir') + 1]
  // horch deletes its bundle when the launch ends; the briefing points at the copy kept above
  const briefing = bundle === undefined ? prompt : prompt.split(bundle).join(kept)
  await $.fs.write(briefingPath(root, tag), briefingBlock(briefing, place))
  await $.store.set(roleKey(await $.session.id()), { project } satisfies SavedRole)
  await update($, placeAtom, () => place)
  await update($, briefingAtom, () => briefing)
  await update($, orchestratingAtom, () => true)
  $.ui.invalidate('prompt.context')
  owesBriefing = true

  return { briefing }
}

// The briefing still owed to the model: a conversation's context blocks are computed once, so a role
// taken mid-conversation hands its briefing over with the next prompt that enters.
let owesBriefing = false

async function stopOrchestrating($: $): Promise<void> {
  owesBriefing = false
  await $.store.delete(roleKey(await $.session.id()))
  await update($, orchestratingAtom, () => false)
  $.ui.invalidate('prompt.context')
}

function briefingBlock(briefing: string, place: FleetPlace): string {
  return `${briefing}\n\n${modNotes(place)}`
}

// ---- watching the workers ----

const quiet = new Map<string, number>()

const NOTICE: Partial<Record<WorkerState, string>> = {
  blocked: 'is blocked on a prompt in its pane',
  idle: 'stopped without sending DONE (it may be waiting on your answer, or it lost its connection)',
  gone: 'closed without sending DONE (its pane is gone and the ledger has no summary)',
}

function nextState(w: FleetWorker, record: LedgerRecord | undefined, pane: string | undefined, agent: string | undefined): WorkerState {
  if (record?.status === 'done') {
    return 'done'
  }
  if (pane === undefined || agent === undefined) {
    return w.state === 'starting' && quietPolls(w.role) < QUIET_POLLS ? 'starting' : 'gone'
  }
  if (agent === 'blocked') {
    return 'blocked'
  }
  if (agent === 'working') {
    return 'working'
  }
  const wasRunning = w.state === 'working' || w.state === 'starting'

  return wasRunning && quietPolls(w.role) < QUIET_POLLS ? w.state : 'idle'
}

function quietPolls(role: string): number {
  return quiet.get(role) ?? 0
}

// One check at a time: two overlapping ones would each see the same change and announce it twice.
let checking: Promise<void> = Promise.resolve()
let lastFailure = ''

function check($: $, shouldWake = false): Promise<void> {
  checking = checking
    .then(() => checkFleet($, shouldWake))
    .then(() => {
      lastFailure = ''
    })
    .catch(error => {
      const failure = String(error)
      if (failure !== lastFailure) {
        lastFailure = failure
        $.ui.log(`fleet: status check failed: ${failure}`)
      }
    })

  return checking
}

// the horch fleet when this session orchestrates one, else any herdr-fleet workers in its workspace
async function checkFleet($: $, shouldWake: boolean): Promise<void> {
  if (await read($, orchestratingAtom)) {
    await checkOnce($, shouldWake)
  } else {
    await checkHerdrFleet($)
  }
}

async function wake($: $, text: string): Promise<void> {
  try {
    const entered = await $.prompt.submit({ text })
    if (entered.drop !== undefined) {
      $.ui.log(`fleet: could not wake the orchestrator: ${entered.drop}`)
    }
  } catch (error) {
    $.ui.log(`fleet: could not wake the orchestrator: ${String(error)}`)
  }
}

async function checkOnce($: $, shouldWake: boolean): Promise<void> {
  const place = await read($, placeAtom)
  if (place === null || !(await read($, orchestratingAtom))) {
    return
  }
  const [roles, records, panes, previous] = await Promise.all([inbox($, place), ledger($, place), paneStates($), loadWorkers($)])
  if (roles === null || records === null || panes === null) {
    return
  }
  const now = await $.clock.now()

  // every role in this workspace's mailbox but the orchestrator is a worker it owns
  const known = new Set(previous.map(w => w.role))
  const joined: FleetWorker[] = []
  for (const [role, paneId] of roles) {
    if (role === 'orchestrator' || known.has(role)) {
      continue
    }
    const r = records.get(role)
    joined.push({ role, teammate: r?.tier ?? role.replace(/-\d+$/, ''), model: r?.model ?? '?', effort: r?.effort ?? null, task: r?.task ?? '', paneId, state: 'starting', firstSeen: now })
  }

  const workers: FleetWorker[] = []
  const changes: { worker: FleetWorker; line: string }[] = []
  for (const w of [...previous, ...joined]) {
    if (!isLive(w)) {
      workers.push(w)
      continue
    }
    const record = records.get(w.role)
    const paneId = roles.get(w.role) ?? null
    const agent = paneId === null ? undefined : panes.get(paneId)
    const isQuiet = record?.status !== 'done' && agent !== 'working' && agent !== 'blocked'
    quiet.set(w.role, isQuiet ? quietPolls(w.role) + 1 : 0)
    const state = nextState(w, record, paneId ?? undefined, agent)
    const notice = NOTICE[state]
    if (state !== w.state && notice !== undefined && previous.includes(w)) {
      changes.push({ worker: w, line: `${w.role} ${notice}` })
    }
    if (state === 'done' && w.state !== 'done') {
      $.ui.toast(`fleet: ${w.role} is done`, { timeoutMs: 8000 })
    }
    workers.push({
      ...w,
      state,
      paneId: paneId ?? w.paneId,
      model: record?.model ?? w.model,
      effort: record?.effort ?? w.effort,
      task: record?.task ?? w.task,
    })
  }

  // a worker told something while this check ran is busy again: its change is stale, not news
  const current = await loadWorkers($)
  const settled: string[] = []
  for (const { worker, line } of changes) {
    if (current.includes(worker)) {
      $.ui.toast(`fleet: ${line}`, { timeoutMs: 10_000 })
      $.ui.log(`fleet: ${line}`)
      settled.push(line)
    }
  }
  if (!workers.some(isLive) && previous.some(isLive)) {
    $.ui.toast('fleet: all workers are done', { timeoutMs: 15_000 })
  }
  if (shouldWake && settled.length > 0) {
    void wake($, wakePrompt(settled, workers))
  }

  if (JSON.stringify(workers) !== JSON.stringify(previous)) {
    await updateWorkers($, list => [
      ...list.map(w => {
        const at = previous.indexOf(w)
        return at === -1 ? w : (workers[at] ?? w)
      }),
      ...workers.slice(previous.length),
    ])
  }
}

// ---- the older herdr-fleet stack, shown read-only ----

// A session that runs the older herdr-fleet (herdr-fleet.sh) keeps its workers in that fleet home's
// manifest, not in horch's mailbox. The tree shows them too, so the hierarchy is visible either way;
// that fleet waits on its own workers, so the mod neither wakes nor guards for it.

type ManifestRecord = { id: string; pane_id: string; workspace_id: string; persona?: string }

// The herdr place this session runs in, looked up once: undefined until looked, null outside herdr.
let sessionPlace: FleetPlace | null | undefined
// The herdr-fleet home whose workers the table shows, or null while it shows none of them.
let herdrFleetHome: string | null = null

async function fleetHome($: $): Promise<string> {
  const pinned = ((await $.env.get('FLEET_HOME')) ?? '').trim()

  return pinned !== '' ? pinned : `${(await $.env.get('HOME')) ?? ''}/.fleet`
}

const readOr = ($: $, path: string, fallback: string) => $.fs.read(path).catch(() => fallback)
const mtime = ($: $, path: string) => $.fs.stat(path).then(s => s.mtimeMs).catch(() => undefined)

// A worker is done with its current brief once it writes report.md: a new assignment stages a newer
// brief.md and moves the old report aside.
async function hasReported($: $, dir: string): Promise<boolean> {
  const [brief, report] = await Promise.all([mtime($, `${dir}/brief.md`), mtime($, `${dir}/report.md`)])

  return report !== undefined && (brief === undefined || report >= brief)
}

async function personaModel($: $, persona: string | undefined): Promise<string> {
  const text = persona === undefined ? '' : await readOr($, persona, '')
  const model = /^model:\s*(\S+)/m.exec(text)?.[1]

  return model === undefined ? '?' : model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function briefTitle(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''

  return line.replace(/^#+\s*/, '').replace(/^Brief:\s*/i, '')
}

// This session's herdr-fleet workers: the newest manifest record per worker in this session's workspace,
// where herdr-fleet.sh puts the workers of the orchestrator running in it.
async function herdrFleetWorkers($: $): Promise<{ home: string; workers: FleetWorker[] } | null> {
  sessionPlace ??= await findPlace($, '')
  if (sessionPlace === null) {
    return null
  }
  const home = await fleetHome($)
  const state = `${home}/.herdr-fleet`
  const newest = new Map<string, ManifestRecord>()
  for (const line of (await readOr($, `${state}/manifest.jsonl`, '')).split('\n')) {
    try {
      const r = JSON.parse(line) as ManifestRecord
      if (r.workspace_id === sessionPlace.workspace && r.pane_id !== sessionPlace.paneId) {
        newest.set(r.id, r)
      }
    } catch {
      // a partial line mid-write: the next poll reads it whole
    }
  }
  if (newest.size === 0) {
    return null
  }
  const panes = await paneStates($)
  if (panes === null) {
    return null
  }
  const now = await $.clock.now()
  const workers = await Promise.all(
    [...newest.values()].map(async (r): Promise<FleetWorker> => {
      const dir = `${state}/workers/${r.id}`
      const agent = panes.get(r.pane_id)
      const isDone = agent !== 'working' && agent !== 'blocked' && (await hasReported($, dir))
      const workerState: WorkerState = isDone
        ? 'done'
        : agent === 'working' || agent === 'blocked'
          ? agent
          : agent === undefined
            ? 'gone'
            : 'idle'

      return {
        role: r.id,
        teammate: (r.persona ?? '').replace(/^.*\//, '').replace(/\.md$/, ''),
        model: await personaModel($, r.persona),
        effort: null,
        task: briefTitle(await readOr($, `${dir}/brief.md`, '')),
        paneId: r.pane_id,
        state: workerState,
        firstSeen: now,
      }
    }),
  )

  return { home, workers }
}

async function checkHerdrFleet($: $): Promise<void> {
  const found = await herdrFleetWorkers($)
  if (found === null && herdrFleetHome === null) {
    return
  }
  const previous = await loadWorkers($)
  const workers = (found?.workers ?? []).map(w => {
    const seen = previous.find(p => p.role === w.role)
    if (seen !== undefined && isLive(seen) && w.state === 'done') {
      $.ui.toast(`fleet: ${w.role} is done`, { timeoutMs: 8000 })
    }

    return { ...w, firstSeen: seen?.firstSeen ?? w.firstSeen }
  })
  if (herdrFleetHome !== null && previous.some(isLive) && workers.length > 0 && !workers.some(isLive)) {
    $.ui.toast('fleet: all workers are done', { timeoutMs: 15_000 })
  }
  herdrFleetHome = found?.home ?? null
  if (JSON.stringify(workers) !== JSON.stringify(previous)) {
    await updateWorkers($, () => workers)
  }
}

function wakePrompt(settled: string[], workers: FleetWorker[]): string {
  const live = workers.filter(isLive).map(w => `${w.role} (${w.state})`)

  return [
    'Fleet update - workers you own need you, and none of them sent DONE:',
    ...settled.map(line => `- ${line}`),
    `Still live: ${live.length > 0 ? live.join(', ') : 'none'}.`,
    'Look at each one: `herdr pane read <pane> --source visible --lines 40`, and check `horch sessions`.',
    'Then answer it with `horch tell <role> "<message>"`, respawn the unit with `horch spawn --resume <record-id>`, or tell the person what needs them.',
  ].join('\n')
}

// ---- the hierarchy ----

function shortTask(task: string): string {
  const oneLine = task.replace(/\s+/g, ' ').trim()

  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine
}

function summary(workers: FleetWorker[]): string {
  const live = workers.filter(isLive).length
  const done = workers.filter(w => w.state === 'done').length
  const stuck = workers.filter(w => w.state === 'blocked' || w.state === 'idle' || w.state === 'gone').length

  return `${live} live${stuck > 0 ? `, ${stuck} need you` : ''}${done > 0 ? `, ${done} done` : ''}`
}

function treeText(workers: FleetWorker[]): string {
  const rows = [`Orchestrator (this session) - ${summary(workers)}`]
  workers.forEach((w, i) => {
    const branch = i === workers.length - 1 ? '└─' : '├─'
    rows.push(`${branch} ${w.role}  ${w.model}${w.effort === null ? '' : `/${w.effort}`}  ${w.state}  ${shortTask(w.task)}`)
  })
  if (workers.length === 0) {
    rows.push('└─ (no workers yet)')
  }

  return rows.join('\n')
}

function footer(isOrchestrating: boolean, place: FleetPlace | null): string {
  if (isOrchestrating && place !== null) {
    return `horch · project ${place.project} · workspace ${place.workspace}`
  }

  return herdrFleetHome === null ? 'not orchestrating' : `herdr-fleet · ${herdrFleetHome} · workspace ${sessionPlace?.workspace ?? '?'}`
}

const STATE_COLOR: Record<WorkerState, string | undefined> = {
  starting: 'yellow',
  working: 'cyan',
  idle: 'yellow',
  blocked: 'red',
  done: 'green',
  gone: 'red',
}

// ---- system prompt ----

function modNotes(place: FleetPlace): string {
  return [
    '## Fleet mod: you are a horch orchestrator inside an existing session',
    `The briefing above is the one \`horch fleet\` gives its orchestrator; this session took it over with /orchestrate. Project: ${place.project}. Run every horch command from that directory.`,
    'Where it names a horch:<skill>, Read <skills dir>/<skill>/SKILL.md from the path it gives; the skills are files here, not loaded skills.',
    'The fleet mod watches the workers: "[<role>] ..." lines are worker messages typed into this session, and "Fleet update" prompts come from the mod when a worker stops, blocks or closes without DONE.',
    'The person sees the hierarchy live above the prompt and with /fleet.',
    'Keep the run moving: a question from the person mid-run does not pause it. Answer in a line or two, then carry on in the same turn.',
    'Never end a turn on a plan ("next I review and merge"): do the next step now.',
    'End a turn only while workers are running (their DONE or a Fleet update wakes you) or when you need the person, and then say exactly what you need from them.',
    'Never poll, sleep or loop waiting on a worker: end your turn, and its DONE line or a Fleet update starts your next one.',
    'Your own writes are plan files under ai_docs/ and scratch notes under /tmp; edits to the project go to workers.',
    'horch is the only fleet here: do not load a herdr-fleet skill or run herdr-fleet.sh, which belong to an older fleet.',
  ].join('\n')
}

const DELEGATE =
  'fleet: you are the orchestrator. Write the change into a plan file under ai_docs/plans/ and hand it to a worker with `horch spawn` or `horch assign`.'

async function isOrchestratorWrite($: $, path: string): Promise<boolean> {
  const place = await read($, placeAtom)
  const roots = ['/tmp/', '/private/tmp/', ...(place === null ? [] : [`${place.project.replace(/\/$/, '')}/ai_docs/`])]

  return roots.some(root => path.startsWith(root))
}

async function restoreRole($: $): Promise<void> {
  const isReload = (await read($, briefingAtom)) !== null
  const saved = (await $.store.get(roleKey(await $.session.id()))) as SavedRole | undefined
  if (saved === undefined || saved === null) {
    return
  }
  const became = await becomeOrchestrator($, saved.project)
  if ('problem' in became) {
    $.ui.log(`fleet: could not restore the orchestrator role: ${became.problem}`)
  }
  if (isReload) {
    owesBriefing = false
  }
}

function orchestrationPrompt(task: string, briefingFile: string): string {
  return [
    `You are now the horch fleet orchestrator for this task. Your briefing is ${briefingFile}: Read all of it before anything else, and follow it.`,
    'Run it through the core loop: decompose, write one plan file per unit under ai_docs/plans/, `horch spawn` the workers, verify each DONE, and report.',
    'Do not do the work yourself.',
    '',
    `Task: ${task}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'fleet', description: 'Show the horch fleet this session orchestrates' })
    await $.command.register({
      name: 'orchestrate',
      description: 'Make this session the horch fleet orchestrator: /orchestrate <task>, or /orchestrate stop',
    })
    await restoreRole($)

    // the horch fleet when orchestrating, else any herdr-fleet workers in this session's workspace
    $.clock.every(POLL_MS, () => void check($, true))

    return started
  })

  // ---- commands ----

  on('command.run', { command: 'fleet' }, async $ => {
    await check($)
    await $.ui.open({ id: PANE, title: 'Fleet' })

    return { text: treeText(await loadWorkers($)) }
  })

  on('command.run', { command: 'orchestrate' }, async ($, e) => {
    const task = e.args.trim()
    if (task === 'stop') {
      await stopOrchestrating($)

      return { text: 'This session is no longer the fleet orchestrator. Workers it started keep running.' }
    }
    const project = await $.session.cwd()
    const became = await becomeOrchestrator($, project)
    if ('problem' in became) {
      return { text: became.problem }
    }
    await check($)
    await $.ui.open({ id: PANE, title: 'Fleet' })
    if (task.length > 0) {
      // the task points at the briefing file: a prompt this plugin submits carries no context of its own
      owesBriefing = false
      const file = briefingPath(await stateRoot($), (await $.session.id()).slice(0, 8))
      // a command may not submit while it holds the session; queue it for just after
      $.clock.after(0, () => void $.prompt.submit({ text: orchestrationPrompt(task, file), asUser: true }).catch(() => undefined))
    }

    return {
      text: `Orchestrating the horch fleet for ${project}. ${task.length > 0 ? 'Task queued.' : 'What should the fleet work on?'}`,
    }
  })

  // ---- the briefing, as context the conversation carries ----

  // The system prompt is rendered once per session, so a briefing taken mid-session rides in the
  // context blocks instead: re-read whenever the role changes, and again after compaction or /clear.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const briefing = await read($, briefingAtom)
    const place = await read($, placeAtom)
    if (!(await read($, orchestratingAtom)) || briefing === null || place === null) {
      return context
    }

    owesBriefing = false

    return { ...context, blocks: [...context.blocks, { name: 'fleetOrchestrator', text: briefingBlock(briefing, place) }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const briefing = await read($, briefingAtom)
    const place = await read($, placeAtom)
    if (!owesBriefing || briefing === null || place === null || !(await read($, orchestratingAtom))) {
      return next(e)
    }
    owesBriefing = false

    return next({ ...e, context: [...(e.context ?? []), `# fleetOrchestrator\n${briefingBlock(briefing, place)}`] })
  })

  // ---- the orchestrator delegates; it does not do the work ----

  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    e.agentId === undefined && (await read($, orchestratingAtom)) && !(await isOrchestratorWrite($, e.file_path)) ? { deny: DELEGATE } : next(e),
  )
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    e.agentId === undefined && (await read($, orchestratingAtom)) && !(await isOrchestratorWrite($, e.file_path)) ? { deny: DELEGATE } : next(e),
  )
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    e.agentId === undefined && (await read($, orchestratingAtom)) ? { deny: DELEGATE } : next(e),
  )
  on('tool.call', { tool: 'Agent' }, async ($, e, next) =>
    e.agentId === undefined && (await read($, orchestratingAtom))
      ? { deny: 'fleet: no subagents in a horch fleet. Spawn a worker with `horch spawn` so the work shows in the ledger and the grid.' }
      : next(e),
  )
  on('tool.call', { tool: 'Skill' }, async ($, e, next) =>
    e.agentId === undefined && OLD_FLEET_SKILL_RE.test(e.skill) && (await read($, orchestratingAtom)) ? { deny: OLD_FLEET } : next(e),
  )
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isOrchestrator = e.agentId === undefined && (await read($, orchestratingAtom))
    if (isOrchestrator && NESTED_AGENT_RE.test(e.command)) {
      return { deny: 'fleet: no nested agent CLIs from the orchestrator. Spawn a worker with `horch spawn` instead.' }
    }
    if (isOrchestrator && OLD_FLEET_SCRIPT_RE.test(e.command)) {
      return { deny: OLD_FLEET }
    }
    const ran = await next(e)
    // a spawn, assign or tell changes who is working: look now, not at the next poll
    if (/\bhorch\s+(spawn|assign|tell)\b/.test(e.command) && (await read($, orchestratingAtom))) {
      await resetQuiet($, e.command)
      void check($)
    }

    return ran
  })

  // ---- the hierarchy, drawn ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const workers = await read($, workersAtom)
    const place = await read($, placeAtom)
    const isOrchestrating = await read($, orchestratingAtom)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text bold>Orchestrator</Text>
          <Text dimColor> this session · {summary(workers)}</Text>
        </Box>
        {workers.length === 0 && <Text dimColor>└─ no workers yet</Text>}
        {workers.map((w, i) => (
          <Box key={w.role}>
            <Text dimColor>{i === workers.length - 1 ? '└─ ' : '├─ '}</Text>
            <Text bold={isLive(w)} dimColor={w.state === 'done'}>{w.role}</Text>
            <Text dimColor> {w.model}{w.effort === null ? '' : `/${w.effort}`} </Text>
            <Text color={STATE_COLOR[w.state]}>{w.state}</Text>
            <Text dimColor wrap="truncate-end"> {shortTask(w.task)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>{footer(isOrchestrating, place)}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const workers = await read($, workersAtom)
    const shown = workers.filter(isLive)
    if (e.props.hasSurvey || shown.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text bold>Orchestrator</Text>
        <Text dimColor> ▸ </Text>
        {shown.map((w, i) => (
          <Text key={w.role}>
            {i > 0 ? ' · ' : ''}
            {w.role} <Text color={STATE_COLOR[w.state]}>{w.state}</Text>
          </Text>
        ))}
        <Text dimColor>  /fleet</Text>
      </Box>
    )
  })
}

// A worker the orchestrator just spoke to is busy again: its quiet count starts over.
async function resetQuiet($: $, command: string): Promise<void> {
  const workers = await loadWorkers($)
  const named = workers.filter(w => new RegExp(`\\bhorch\\s+(assign|tell)\\s+['"]?${w.role}\\b`).test(command))
  if (named.length === 0) {
    return
  }
  for (const w of named) {
    quiet.set(w.role, 0)
  }
  await updateWorkers($, list => list.map(w => (named.includes(w) && isLive(w) ? { ...w, state: 'working' } : w)))
}
