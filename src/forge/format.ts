import { ForgeRecord } from './client.js'

/**
 * Default columns per resource type. Anything not listed falls back to every
 * scalar attribute. Callers can ask for other fields, or `full`.
 */
export const DEFAULT_FIELDS: Record<string, string[]> = {
  servers: ['id', 'name', 'ip_address', 'php_version', 'region', 'size', 'connection_status'],
  sites: ['id', 'name', 'server_id', 'app_type', 'status', 'https', 'php_version', 'deployment_status'],
  domainRecords: ['id', 'name', 'type', 'status', 'www_redirect_type'],
  certificates: ['id', 'type', 'status', 'active', 'request_status', 'created_at'],
  deployments: ['id', 'status', 'type', 'commit', 'started_at', 'ended_at'],
  commands: ['id', 'command', 'status', 'exit_code', 'duration', 'created_at'],
  databases: ['id', 'name', 'status', 'created_at'],
  databaseUsers: ['id', 'name', 'status', 'created_at'],
  backupConfigurations: ['id', 'name', 'provider', 'displayable_schedule', 'next_run_time', 'status', 'retention', 'database_ids'],
  backups: ['id', 'status', 'size', 'is_partial', 'finished_at'],
  scheduledJobs: ['id', 'name', 'command', 'user', 'frequency', 'cron', 'status', 'next_run_time'],
  backgroundProcesses: ['id', 'command', 'user', 'directory', 'processes', 'status'],
  keys: ['id', 'name', 'user', 'status', 'created_at'],
  rules: ['id', 'name', 'port', 'ip_address', 'type', 'status'],
  securityRules: ['id', 'name', 'path', 'status'],
  'redirect-rules': ['id', 'from', 'to', 'type', 'status'],
  events: ['id', 'description', 'ran_as', 'created_at'],
  phpVersions: ['id', 'version', 'binary_name', 'status'],
  monitors: ['id', 'type', 'operator', 'threshold', 'minutes', 'status', 'state'],
  heartbeats: ['id', 'name', 'status', 'frequency', 'grace_period'],
  recipes: ['id', 'name', 'user', 'created_at'],
  providerSizes: ['code', 'name', 'cpus', 'ram', 'disk', 'category'],
  providerRegions: ['code', 'name'],
}

/** Attribute names that carry credentials or bulk; hidden unless asked for. */
const HIDDEN = /token|secret|password|private_key|local_public_key|deployment_url|^key$|webhook_url/i

const MAX_CELL = 80

function cell(v: unknown, limit: number): string {
  if (v === null || v === undefined || v === '') return '-'
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  s = s.replace(/[\t\r\n]+/g, ' ')
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

export interface ViewOptions {
  fields?: string[]
  full?: boolean
  format?: 'table' | 'json'
}

function columnsFor(items: ForgeRecord[], opts: ViewOptions): string[] {
  if (opts.fields?.length) return opts.fields
  const type = items[0]?._type ?? ''
  if (!opts.full && DEFAULT_FIELDS[type]) return DEFAULT_FIELDS[type]
  const cols = new Set<string>()
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      if (k === '_type') continue
      if (!opts.full && (HIDDEN.test(k) || !isScalar(v))) continue
      cols.add(k)
    }
  }
  return [...cols]
}

/** Project a record to the requested fields (or safe defaults). */
export function project(item: ForgeRecord, opts: ViewOptions): Record<string, unknown> {
  if (opts.full) {
    const { _type, ...rest } = item
    return rest
  }
  const out: Record<string, unknown> = {}
  if (opts.fields?.length) {
    for (const f of opts.fields) out[f] = item[f]
    return out
  }
  for (const [k, v] of Object.entries(item)) {
    if (k === '_type' || HIDDEN.test(k)) continue
    out[k] = v
  }
  return out
}

/** Render a list as a tab-separated table: one header line, one row per item. */
export function table(items: ForgeRecord[], opts: ViewOptions = {}): string {
  if (!items.length) return '(none)'
  if (opts.format === 'json') {
    return JSON.stringify(items.map(i => (opts.fields || opts.full ? project(i, opts) : pick(i, columnsFor(items, opts)))))
  }
  const cols = columnsFor(items, opts)
  const limit = opts.fields?.length || opts.full ? 4000 : MAX_CELL
  const lines = [cols.join('\t')]
  for (const item of items) lines.push(cols.map(c => cell(item[c], limit)).join('\t'))
  return lines.join('\n')
}

function pick(item: ForgeRecord, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of cols) out[c] = item[c]
  return out
}

/** Render one record as `key: value` lines. */
export function record(item: unknown, opts: ViewOptions = {}): string {
  if (item === null || item === undefined) return '(empty)'
  if (typeof item !== 'object') return String(item)
  const view = 'id' in (item as object) ? project(item as ForgeRecord, opts) : (item as Record<string, unknown>)
  if (opts.format === 'json') return JSON.stringify(view)
  return Object.entries(view)
    .map(([k, v]) => `${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? '-'}`)
    .join('\n')
}

export function listFooter(
  shown: number,
  nextCursor: string | null,
  capped = false,
  label = 'items'
): string {
  if (capped) return `\n[${shown} ${label} shown; stopped at the safety cap. Narrow with a filter, or pass cursor=${nextCursor} to continue.]`
  if (nextCursor) return `\n[${shown} ${label} shown; more exist. Pass cursor=${nextCursor}, or all=true to fetch everything.]`
  return `\n[${shown} ${label}]`
}

/** Keep long text readable and bounded: head + tail with a marker between. */
export function clip(text: string, max = 6000): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  const tail = max - head
  const skipped = text.length - max
  return `${text.slice(0, head)}\n…[${skipped} chars omitted]…\n${text.slice(-tail)}`
}

/** Last N lines, optionally filtered to lines containing `grep` (case-insensitive). */
export function tailLines(text: string, lines = 100, grep?: string): string {
  let all = text.split('\n')
  if (grep) {
    const needle = grep.toLowerCase()
    all = all.filter(l => l.toLowerCase().includes(needle))
  }
  const out = all.slice(-lines)
  const dropped = all.length - out.length
  return (dropped > 0 ? `[${dropped} earlier lines omitted]\n` : '') + out.join('\n')
}
