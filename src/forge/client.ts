import fetch from 'node-fetch'

const API_ROOT = 'https://forge.laravel.com/api'

/** Account-level paths that are not served beneath /orgs/{slug}. */
const UNSCOPED = ['/user', '/me', '/orgs', '/providers']

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ForgeRecord {
  id: string
  /** JSON:API resource type (kept apart from any `type` attribute). */
  _type?: string
  [key: string]: unknown
}

export class ForgeError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

export interface ClientConfig {
  apiKey: string
  org: string
}

let config: ClientConfig | undefined

export function configureClient(c: ClientConfig): void {
  config = c
}

function cfg(): ClientConfig {
  if (!config) throw new Error('Forge client is not configured')
  return config
}

export function orgSlug(): string {
  return cfg().org
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  if (path.startsWith('http')) return path
  const scoped = !UNSCOPED.some(p => path === p || path.startsWith(`${p}/`))
  const url = new URL(
    `${API_ROOT}${scoped ? `/orgs/${cfg().org}` : ''}${path}`
  )
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/** Keep Forge's error message and any validation details, drop the rest. */
function errorMessage(status: number, body: unknown): string {
  if (typeof body === 'string') return `Forge API ${status}: ${body.slice(0, 300)}`
  const b = body as { message?: string; errors?: Record<string, string[]> } | null
  const details = b?.errors
    ? ' ' +
      Object.entries(b.errors)
        .map(([field, msgs]) => `${field}: ${msgs.join(' ')}`)
        .join('; ')
    : ''
  return `Forge API ${status}: ${b?.message ?? 'request failed'}${details}`
}

export async function request<T = unknown>(
  method: Method,
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers: {
      Authorization: `Bearer ${cfg().apiKey}`,
      Accept: 'application/vnd.api+json, application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'forge-mcp-server',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let body: unknown = text
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = JSON.parse(text)
    } catch {
      // keep raw text
    }
  }
  if (!res.ok) throw new ForgeError(errorMessage(res.status, body), res.status)
  return (text ? body : null) as T
}

interface JsonApiResource {
  id: string | number
  type?: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { id: string; type: string } | null }>
}

/** Flatten a JSON:API resource to { id, _type, ...attributes, <rel>_id }. */
export function flatten(resource: unknown): ForgeRecord {
  const r = resource as JsonApiResource
  const out: ForgeRecord = { id: String(r.id), _type: r.type }
  Object.assign(out, r.attributes ?? {})
  out.id = String(r.id)
  out._type = r.type
  for (const [name, rel] of Object.entries(r.relationships ?? {})) {
    if (rel?.data && !Array.isArray(rel.data)) out[`${name}_id`] = rel.data.id
  }
  return out
}

/** Normalize any Forge response body into records (lists) or one record. */
export function unwrap(body: unknown): ForgeRecord | ForgeRecord[] | unknown {
  const b = body as { data?: unknown } | null
  if (!b || typeof b !== 'object' || !('data' in b)) return body
  if (Array.isArray(b.data)) return b.data.map(flatten)
  if (b.data && typeof b.data === 'object' && 'id' in (b.data as object)) {
    return flatten(b.data)
  }
  return b.data
}

export interface Page {
  items: ForgeRecord[]
  nextCursor: string | null
}

export const MAX_PAGE_SIZE = 30

export async function getPage(
  path: string,
  opts: { limit?: number; cursor?: string; query?: Record<string, unknown> } = {}
): Promise<Page> {
  const body = await request<{ data?: unknown[]; meta?: { next_cursor?: string | null } }>(
    'GET',
    path,
    {
      query: {
        ...opts.query,
        'page[size]': Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE),
        'page[cursor]': opts.cursor,
      },
    }
  )
  const items = Array.isArray(body?.data) ? body.data.map(flatten) : []
  return { items, nextCursor: body?.meta?.next_cursor ?? null }
}

/**
 * Fetch a list honoring the caller's budget: one page by default, every page
 * when `all` is set, but never more than `max` items so a runaway list can't
 * flood the conversation.
 */
export async function getList(
  path: string,
  opts: {
    limit?: number
    cursor?: string
    all?: boolean
    max?: number
    query?: Record<string, unknown>
  } = {}
): Promise<{ items: ForgeRecord[]; nextCursor: string | null; capped: boolean }> {
  const limit = opts.limit ?? 25
  if (!opts.all) {
    const page = await getPage(path, { limit, cursor: opts.cursor, query: opts.query })
    return { items: page.items.slice(0, limit), nextCursor: page.nextCursor, capped: false }
  }
  const max = opts.max ?? 500
  const items: ForgeRecord[] = []
  let cursor = opts.cursor
  do {
    const page = await getPage(path, { cursor, query: opts.query })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor && items.length < max)
  return {
    items: items.slice(0, max),
    nextCursor: cursor ?? null,
    capped: items.length >= max && !!cursor,
  }
}
