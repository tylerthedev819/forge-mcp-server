import { z } from 'zod'
import { ForgeRecord } from '../forge/client.js'
import { table } from '../forge/format.js'
import { allServers, allSites } from '../forge/resolve.js'
import { Args, P, ToolSpec } from './define.js'

function matches(filter: string | undefined, ...values: unknown[]): boolean {
  if (!filter) return true
  const f = filter.toLowerCase()
  return values.some(v => String(v ?? '').toLowerCase().includes(f))
}

export const overviewTool: ToolSpec = {
  name: 'forge_overview',
  summary:
    'Fleet overview: every site (or server) in one compact table with its server, app type, PHP, HTTPS and status. Cached 10 min; start here instead of listing servers one by one.',
  params: {
    view: z.enum(['sites', 'servers']).optional().describe('Default sites'),
    filter: z.string().optional().describe('Match server/site name, app type, IP, or PHP version'),
    refresh: z.boolean().optional().describe('Bypass the cache'),
    format: P.format,
  },
  actions: {
    run: {
      level: 'readonly',
      doc: '',
      run: async (args: Args) => {
        const [servers, sites] = await Promise.all([allServers(!!args.refresh), allSites(!!args.refresh)])
        const byId = new Map(servers.map(s => [s.id, s]))
        const filter = args.filter as string | undefined
        if (args.view === 'servers') {
          const counts = new Map<string, number>()
          for (const s of sites) counts.set(String(s.server_id), (counts.get(String(s.server_id)) ?? 0) + 1)
          const rows = servers
            .filter(s => matches(filter, s.name, s.ip_address, s.php_version, s.region))
            .map(s => ({ ...s, sites: counts.get(s.id) ?? 0 }) as ForgeRecord)
          return `${rows.length} servers\n` + table(rows, { fields: ['id', 'name', 'ip_address', 'php_version', 'size', 'sites', 'connection_status'], format: args.format })
        }
        const rows = sites
          .map(s => {
            const srv = byId.get(String(s.server_id))
            return { ...s, server: srv?.name ?? s.server_id, server_ip: srv?.ip_address } as ForgeRecord
          })
          .filter(s => matches(filter, s.name, s.server, s.server_ip, s.app_type, s.php_version))
        const empty = servers.filter(s => !sites.some(x => x.server_id === s.id)).map(s => s.name)
        return (
          `${rows.length} sites on ${servers.length} servers${filter ? ` (filter "${filter}")` : ''}\n` +
          table(rows, { fields: ['name', 'server', 'app_type', 'php_version', 'https', 'status', 'id'], format: args.format }) +
          (empty.length && !filter ? `\nServers with no sites: ${empty.join(', ')}` : '')
        )
      },
    },
  },
}

export const findTool: ToolSpec = {
  name: 'forge_find',
  summary: 'Find servers and sites by partial name, domain, or IP. Returns ids to use with other tools (most tools also accept names directly).',
  params: { query: z.string().describe('Name, domain, or IP fragment') },
  actions: {
    run: {
      level: 'readonly',
      doc: '',
      run: async (args: Args) => {
        const q = String(args.query ?? '').toLowerCase()
        const [servers, sites] = await Promise.all([allServers(), allSites()])
        const srv = servers.filter(s => matches(q, s.name, s.slug, s.ip_address)).slice(0, 15)
        const names = new Map(servers.map(s => [s.id, s.name]))
        const st = sites
          .filter(s => matches(q, s.name, s.url, ...(Array.isArray(s.aliases) ? s.aliases : [])))
          .slice(0, 15)
          .map(s => ({ ...s, server: names.get(String(s.server_id)) }) as ForgeRecord)
        return [
          srv.length ? 'Servers\n' + table(srv, { fields: ['id', 'name', 'ip_address', 'php_version'] }) : 'Servers: none',
          st.length ? 'Sites\n' + table(st, { fields: ['id', 'name', 'server', 'server_id', 'app_type'] }) : 'Sites: none',
        ].join('\n\n')
      },
    },
  },
}
