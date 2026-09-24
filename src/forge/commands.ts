import { flatten, request } from './client.js'
import { clip } from './format.js'

export interface CommandResult {
  id: string
  status: string
  exitCode: number | null
  output: string
  errorOutput: string
  finished: boolean
}

const sitePath = (serverId: string, siteId: string) => `/servers/${serverId}/sites/${siteId}/commands`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const DONE = ['finished', 'failed', 'timeout']

/**
 * Queue a command and return its id. Forge answers the POST with an empty body,
 * so the id is found by matching the command text among the site's newest commands.
 */
export async function startCommand(serverId: string, siteId: string, command: string): Promise<string> {
  const body = await request<{ data?: unknown } | null>('POST', sitePath(serverId, siteId), { body: { command } })
  if (body?.data) return flatten(body.data).id
  for (let attempt = 0; attempt < 4; attempt++) {
    const recent = await request<{ data?: unknown[] }>('GET', sitePath(serverId, siteId), {
      query: { sort: '-created_at', 'page[size]': 10 },
    })
    const match = (recent?.data ?? []).map(flatten).find(c => c.command === command)
    if (match) return match.id
    await sleep(1000)
  }
  throw new Error('Command was submitted but its id could not be found; check forge_commands action=list.')
}

/** Forge briefly serves this placeholder before a finished command's output is written. */
const OUTPUT_NOT_READY = /cat: .*\.forge\/provision-\d+\.output: No such file or directory/

export async function commandOutput(serverId: string, siteId: string, id: string): Promise<string> {
  const body = await request<{ data?: { attributes?: { output?: string } } }>(
    'GET',
    `${sitePath(serverId, siteId)}/${id}/output`
  )
  return body?.data?.attributes?.output ?? ''
}

/** Read output once it has settled (not the placeholder; an empty result confirmed twice). */
async function settledOutput(serverId: string, siteId: string, id: string): Promise<string> {
  let previous: string | undefined
  for (let i = 0; i < 12; i++) {
    const out = await commandOutput(serverId, siteId, id).catch(() => undefined)
    if (out !== undefined && !OUTPUT_NOT_READY.test(out)) {
      if (out !== '' || previous === '') return out
      previous = out
    }
    await sleep(1500)
  }
  return ''
}

/**
 * Run a site command through Forge and wait for it, returning only what the
 * caller needs (status, exit code, output). If it outlives `waitMs`, return the
 * command id so the caller can check back instead of blocking the tool call.
 */
export async function runCommand(
  serverId: string,
  siteId: string,
  command: string,
  opts: { waitMs?: number } = {}
): Promise<CommandResult> {
  const id = await startCommand(serverId, siteId, command)
  return waitForCommand(serverId, siteId, id, opts.waitMs)
}

export async function waitForCommand(
  serverId: string,
  siteId: string,
  id: string,
  waitMs = 50_000
): Promise<CommandResult> {
  const deadline = Date.now() + waitMs
  let delay = 1000
  let attrs: Record<string, unknown> = {}
  for (;;) {
    const body = await request<{ data: unknown }>('GET', `${sitePath(serverId, siteId)}/${id}`)
    attrs = flatten(body.data)
    if (DONE.includes(String(attrs.status))) break
    if (Date.now() + delay > deadline) {
      return { id, status: String(attrs.status), exitCode: null, output: '', errorOutput: '', finished: false }
    }
    await sleep(delay)
    delay = Math.min(delay + 1000, 4000)
  }
  const output = await settledOutput(serverId, siteId, id)
  return {
    id,
    status: String(attrs.status),
    exitCode: (attrs.exit_code as number | null) ?? null,
    output,
    errorOutput: String(attrs.error_output ?? ''),
    finished: true,
  }
}

export function describeResult(r: CommandResult, maxOutput = 6000): string {
  if (!r.finished) {
    return `Command ${r.id} is still ${r.status}. Check later with forge_commands action=get id=${r.id}.`
  }
  const head = r.status === 'finished' && (r.exitCode ?? 0) === 0 ? '' : `[${r.status}, exit ${r.exitCode ?? '?'}]\n`
  const err = r.errorOutput.trim() ? `\n[stderr]\n${clip(r.errorOutput.trim(), 2000)}` : ''
  return `${head}${clip(r.output.trimEnd(), maxOutput) || '(no output)'}${err}`
}

/** Single-quote a value for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
