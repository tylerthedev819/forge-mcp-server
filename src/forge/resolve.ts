import { ForgeRecord, getList } from './client.js'

/**
 * Name resolution: callers say "seniorsplus" or "pine-grove" and we find the
 * server/site IDs. Server and site lists are cached briefly so repeated lookups
 * in one conversation cost no extra API calls.
 */
const TTL_MS = 10 * 60 * 1000

interface Cache {
  at: number
  items: ForgeRecord[]
}

let servers: Cache | undefined
let sites: Cache | undefined

export function invalidateCache(): void {
  servers = undefined
  sites = undefined
}

export async function allServers(refresh = false): Promise<ForgeRecord[]> {
  if (!refresh && servers && Date.now() - servers.at < TTL_MS) return servers.items
  const { items } = await getList('/servers', { all: true, max: 2000 })
  servers = { at: Date.now(), items }
  return items
}

/** Every site in the org, each carrying `server_id` (via include=server). */
export async function allSites(refresh = false): Promise<ForgeRecord[]> {
  if (!refresh && sites && Date.now() - sites.at < TTL_MS) return sites.items
  const { items } = await getList('/sites', {
    all: true,
    max: 5000,
    query: { include: 'server' },
  })
  sites = { at: Date.now(), items }
  return items
}

function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
}

function pickOne(
  kind: string,
  query: string,
  items: ForgeRecord[],
  keys: string[]
): ForgeRecord {
  const q = norm(query)
  const byId = items.find(i => i.id === query.trim())
  if (byId) return byId
  const exact = items.filter(i => keys.some(k => norm(i[k]) === q))
  if (exact.length === 1) return exact[0]
  const partial = exact.length
    ? exact
    : items.filter(i => keys.some(k => norm(i[k]).includes(q)))
  if (partial.length === 1) return partial[0]
  if (!partial.length) throw new Error(`No ${kind} matches "${query}".`)
  const names = partial
    .slice(0, 10)
    .map(i => `${i.name} (id ${i.id})`)
    .join(', ')
  throw new Error(
    `"${query}" matches ${partial.length} ${kind}s: ${names}${partial.length > 10 ? ', …' : ''}. Be more specific or use the id.`
  )
}

export async function resolveServer(query: string): Promise<ForgeRecord> {
  if (/^\d+$/.test(query.trim())) {
    const cached = servers?.items.find(s => s.id === query.trim())
    if (cached) return cached
    return { id: query.trim(), name: query.trim() }
  }
  return pickOne('server', query, await allServers(), ['name', 'slug', 'ip_address'])
}

/** Resolve a site by id or domain (optionally within one server). */
export async function resolveSite(
  query: string,
  serverQuery?: string
): Promise<{ site: ForgeRecord; serverId: string }> {
  let candidates = await allSites()
  if (serverQuery) {
    const server = await resolveServer(serverQuery)
    candidates = candidates.filter(s => s.server_id === server.id)
  }
  const site = pickOne('site', query, candidates, ['name', 'url'])
  const serverId = String(site.server_id ?? '')
  if (!serverId) throw new Error(`Could not determine the server for site ${site.name}.`)
  return { site, serverId }
}

export interface Target {
  serverId: string
  serverName?: string
  siteId?: string
  site?: ForgeRecord
}

/** Resolve the {server?, site?} pair most tools accept. */
export async function resolveTarget(args: {
  server?: string
  site?: string
}, need: 'server' | 'site'): Promise<Target> {
  if (args.site) {
    const { site, serverId } = await resolveSite(args.site, args.server)
    return { serverId, siteId: site.id, site }
  }
  if (need === 'site') throw new Error('This action needs `site` (domain or id).')
  if (!args.server) throw new Error('This action needs `server` (name, IP, or id) or `site`.')
  const server = await resolveServer(args.server)
  return { serverId: server.id, serverName: String(server.name ?? '') }
}
