import { z } from 'zod'
import { ForgeRecord } from '../forge/client.js'
import { commandOutput, describeResult, runCommand, shq, waitForCommand } from '../forge/commands.js'
import { issueToken, redeemToken } from '../forge/confirm.js'
import { clip, table } from '../forge/format.js'
import { allServers, allSites, resolveServer, resolveTarget } from '../forge/resolve.js'
import { Args, getOne, LIST_PARAMS, listOf, need, P, ToolSpec } from './define.js'

const waitParam = z.number().int().min(5).max(110).optional().describe('Seconds to wait before returning (default 50)')
const maxOutput = z.number().int().optional().describe('Max output chars (default 6000)')

async function siteTarget(a: Args) {
  const t = await resolveTarget(a, 'site')
  return { serverId: t.serverId, siteId: t.siteId as string, site: t.site as ForgeRecord }
}

export const commandsTool: ToolSpec = {
  name: 'forge_commands',
  summary: "Run shell commands in a site's directory via Forge (works on every server, no SSH key needed), and read command history.",
  params: {
    server: P.server,
    site: P.site,
    id: P.id,
    command: z.string().optional(),
    wait_seconds: waitParam,
    max_output: maxOutput,
    ...LIST_PARAMS,
  },
  actions: {
    run: {
      level: 'write',
      doc: 'run `command` and return its output',
      run: async a => {
        const t = await siteTarget(a)
        const r = await runCommand(t.serverId, t.siteId, need(a.command as string, 'command'), { waitMs: ((a.wait_seconds as number) ?? 50) * 1000 })
        return describeResult(r, a.max_output as number)
      },
    },
    list: { level: 'readonly', doc: 'recent commands on the site', run: async a => { const t = await siteTarget(a); return listOf(`/servers/${t.serverId}/sites/${t.siteId}/commands`, a, 'commands', { sort: '-created_at' }) } },
    get: {
      level: 'readonly',
      doc: 'status (and output once finished) of command `id`',
      run: async a => {
        const t = await siteTarget(a)
        const r = await waitForCommand(t.serverId, t.siteId, need(a.id, 'id'), 1000)
        return describeResult(r, a.max_output as number)
      },
    },
    output: { level: 'readonly', doc: 'raw output of command `id`', run: async a => { const t = await siteTarget(a); return clip(await commandOutput(t.serverId, t.siteId, need(a.id, 'id')), (a.max_output as number) ?? 6000) } },
    details: { level: 'readonly', doc: 'command record `id`', run: async a => { const t = await siteTarget(a); return getOne(`/servers/${t.serverId}/sites/${t.siteId}/commands/${need(a.id, 'id')}`, a) } },
  },
}

// ---- WP-CLI ------------------------------------------------------------------

const RISKY = [
  /^(plugin|theme)\s+(install|update|delete|uninstall|activate|deactivate|toggle)\b/,
  /^language\s+\w+\s+(install|update|uninstall)\b/,
  /^core\s+(update|update-db|download|install|multisite-convert)\b/,
  /^search-replace\b(?!.*--dry-run)/,
  /^db\s+(import|reset|clean|drop|query)\b/,
  /^(option|post|user|term|comment|menu|widget|site|post-meta|user-meta|term-meta)\s+(\w+\s+)?(update|delete|create|add|remove|set|generate|reset|patch)\b/,
  /^eval(-file)?\b/,
]

export function isRiskyWp(args: string): boolean {
  const a = args.trim().replace(/^wp\s+/, '')
  return RISKY.some(r => r.test(a))
}

export type BackupMode = 'auto' | 'always' | 'never'
const BACKUP_DAYS = 14

/** Build the shell command for a WP-CLI call, prefixed by a DB export when warranted. */
export function wpCommand(site: ForgeRecord, args: string, backup: BackupMode = 'auto'): { command: string; backedUp: boolean } {
  const dir = String(site.web_directory ?? '')
  if (!dir) throw new Error(`Site ${site.name} has no web directory in Forge.`)
  const cleaned = args.trim().replace(/^wp\s+/, '')
  const wp = `wp --path=${shq(dir)}`
  const main = `${wp} ${cleaned} --no-color`
  const doBackup = backup === 'always' || (backup === 'auto' && isRiskyWp(cleaned))
  if (!doBackup) return { command: main, backedUp: false }
  const name = String(site.name).replace(/[^A-Za-z0-9.-]/g, '_')
  const file = `$HOME/mcp-backups/${name}-$(date +%Y%m%d-%H%M%S).sql`
  const pre =
    `mkdir -p $HOME/mcp-backups && F=${file} && ${wp} db export "$F" --quiet && gzip -f "$F" && echo "[backup] $F.gz" && ` +
    `find $HOME/mcp-backups -name ${shq(`${name}-*.sql.gz`)} -mtime +${BACKUP_DAYS} -delete; `
  // The main command runs only if the export succeeded.
  return { command: `${pre.replace(/; $/, '')} && ${main}`, backedUp: true }
}

const backupParam = z
  .enum(['auto', 'always', 'never'])
  .optional()
  .describe(`DB export to ~/mcp-backups before running. auto (default) = only for changes (updates, installs, search-replace, db import, deletes); kept ${BACKUP_DAYS} days`)

export const wpTool: ToolSpec = {
  name: 'forge_wp',
  summary:
    'Run WP-CLI on any WordPress site by name, through Forge (no SSH key needed). e.g. args="plugin list --format=csv", "core version", "plugin update --all". Risky commands get an automatic DB backup first.',
  params: {
    site: P.site,
    server: P.server,
    args: z.string().describe('WP-CLI arguments without the leading "wp"'),
    backup: backupParam,
    wait_seconds: waitParam,
    max_output: maxOutput,
  },
  actions: {
    run: {
      level: 'write',
      doc: '',
      run: async a => {
        const t = await siteTarget(a)
        const { command } = wpCommand(t.site, need(a.args as string, 'args'), a.backup as BackupMode)
        const r = await runCommand(t.serverId, t.siteId, command, { waitMs: ((a.wait_seconds as number) ?? 50) * 1000 })
        return describeResult(r, a.max_output as number)
      },
    },
  },
}

// ---- Bulk ----------------------------------------------------------------------

interface BulkPlan {
  kind: 'wp' | 'shell'
  command: string
  backup: BackupMode
  sites: { siteId: string; serverId: string; site: ForgeRecord }[]
}

const plans = new Map<string, BulkPlan>()

async function selectSites(a: Args): Promise<BulkPlan['sites']> {
  let sites = await allSites()
  if (Array.isArray(a.sites) && a.sites.length) {
    const wanted = (a.sites as string[]).map(s => s.toLowerCase().replace(/^www\./, ''))
    sites = sites.filter(s => wanted.includes(String(s.name).toLowerCase()) || wanted.includes(s.id))
  }
  if (a.server) {
    const srv = await resolveServer(a.server)
    sites = sites.filter(s => s.server_id === srv.id)
  }
  if (a.app_type) sites = sites.filter(s => String(s.app_type).toLowerCase() === String(a.app_type).toLowerCase())
  if (a.filter) sites = sites.filter(s => String(s.name).toLowerCase().includes(String(a.filter).toLowerCase()))
  return sites.map(s => ({ siteId: s.id, serverId: String(s.server_id), site: s }))
}

async function execute(plan: BulkPlan, maxSeconds: number, showOutput: boolean): Promise<string> {
  const deadline = Date.now() + maxSeconds * 1000
  const queue = [...plan.sites]
  const rows: ForgeRecord[] = []
  const details: string[] = []
  const worker = async () => {
    while (queue.length && Date.now() < deadline - 5000) {
      const t = queue.shift()!
      const command = plan.kind === 'wp' ? wpCommand(t.site, plan.command, plan.backup).command : plan.command
      try {
        const r = await runCommand(t.serverId, t.siteId, command, { waitMs: Math.max(5000, deadline - Date.now()) })
        const lastLine = (r.finished ? (r.exitCode === 0 ? r.output : r.errorOutput || r.output) : `still ${r.status}, command ${r.id}`).trim().split('\n').pop() ?? ''
        rows.push({ id: t.siteId, site: t.site.name, status: r.finished ? r.status : 'running', exit: r.exitCode, last_line: lastLine })
        if (showOutput) details.push(`## ${t.site.name}\n${describeResult(r, 800)}`)
      } catch (e) {
        rows.push({ id: t.siteId, site: t.site.name, status: 'error', exit: null, last_line: (e as Error).message })
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  let out = table(rows, { fields: ['site', 'status', 'exit', 'last_line'] })
  if (details.length) out += `\n\n${details.join('\n\n')}`
  if (queue.length) {
    const token = issueToken(`bulk-continue`)
    plans.set(token, { ...plan, sites: queue })
    out += `\n\n[${queue.length} sites not started (time limit). Continue with action=run token=${token}]`
  }
  return out
}

export const bulkTool: ToolSpec = {
  name: 'forge_bulk',
  summary:
    'Run one WP-CLI or shell command across many sites. Always preview first: it lists the matched sites and returns a token; run executes with that token. Select with sites, server, app_type (e.g. WordPress), filter.',
  params: {
    kind: z.enum(['wp', 'shell']).optional().describe('Default wp'),
    command: z.string().optional().describe('WP-CLI args (kind=wp) or shell command'),
    sites: z.array(z.string()).optional().describe('Site domains or ids'),
    server: P.server,
    app_type: z.string().optional().describe('e.g. WordPress, Laravel'),
    filter: z.string().optional().describe('Site name contains'),
    backup: backupParam,
    token: z.string().optional().describe('From preview (or a continuation)'),
    max_seconds: z.number().int().min(20).max(110).optional().describe('Time budget for run (default 50); remaining sites get a continuation token'),
    show_output: z.boolean().optional().describe('Include each site output (clipped)'),
  },
  actions: {
    preview: {
      level: 'write',
      doc: 'list target sites and get a token (changes nothing)',
      run: async a => {
        const sites = await selectSites(a)
        if (!sites.length) return 'No sites matched.'
        const plan: BulkPlan = {
          kind: (a.kind as 'wp' | 'shell') ?? 'wp',
          command: need(a.command as string, 'command'),
          backup: (a.backup as BackupMode) ?? 'auto',
          sites,
        }
        const token = issueToken('bulk')
        plans.set(token, plan)
        const names = new Map((await allServers()).map(s => [s.id, s.name]))
        const willBackup = plan.kind === 'wp' && (plan.backup === 'always' || (plan.backup === 'auto' && isRiskyWp(plan.command)))
        return (
          `${sites.length} sites will run: ${plan.kind === 'wp' ? 'wp ' : ''}${plan.command}${willBackup ? '\n(each site gets a DB backup first)' : ''}\n` +
          table(sites.map(s => ({ id: s.siteId, site: s.site.name, server: names.get(s.serverId) ?? s.serverId })), { fields: ['site', 'server', 'id'] }) +
          `\n\nToken: ${token} (15 min). Confirm with the user, then action=run token=${token}.`
        )
      },
    },
    run: {
      level: 'write',
      doc: 'execute a previewed plan (`token`)',
      run: async a => {
        const token = need(a.token as string, 'token')
        const plan = plans.get(token)
        if (!plan || !(redeemToken(token, 'bulk') || redeemToken(token, 'bulk-continue'))) {
          return 'Unknown or expired token. Run action=preview again.'
        }
        plans.delete(token)
        return execute(plan, (a.max_seconds as number) ?? 50, !!a.show_output)
      },
    },
  },
}
