import { z } from 'zod'
import { flatten, request } from '../forge/client.js'
import { tailLines } from '../forge/format.js'
import { resolveTarget } from '../forge/resolve.js'
import { Args, getContent, getOne, LIST_PARAMS, listOf, need, P, send, ToolSpec } from './define.js'

const srv = async (a: Args) => `/servers/${(await resolveTarget(a, 'server')).serverId}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const logsTool: ToolSpec = {
  name: 'forge_logs',
  summary: 'Read logs (tail + optional grep, so only the relevant lines come back). Site logs: application | nginx-access | nginx-error. Server logs: pass `key` without site.',
  params: {
    server: P.server,
    site: P.site,
    log: z.enum(['application', 'nginx-access', 'nginx-error']).optional().describe('Site log (default application)'),
    key: z.string().optional().describe('Server log key, e.g. nginx-error, php8.4-fpm, mysql, auth'),
    lines: z.number().int().min(1).max(2000).optional().describe('Default 100'),
    grep: z.string().optional().describe('Only lines containing this text'),
  },
  actions: {
    run: {
      level: 'readonly',
      doc: '',
      run: async a => {
        const lines = (a.lines as number) ?? 100
        if (a.site) {
          const t = await resolveTarget(a, 'site')
          const content = await getContent(`/servers/${t.serverId}/sites/${t.siteId}/logs/${(a.log as string) ?? 'application'}`)
          return tailLines(content, lines, a.grep as string) || '(empty log)'
        }
        const content = await getContent(`${await srv(a)}/logs/${need(a.key as string, 'key (or pass site)')}`)
        return tailLines(content, lines, a.grep as string) || '(empty log)'
      },
    },
  },
}

export const databasesTool: ToolSpec = {
  name: 'forge_databases',
  summary: 'MySQL/Postgres databases and database users on a server. Deletes: forge_destructive.',
  params: { server: P.server, site: P.site, id: P.id, data: P.data, ...LIST_PARAMS },
  actions: {
    list: { level: 'readonly', doc: 'databases', run: async a => listOf(`${await srv(a)}/database/schemas`, a, 'databases') },
    get: { level: 'readonly', doc: 'database `id`', run: async a => getOne(`${await srv(a)}/database/schemas/${need(a.id, 'id')}`, a) },
    users: { level: 'readonly', doc: 'database users', run: async a => listOf(`${await srv(a)}/database/users`, a, 'users') },
    user: { level: 'readonly', doc: 'database user `id`', run: async a => getOne(`${await srv(a)}/database/users/${need(a.id, 'id')}`, a) },
    create: { level: 'write', doc: 'create database (data: {name, user?, password?})', run: async a => send('POST', `${await srv(a)}/database/schemas`, need(a.data, 'data'), a) },
    create_user: { level: 'write', doc: 'create user (data: {name, password, database_ids?, read_only?})', run: async a => send('POST', `${await srv(a)}/database/users`, need(a.data, 'data'), a) },
    update_user: { level: 'write', doc: 'update user `id` (data: {database_ids, …})', run: async a => send('PUT', `${await srv(a)}/database/users/${need(a.id, 'id')}`, need(a.data, 'data'), a) },
    sync: { level: 'write', doc: 'sync Forge with databases that exist on the server', run: async a => send('POST', `${await srv(a)}/database/schemas/synchronizations`, {}, a, 'Sync started.') },
    root_password: { level: 'write', doc: 'change the database root password (data: {password})', run: async a => send('PUT', `${await srv(a)}/database/password`, need(a.data, 'data'), a, 'Password updated.') },
  },
}

/** Start a backup on a configuration and optionally wait for it to finish. */
export async function runBackup(base: string, configId: string, waitMs: number): Promise<{ id: string; status: string }> {
  const body = await request<{ data?: unknown }>('POST', `${base}/database/backups/${configId}/instances`)
  let b = body?.data ? flatten(body.data) : null
  if (!b) return { id: '?', status: 'started' }
  const deadline = Date.now() + waitMs
  while (waitMs > 0 && Date.now() < deadline && !['finished', 'success', 'failed'].includes(String(b.status))) {
    await sleep(4000)
    b = flatten((await request<{ data: unknown }>('GET', `${base}/database/backups/${configId}/instances/${b.id}`)).data)
  }
  return { id: b.id, status: String(b.status) }
}

export const backupsTool: ToolSpec = {
  name: 'forge_backups',
  summary: 'Database backups: backup configurations (schedules), backups, run a backup now. Restore: forge_destructive (takes a fresh backup first).',
  params: {
    server: P.server,
    site: P.site,
    config_id: z.string().optional().describe('Backup configuration id'),
    id: P.id,
    wait: z.boolean().optional().describe('run: wait up to ~60s for completion'),
    data: P.data,
    ...LIST_PARAMS,
  },
  actions: {
    configs: { level: 'readonly', doc: 'backup configurations', run: async a => listOf(`${await srv(a)}/database/backups`, a, 'configurations') },
    config: { level: 'readonly', doc: 'configuration `config_id`', run: async a => getOne(`${await srv(a)}/database/backups/${need(a.config_id as string, 'config_id')}`, a) },
    list: { level: 'readonly', doc: 'backups of `config_id`', run: async a => listOf(`${await srv(a)}/database/backups/${need(a.config_id as string, 'config_id')}/instances`, a, 'backups') },
    get: { level: 'readonly', doc: 'backup `id` of `config_id`', run: async a => getOne(`${await srv(a)}/database/backups/${need(a.config_id as string, 'config_id')}/instances/${need(a.id, 'id')}`, a) },
    create_config: {
      level: 'write',
      doc: 'new schedule (data: {storage_provider_id, frequency, database_ids, retention, time?, …})',
      run: async a => send('POST', `${await srv(a)}/database/backups`, need(a.data, 'data'), a),
    },
    update_config: { level: 'write', doc: 'update `config_id` (data)', run: async a => send('PUT', `${await srv(a)}/database/backups/${need(a.config_id as string, 'config_id')}`, need(a.data, 'data'), a) },
    run: {
      level: 'write',
      doc: 'back up now using `config_id`',
      run: async a => {
        const r = await runBackup(await srv(a), need(a.config_id as string, 'config_id'), a.wait ? 60_000 : 0)
        return `Backup ${r.id}: ${r.status}`
      },
    },
  },
}
