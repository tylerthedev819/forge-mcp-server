import { z } from 'zod'
import { request, unwrap } from '../forge/client.js'
import { issueToken, redeemToken } from '../forge/confirm.js'
import { record } from '../forge/format.js'
import { invalidateCache, resolveTarget } from '../forge/resolve.js'
import { Args, need, P, ToolSpec } from './define.js'
import { runBackup } from './data.js'

type Scope = 'server' | 'site'
interface TargetDef {
  scope: Scope
  path: (a: Args) => string
  label: string
}

const id = (a: Args) => need(a.id, 'id')

/** What can be removed, and where it lives (relative to the server or site). */
const TARGETS: Record<string, TargetDef> = {
  site: { scope: 'site', path: () => '', label: 'site (files, nginx config, and Forge record)' },
  server: { scope: 'server', path: () => '', label: 'server (destroys the VM at the provider)' },
  database: { scope: 'server', path: a => `/database/schemas/${id(a)}`, label: 'database' },
  database_user: { scope: 'server', path: a => `/database/users/${id(a)}`, label: 'database user' },
  domain: { scope: 'site', path: a => `/domains/${id(a)}`, label: 'domain' },
  certificate: { scope: 'site', path: a => `/domains/${id(a)}/certificates/${need(a.certificate_id as string, 'certificate_id')}`, label: 'certificate' },
  backup_config: { scope: 'server', path: a => `/database/backups/${need(a.config_id as string, 'config_id')}`, label: 'backup configuration' },
  backup: { scope: 'server', path: a => `/database/backups/${need(a.config_id as string, 'config_id')}/instances/${id(a)}`, label: 'backup' },
  scheduled_job: { scope: 'server', path: a => `/scheduled-jobs/${id(a)}`, label: 'server scheduled job' },
  site_scheduled_job: { scope: 'site', path: a => `/scheduled-jobs/${id(a)}`, label: 'site scheduled job' },
  background_process: { scope: 'server', path: a => `/background-processes/${id(a)}`, label: 'background process' },
  firewall_rule: { scope: 'server', path: a => `/firewall-rules/${id(a)}`, label: 'firewall rule' },
  security_rule: { scope: 'site', path: a => `/security-rules/${id(a)}`, label: 'security rule' },
  redirect_rule: { scope: 'site', path: a => `/redirect-rules/${id(a)}`, label: 'redirect rule' },
  ssh_key: { scope: 'server', path: a => `/ssh-keys/${id(a)}`, label: 'SSH key' },
  monitor: { scope: 'server', path: a => `/monitors/${id(a)}`, label: 'monitor' },
  heartbeat: { scope: 'site', path: a => `/heartbeats/${id(a)}`, label: 'heartbeat' },
  nginx_template: { scope: 'server', path: a => `/nginx/templates/${id(a)}`, label: 'nginx template' },
  php_version: { scope: 'server', path: a => `/php/versions/${id(a)}`, label: 'installed PHP version' },
  webhook: { scope: 'site', path: a => `/webhooks/${id(a)}`, label: 'deployment webhook' },
  deploy_key: { scope: 'site', path: () => '/deploy-key', label: 'site deploy key' },
  site_command: { scope: 'site', path: a => `/commands/${id(a)}`, label: 'command history entry' },
  composer_credentials: { scope: 'site', path: a => `/composer/credentials/${id(a)}`, label: 'composer credentials' },
  npm_credentials: { scope: 'site', path: a => `/npm/credentials/${id(a)}`, label: 'npm credentials' },
  integration: { scope: 'site', path: a => `/integrations/${id(a)}`, label: 'Laravel integration (id = horizon|octane|reverb|pulse|laravel-maintenance|laravel-scheduler)' },
  site_log: { scope: 'site', path: a => `/logs/${(a.log as string) ?? 'application'}`, label: 'site log contents' },
  server_log: { scope: 'server', path: a => `/logs/${need(a.key as string, 'key')}`, label: 'server log contents' },
}

const ORG_TARGETS: Record<string, (a: Args) => string> = {
  recipe: a => `/recipes/${id(a)}`,
  archived_server: a => `/servers/archives/${id(a)}`,
}

async function locate(a: Args): Promise<{ path: string; label: string }> {
  const target = need(a.target as string, 'target')
  if (target === 'api_path') {
    const p = need(a.path as string, 'path')
    if (!p.startsWith('/')) throw new Error('path must start with /')
    return { path: p, label: `DELETE ${p}` }
  }
  if (ORG_TARGETS[target]) return { path: ORG_TARGETS[target](a), label: target.replace('_', ' ') }
  const def = TARGETS[target]
  if (!def) throw new Error(`Unknown target ${target}`)
  const t = await resolveTarget(a, def.scope)
  const base = def.scope === 'site' ? `/servers/${t.serverId}/sites/${t.siteId}` : `/servers/${t.serverId}`
  return { path: `${base}${def.path(a)}`, label: def.label }
}

async function describeTarget(path: string): Promise<string> {
  try {
    const r = unwrap(await request('GET', path))
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const o = r as Record<string, unknown>
      const pickKeys = ['id', 'name', 'url', 'command', 'path', 'from', 'to', 'port', 'user', 'status', 'type']
      const brief = Object.fromEntries(pickKeys.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
      return record(brief)
    }
  } catch {
    // some targets have no GET; the path is description enough
  }
  return ''
}

export const destructiveTool: ToolSpec = {
  name: 'forge_destructive',
  summary:
    'Irreversible operations: delete any Forge resource, clear logs, restore a database backup. Call once to preview (returns a token), confirm with the user, then call again with confirm=<token>.',
  params: {
    target: z
      .enum(['restore_backup', 'api_path', ...Object.keys(TARGETS), ...Object.keys(ORG_TARGETS)] as [string, ...string[]])
      .describe('What to delete, or restore_backup'),
    server: P.server,
    site: P.site,
    id: P.id,
    config_id: z.string().optional().describe('Backup configuration id'),
    certificate_id: z.string().optional(),
    log: z.enum(['application', 'nginx-access', 'nginx-error']).optional(),
    key: z.string().optional().describe('Server log key'),
    path: z.string().optional().describe('api_path: Forge API path to DELETE'),
    database_id: z.string().optional().describe('restore_backup: database to restore into'),
    skip_pre_backup: z.boolean().optional().describe('restore_backup: skip the safety backup (not recommended)'),
    confirm: z.string().optional().describe('Token from the preview call'),
  },
  actions: {
    run: {
      level: 'destructive',
      doc: '',
      run: async (a: Args) => {
        if (a.target === 'restore_backup') return restore(a)
        const { path, label } = await locate(a)
        const key = `delete:${path}`
        if (!a.confirm) {
          const details = await describeTarget(path)
          const token = issueToken(key)
          return `About to delete ${label}:\n${details ? details + '\n' : ''}(DELETE ${path})\n\nThis cannot be undone. Confirm with the user, then call again with confirm=${token}.`
        }
        if (!redeemToken(String(a.confirm), key)) return 'Token does not match this operation or has expired. Preview again.'
        await request('DELETE', path)
        if (a.target === 'site' || a.target === 'server') invalidateCache()
        return `Deleted ${label}.`
      },
    },
  },
}

async function restore(a: Args): Promise<string> {
  const t = await resolveTarget(a, 'server')
  const base = `/servers/${t.serverId}`
  const configId = need(a.config_id as string, 'config_id')
  const backupId = need(a.id, 'id (backup to restore)')
  const databaseId = need(a.database_id as string, 'database_id')
  const key = `restore:${base}:${configId}:${backupId}:${databaseId}`
  if (!a.confirm) {
    const token = issueToken(key)
    return (
      `About to restore backup ${backupId} (configuration ${configId}) into database ${databaseId} on ${t.serverName ?? t.serverId}. ` +
      `Current data in that database will be replaced.${a.skip_pre_backup ? '' : ' A fresh backup is taken first; the restore is aborted if it does not finish.'}\n\n` +
      `Confirm with the user, then call again with confirm=${token}.`
    )
  }
  if (!redeemToken(String(a.confirm), key)) return 'Token does not match this operation or has expired. Preview again.'
  let pre = ''
  if (!a.skip_pre_backup) {
    const r = await runBackup(base, configId, 90_000)
    if (!['finished', 'success'].includes(r.status)) {
      return `Safety backup ${r.id} is "${r.status}" after 90s, so the restore was NOT started. Check it with forge_backups get, then preview the restore again.`
    }
    pre = `Safety backup ${r.id} completed. `
  }
  await request('POST', `${base}/database/backups/${configId}/instances/${backupId}/restores`, { body: { database_id: Number(databaseId) } })
  return `${pre}Restore of backup ${backupId} started.`
}
