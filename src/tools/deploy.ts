import { z } from 'zod'
import { flatten, request, unwrap } from '../forge/client.js'
import { tailLines } from '../forge/format.js'
import { resolveTarget } from '../forge/resolve.js'
import { Args, getContent, getOne, LIST_PARAMS, listOf, need, P, send, ToolSpec } from './define.js'

async function sitePath(a: Args): Promise<string> {
  const t = await resolveTarget(a, 'site')
  return `/servers/${t.serverId}/sites/${t.siteId}`
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function deploymentLog(base: string, id: string, lines: number): Promise<string> {
  const body = unwrap(await request('GET', `${base}/deployments/${id}/log`)) as { output?: string } | null
  return tailLines(body?.output ?? '', lines)
}

export const deploymentsTool: ToolSpec = {
  name: 'forge_deployments',
  summary: 'Deployments for a site: deploy, history, logs, deploy script, push-to-deploy, deploy hook, webhooks, deploy key.',
  params: {
    server: P.server,
    site: P.site,
    id: P.id,
    wait: z.boolean().optional().describe('deploy: wait (up to ~50s) and return the log tail'),
    lines: z.number().int().optional().describe('Log lines to return (default 60)'),
    enabled: z.boolean().optional().describe('push_to_deploy: on/off'),
    content: z.string().optional().describe('set_script: full deploy script'),
    url: z.string().optional().describe('add_webhook: URL'),
    data: P.data,
    ...LIST_PARAMS,
  },
  actions: {
    list: { level: 'readonly', doc: 'deployment history', run: async a => listOf(`${await sitePath(a)}/deployments`, a, 'deployments') },
    get: { level: 'readonly', doc: 'deployment `id`', run: async a => getOne(`${await sitePath(a)}/deployments/${need(a.id, 'id')}`, a) },
    log: { level: 'readonly', doc: 'log of deployment `id` (tail `lines`)', run: async a => deploymentLog(await sitePath(a), need(a.id, 'id'), (a.lines as number) ?? 60) },
    status: { level: 'readonly', doc: 'current deployment status', run: async a => getOne(`${await sitePath(a)}/deployments/status`, a) },
    script: { level: 'readonly', doc: 'deploy script', run: async a => (await getContent(`${await sitePath(a)}/deployments/script`)) || '(empty)' },
    hook: { level: 'readonly', doc: 'deploy trigger URL (contains a token)', run: async a => getOne(`${await sitePath(a)}/deployments/deploy-hook`, { ...a, full: true }) },
    webhooks: { level: 'readonly', doc: 'deployment webhooks', run: async a => listOf(`${await sitePath(a)}/webhooks`, a, 'webhooks') },
    deploy_key: { level: 'readonly', doc: 'site deploy key (public)', run: async a => getOne(`${await sitePath(a)}/deploy-key`, { ...a, full: true }) },
    server_history: {
      level: 'readonly',
      doc: 'recent deployments across all sites on `server`',
      run: async a => listOf(`/servers/${(await resolveTarget(a, 'server')).serverId}/deployments`, a, 'deployments'),
    },
    deploy: {
      level: 'write',
      doc: 'deploy now (wait=true to get the result)',
      run: async a => {
        const base = await sitePath(a)
        const body = await request<{ data?: unknown }>('POST', `${base}/deployments`)
        const dep = body?.data ? flatten(body.data) : null
        if (!a.wait || !dep) return dep ? `Deployment ${dep.id} started.` : 'Deployment started.'
        const deadline = Date.now() + 50_000
        let status = String(dep.status ?? '')
        while (Date.now() < deadline && !['finished', 'failed', 'cancelled', 'failed-build'].includes(status)) {
          await sleep(4000)
          status = String(flatten((await request<{ data: unknown }>('GET', `${base}/deployments/${dep.id}`)).data).status)
        }
        const log = await deploymentLog(base, dep.id, (a.lines as number) ?? 40).catch(() => '')
        return `Deployment ${dep.id}: ${status}\n${log}`
      },
    },
    reset_status: { level: 'write', doc: 'clear a stuck "deploying" state', run: async a => send('DELETE', `${await sitePath(a)}/deployments/status`, undefined, a, 'Deployment state reset.') },
    set_script: { level: 'write', doc: 'replace deploy script with `content`', run: async a => send('PUT', `${await sitePath(a)}/deployments/script`, { content: need(a.content as string, 'content') }, a, 'Deploy script updated.') },
    push_to_deploy: {
      level: 'write',
      doc: 'turn push-to-deploy on/off (`enabled`)',
      run: async a => {
        const on = need(a.enabled as boolean, 'enabled')
        return send(on ? 'POST' : 'DELETE', `${await sitePath(a)}/deployments/push-to-deploy`, on ? {} : undefined, a, `Push-to-deploy ${on ? 'enabled' : 'disabled'}.`)
      },
    },
    regenerate_hook: { level: 'write', doc: 'issue a new deploy trigger URL', run: async a => send('PUT', `${await sitePath(a)}/deployments/deploy-hook`, {}, { ...a, full: true }) },
    add_webhook: { level: 'write', doc: 'notify `url` after deployments', run: async a => send('POST', `${await sitePath(a)}/webhooks`, { url: need(a.url as string, 'url') }, a) },
    create_deploy_key: { level: 'write', doc: 'generate a site deploy key', run: async a => send('POST', `${await sitePath(a)}/deploy-key`, {}, { ...a, full: true }) },
  },
}
