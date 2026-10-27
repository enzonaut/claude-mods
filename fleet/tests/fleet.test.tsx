import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/op'
const PROJECT = '/work/app'
const MOD_STATE = `${HOME}/.local/state/horch/fleet-mod`
const BUNDLE = `${HOME}/.local/state/horch/skill-bundles/abc`

type Record = { record_id: string; role: string; tier: string; model: string; effort: string | null; status: string; task: string; updated_at: string }

// The world beneath the mod: horch's mailbox and ledger, and herdr's panes.
function world(on: On) {
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const roles = new Map<string, string>()
  const panes = new Map<string, string>([['w9:p1', 'working']])
  const ledger: Record[] = []
  const calls: string[][] = []
  let tick = 0

  mock.env(on, { HOME, HERDR_PANE_ID: 'w9:p1' })
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 'sess-1234567890' }))
  on('session.cwd', () => ({ value: PROJECT }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  const mtimes = new Map<string, number>()
  on('fs.stat', ($, e) => {
    const at = mtimes.get(e.path)
    if (at === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: at, isLink: false } } as never
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'today' }] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'herdr' && argv[1] === 'pane' && argv[2] === 'get') {
      return ok(JSON.stringify({ result: { pane: { pane_id: argv[3], workspace_id: 'w9' } } }))
    }
    if (argv[0] === 'herdr') {
      return ok(JSON.stringify({ result: { panes: [...panes].map(([pane_id, agent_status]) => ({ pane_id, agent_status })) } }))
    }
    if (argv[0] === 'horch') {
      const verb = argv[1]
      if (verb === 'pane-launch') {
        roles.set('orchestrator', e.init?.env?.HERDR_PANE_ID ?? '?')
        const capture = e.init?.env?.FLEET_CAPTURE ?? ''
        files.set(capture, JSON.stringify(['--model', 'opus', '--plugin-dir', BUNDLE, `Skills under ${BUNDLE}/skills.\nYou are the ORCHESTRATOR.`]))
      }
      if (verb === 'inbox') {
        return ok([...roles].map(([role, pane]) => `${role.padEnd(12)} ${pane}`).join('\n') || 'no roles registered yet')
      }
      if (verb === 'sessions') {
        return ok(JSON.stringify(ledger))
      }
    }
    return ok()
  })

  return {
    clock,
    files,
    store,
    calls,
    panes,
    // `horch spawn`: a pane, a mailbox role and a ledger record
    spawn: (role: string, teammate = 'sonnet') => {
      const pane = `w9:p${role.length + roles.size + 1}`
      roles.set(role, pane)
      panes.set(pane, 'working')
      ledger.push({ record_id: `r-${role}`, role, tier: teammate, model: teammate, effort: 'low', status: 'working', task: `Read and follow ai_docs/plans/${role}.md exactly.`, updated_at: `2026-10-08T00:00:0${tick++}Z` })
      return pane
    },
    // `horch done`: the ledger says done, the role leaves the mailbox, the pane closes
    done: (role: string) => {
      const pane = roles.get(role) ?? ''
      roles.delete(role)
      panes.delete(pane)
      const record = ledger.find(r => r.role === role)
      if (record !== undefined) record.status = 'done'
    },
    // the pane goes away with no `horch done`
    crash: (role: string) => {
      panes.delete(roles.get(role) ?? '')
      roles.delete(role)
    },
    paneOf: (role: string) => roles.get(role) ?? '',
    // a file of the older herdr-fleet, written at a given time
    put: (path: string, text: string, at: number) => {
      files.set(path, text)
      mtimes.set(path, at)
    },
  }
}

async function orchestrate($: { command: { run: (input: never) => Promise<unknown> } }, args = '') {
  return $.command.run({ command: 'orchestrate', args, origin: { kind: 'user' }, presentation: {} } as never)
}

const CONTEXT = { blocks: [] } as never
const denied = (ran: { deny?: string; text?: string; isError?: true }) => ran.deny ?? (ran.isError ? ran.text : undefined)
const start = { cwd: PROJECT, surface: 'terminal', isInteractive: true } as never

describe('fleet on horch', () => {
  test('/orchestrate registers this pane as the orchestrator and carries the briefing horch would give', async ($, on) => {
    const w = world(on)
    const entered: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      entered.push(e.context)
      return { text: e.text } as never
    })
    await $.session.start(start)
    const ran = (await orchestrate($)) as { text: string }
    expect(ran.text).toMatch(/Orchestrating the horch fleet for \/work\/app/)

    const launch = w.calls.find(c => c[1] === 'pane-launch') ?? []
    expect(launch).toEqual(['horch', 'pane-launch', '--role', 'orchestrator', '--kind', 'fleet-orchestrator', '--model', 'opus'])
    expect(w.files.get(`${MOD_STATE}/stand-in-claude.sh`)).toMatch(/FLEET_CAPTURE/)

    const { blocks } = await $.prompt.context(CONTEXT)
    expect(blocks.map(b => b.name)).toEqual(['currentDate', 'fleetOrchestrator'])
    const briefing = blocks.find(b => b.name === 'fleetOrchestrator')?.text ?? ''
    expect(briefing).toContain('You are the ORCHESTRATOR.')
    expect(briefing).toContain(`${MOD_STATE}/bundle-sess-123/skills`)
    expect(briefing).not.toContain(BUNDLE)
    expect(briefing).toMatch(/Project: \/work\/app/)

    // taken mid-conversation, the briefing rides with the next prompt, once
    await orchestrate($)
    await $.prompt.submit({ text: 'build it' } as never)
    await $.prompt.submit({ text: 'and then?' } as never)
    expect(entered[0]?.[0]).toMatch(/^# fleetOrchestrator\nSkills under[\s\S]*You are the ORCHESTRATOR/)
    expect(entered[1]).toBeUndefined()
  })

  test('/orchestrate with a task queues it, pointing at the briefing file', async ($, on) => {
    const w = world(on)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text } as never
    })
    await $.session.start(start)
    const ran = (await orchestrate($, ' make two files ')) as { text: string }
    expect(ran.text).toMatch(/Task queued/)
    await w.clock.advance(1)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatch(new RegExp(`Your briefing is ${MOD_STATE}/briefing-sess-123\\.md[\\s\\S]*Task: make two files$`))
    expect(w.files.get(`${MOD_STATE}/briefing-sess-123.md`)).toMatch(/You are the ORCHESTRATOR[\s\S]*Never poll, sleep or loop/)
  })

  test('a worker that sends DONE settles quietly; one that stops, blocks or crashes wakes the orchestrator', async ($, on) => {
    const w = world(on)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text } as never
    })
    await $.session.start(start)
    await orchestrate($)
    w.spawn('sonnet-1')
    w.spawn('sonnet-2')
    w.spawn('sonnet-3')
    await w.clock.advance(3000)
    await w.clock.advance(3000)

    w.done('sonnet-1')
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(0)

    w.panes.set(w.paneOf('sonnet-2'), 'blocked')
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatch(/Fleet update[\s\S]*sonnet-2 is blocked/)

    w.crash('sonnet-3')
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toMatch(/sonnet-3 closed without sending DONE/)

    const shown = (await $.command.run({ command: 'fleet', args: '', origin: { kind: 'user' }, presentation: {} } as never)) as { text: string }
    expect(shown.text).toMatch(/├─ sonnet-1 {2}sonnet\/low {2}done/)
    expect(shown.text).toMatch(/sonnet-2 {2}sonnet\/low {2}blocked/)
    expect(shown.text).toMatch(/└─ sonnet-3 {2}sonnet\/low {2}gone/)
  })

  test('a worker idle with no DONE wakes the orchestrator once, after a few quiet polls', async ($, on) => {
    const w = world(on)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text } as never
    })
    await $.session.start(start)
    await orchestrate($)
    w.spawn('sonnet-1')
    await w.clock.advance(3000)
    await w.clock.advance(3000)

    w.panes.set(w.paneOf('sonnet-1'), 'idle')
    await w.clock.advance(3000)
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(0)
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatch(/sonnet-1 stopped without sending DONE/)
    await w.clock.advance(3000)
    expect(submitted).toHaveLength(1)
  })

  test('a restarted session is still the orchestrator; /orchestrate stop forgets it', async ($, on) => {
    const w = world(on)
    w.store.set('orchestrating:sess-1234567890', { project: PROJECT })
    await $.session.start(start)
    expect(w.calls.some(c => c[1] === 'pane-launch')).toBe(true)
    const { blocks } = await $.prompt.context(CONTEXT)
    expect(blocks.map(b => b.name)).toContain('fleetOrchestrator')

    await orchestrate($, 'stop')
    expect(w.store.has('orchestrating:sess-1234567890')).toBe(false)
  })

  test('the orchestrator writes plans, not code, and starts no subagents or nested agent CLIs', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)
    on('tool.call', { tool: 'Write' }, () => ({ result: {} }) as never)
    on('tool.call', { tool: 'Agent' }, () => ({ result: {} }) as never)
    on('tool.call', { tool: 'Bash' }, () => ({ result: {} }) as never)
    on('tool.call', { tool: 'Skill' }, () => ({ result: {} }) as never)
    await $.session.start(start)
    await orchestrate($)

    const edit = (await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/src/main.rs` } as never))
    expect(denied(edit as never)).toMatch(/plan file under ai_docs\/plans/)
    const plan = (await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/ai_docs/plans/a.md` } as never))
    expect(denied(plan as never)).toBeUndefined()
    const agent = (await $.tool.call({ tool: 'Agent', prompt: 'x' } as never))
    expect(denied(agent as never)).toMatch(/no subagents/)
    const nested = (await $.tool.call({ tool: 'Bash', command: 'cd x && claude -p "do it"' } as never))
    expect(denied(nested as never)).toMatch(/no nested agent CLIs/)
    const spawn = (await $.tool.call({ tool: 'Bash', command: 'horch spawn sonnet "Read and follow ai_docs/plans/a.md exactly."' } as never))
    expect(denied(spawn as never)).toBeUndefined()
    const oldSkill = await $.tool.call({ tool: 'Skill', skill: 'herdr-fleet:herdr-orchestrate' } as never)
    expect(denied(oldSkill as never)).toMatch(/older, separate fleet/)
    const oldScript = await $.tool.call({ tool: 'Bash', command: `sh ~/.fleet/scripts/${'herdr-fleet'}.sh preflight` } as never)
    expect(denied(oldScript as never)).toMatch(/older, separate fleet/)

    await orchestrate($, 'stop')
    const after = (await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/src/main.rs` } as never))
    expect(denied(after as never)).toBeUndefined()
  })
  test('a session running the older herdr-fleet sees its workers in the tree, read-only', async ($, on) => {
    const w = world(on)
    const fleet = `${HOME}/.fleet/.herdr-fleet`
    const record = (id: string, pane: string, workspace = 'w9') =>
      JSON.stringify({ id, pane_id: pane, workspace_id: workspace, persona: `${HOME}/.fleet/agents/reviewer.md`, status: 'ready' })
    w.put(`${HOME}/.fleet/agents/reviewer.md`, '---\nname: reviewer\nmodel: claude-sonnet-5-5\n---\n', 1)
    w.put(`${fleet}/manifest.jsonl`, [record('v-plan', 'w9:p7'), record('elsewhere', 'w5:p1', 'w5'), record('j-plan', 'w9:p8')].join('\n'), 1)
    w.put(`${fleet}/workers/v-plan/brief.md`, '# Brief: review the plan\n\nmore', 10)
    w.put(`${fleet}/workers/j-plan/brief.md`, '# Brief: judge the findings', 10)
    w.put(`${fleet}/workers/j-plan/report.md`, 'verdict', 20)
    w.panes.set('w9:p7', 'working')

    await $.session.start(start)
    await w.clock.advance(3000)
    const tree = ((await $.command.run({ command: 'fleet', args: '', origin: { kind: 'user' }, presentation: {} } as never)) as { text: string }).text
    expect(tree).toMatch(/v-plan {2}sonnet-5-5 {2}working {2}review the plan/)
    expect(tree).toMatch(/j-plan {2}sonnet-5-5 {2}done {2}judge the findings/)
    expect(tree).not.toContain('elsewhere')

    // v-plan writes its report and goes idle: done
    w.put(`${fleet}/workers/v-plan/report.md`, 'findings', 30)
    w.panes.set('w9:p7', 'idle')
    await w.clock.advance(3000)
    const after = ((await $.command.run({ command: 'fleet', args: '', origin: { kind: 'user' }, presentation: {} } as never)) as { text: string }).text
    expect(after).toMatch(/v-plan {2}sonnet-5-5 {2}done/)
    expect(w.calls.some(c => c[0] === 'horch')).toBe(false)
  })
})
