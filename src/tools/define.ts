import { z, ZodRawShape } from 'zod'
import { ForgeRecord, getList, request, unwrap } from '../forge/client.js'
import { listFooter, record, table, ViewOptions } from '../forge/format.js'

export type Level = 'readonly' | 'write' | 'destructive'

export type Args = Record<string, unknown> & {
  action?: string
  server?: string
  site?: string
  id?: string
  data?: Record<string, unknown>
  fields?: string[]
  full?: boolean
  format?: 'table' | 'json'
  limit?: number
  cursor?: string
  all?: boolean
}

export interface Action {
  level: Level
  /** One short line; shown in the tool description only when the action is enabled. */
  doc: string
  run: (args: Args) => Promise<string>
}

export interface ToolSpec {
  name: string
  summary: string
  params: ZodRawShape
  actions: Record<string, Action>
}

/** Shared parameters. Descriptions stay terse: they repeat in every tool definition. */
export const P = {
  server: z.string().optional().describe('Server name, IP, or id'),
  site: z.string().optional().describe('Site domain or id (implies its server)'),
  id: z.string().optional().describe('Record id'),
  data: z.record(z.unknown()).optional().describe('Request body for create/update (Forge API fields)'),
  fields: z.array(z.string()).optional().describe('Columns to return'),
  full: z.boolean().optional().describe('Return every field'),
  format: z.enum(['table', 'json']).optional(),
  limit: z.number().int().min(1).max(30).optional().describe('Page size (default 25)'),
  cursor: z.string().optional(),
  all: z.boolean().optional().describe('Fetch all pages (capped); use only when needed'),
}

export const LIST_PARAMS = { fields: P.fields, full: P.full, format: P.format, limit: P.limit, cursor: P.cursor, all: P.all }

export function view(args: Args): ViewOptions {
  return { fields: args.fields, full: args.full, format: args.format }
}

export function need<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`Missing required parameter: ${name}`)
  return value
}

// ---- Standard handlers ---------------------------------------------------

export async function listOf(path: string, args: Args, label = 'items', query?: Record<string, unknown>): Promise<string> {
  const { items, nextCursor, capped } = await getList(path, {
    limit: args.limit,
    cursor: args.cursor,
    all: args.all,
    query,
  })
  return table(items, view(args)) + listFooter(items.length, nextCursor, capped, label)
}

export async function getOne(path: string, args: Args, query?: Record<string, unknown>): Promise<string> {
  return record(unwrap(await request('GET', path, { query })), view(args))
}

export async function send(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  args: Args,
  done = 'Done.'
): Promise<string> {
  const res = unwrap(await request(method, path, { body }))
  if (res === null || res === undefined || res === '') return done
  if (Array.isArray(res)) return table(res as ForgeRecord[], view(args))
  return record(res, view(args))
}

/** Read the `content` attribute that Forge wraps text payloads in. */
export async function getContent(path: string): Promise<string> {
  const body = unwrap(await request('GET', path)) as { content?: string } | string | null
  if (typeof body === 'string') return body
  return body?.content ?? ''
}

// ---- Registration ----------------------------------------------------------

export function enabledActions(spec: ToolSpec, levels: Level[]): string[] {
  return Object.entries(spec.actions)
    .filter(([, a]) => levels.includes(a.level))
    .map(([name]) => name)
}

/** Tools with a single action take no `action` parameter. */
function isSingle(spec: ToolSpec): boolean {
  return Object.keys(spec.actions).length === 1
}

export function describe(spec: ToolSpec, actions: string[]): string {
  if (isSingle(spec)) return spec.summary
  const lines = actions.map(a => `${a}: ${spec.actions[a].doc}`)
  return `${spec.summary}\n${lines.join('\n')}`
}

export function schemaFor(spec: ToolSpec, actions: string[]): ZodRawShape {
  if (isSingle(spec)) return spec.params
  return {
    action: z.enum(actions as [string, ...string[]]),
    ...spec.params,
  }
}

export async function runAction(spec: ToolSpec, actions: string[], args: Args): Promise<string> {
  const action = isSingle(spec) ? actions[0] : String(args.action ?? '')
  if (!actions.includes(action)) {
    throw new Error(`Action "${action}" is not available. Enabled: ${actions.join(', ')}`)
  }
  return spec.actions[action].run(args)
}
