import { randomBytes } from 'crypto'
import { z } from 'zod'
import { flatten, getList, request } from '../forge/client.js'
import { describeResult, runCommand, shq } from '../forge/commands.js'
import { invalidateCache, resolveServer } from '../forge/resolve.js'
import { Args, need, P, ToolSpec } from './define.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const password = () => randomBytes(18).toString('base64url')

export const installWordPressTool: ToolSpec = {
  name: 'forge_install_wordpress',
  summary:
    'Create a new WordPress site on a server: database + user, Forge WordPress site, wait for install, optionally finish setup (title/admin) via WP-CLI. Never deletes or overwrites an existing site.',
  params: {
    server: P.server,
    domain: z.string().describe('Site domain, e.g. example.com'),
    php_version: z.string().optional().describe('e.g. php84 (default: server default)'),
    database: z.string().optional().describe('New database name (default derived from domain)'),
    isolated_user: z.string().optional().describe('Run the site as its own Linux user'),
    www_redirect_type: z.enum(['from-www', 'to-www', 'none']).optional(),
    title: z.string().optional().describe('Site title (with admin_* runs wp core install)'),
    admin_user: z.string().optional(),
    admin_email: z.string().optional(),
    admin_password: z.string().optional().describe('Generated if omitted'),
  },
  actions: {
    run: {
      level: 'write',
      doc: '',
      run: async (a: Args) => {
        const server = await resolveServer(need(a.server, 'server'))
        const base = `/servers/${server.id}`
        const domain = need(a.domain as string, 'domain').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        const report: string[] = []

        const existing = await getList(`${base}/sites`, { all: true, max: 500 })
        if (existing.items.some(s => String(s.name).toLowerCase() === domain)) {
          return `A site named ${domain} already exists on ${server.name}. Nothing changed.`
        }

        // 1. Database and user
        const dbName = (a.database as string) ?? domain.replace(/[^a-z0-9]+/g, '_').slice(0, 60)
        const dbUser = dbName.slice(0, 32)
        const dbPass = password()
        const dbBody = await request<{ data: unknown }>('POST', `${base}/database/schemas`, {
          body: { name: dbName, user: dbUser, password: dbPass },
        })
        const db = flatten(dbBody.data)
        report.push(`Database ${dbName} (id ${db.id}), user ${dbUser}, password ${dbPass}`)

        let userId: string | undefined
        for (let i = 0; i < 10 && !userId; i++) {
          const users = await getList(`${base}/database/users`, { all: true, max: 500 })
          userId = users.items.find(u => u.name === dbUser)?.id
          if (!userId) await sleep(3000)
        }

        // 2. Site
        const siteBody: Record<string, unknown> = {
          type: 'wordpress',
          name: domain,
          database_id: Number(db.id),
          www_redirect_type: a.www_redirect_type ?? 'from-www',
        }
        if (userId) siteBody.database_user_id = Number(userId)
        if (a.php_version) siteBody.php_version = a.php_version
        if (a.isolated_user) Object.assign(siteBody, { is_isolated: true, isolated_user: a.isolated_user })
        let site
        try {
          site = flatten((await request<{ data: unknown }>('POST', `${base}/sites`, { body: siteBody })).data)
        } catch (e) {
          return `${report.join('\n')}\nSite creation failed: ${(e as Error).message}\n(The database above was created; remove it with forge_destructive if you won't retry.)`
        }
        invalidateCache()
        report.push(`Site ${domain} (id ${site.id}) created, status ${site.status}`)

        // 3. Wait for Forge to finish installing
        const deadline = Date.now() + 75_000
        while (Date.now() < deadline && !['installed', 'failed'].includes(String(site.status))) {
          await sleep(5000)
          site = flatten((await request<{ data: unknown }>('GET', `${base}/sites/${site.id}`)).data)
        }
        report.push(`Status: ${site.status}`)
        if (site.status !== 'installed') {
          report.push('Still installing; check with forge_sites get, then finish setup with forge_wp.')
          return report.join('\n')
        }

        // 4. Optional: complete WordPress setup
        if (a.title && a.admin_user && a.admin_email) {
          const adminPass = (a.admin_password as string) ?? password()
          const dir = String(site.web_directory ?? '')
          const url = `http${site.https ? 's' : ''}://${domain}`
          const cmd =
            `wp --path=${shq(dir)} core is-installed 2>/dev/null && echo "[already installed]" || ` +
            `wp --path=${shq(dir)} core install --url=${shq(url)} --title=${shq(String(a.title))} ` +
            `--admin_user=${shq(String(a.admin_user))} --admin_email=${shq(String(a.admin_email))} --admin_password=${shq(adminPass)} --skip-email`
          const r = await runCommand(server.id, site.id, cmd, { waitMs: 40_000 })
          report.push(`Setup: ${describeResult(r, 600)}`)
          if (r.finished && r.exitCode === 0) report.push(`Admin: ${a.admin_user} / ${adminPass}`)
        } else {
          report.push('WordPress files are in place; finish setup in the browser or rerun with title + admin_user + admin_email.')
        }
        report.push("SSL: once DNS points here, forge_domains create_certificate issues Let's Encrypt.")
        return report.join('\n')
      },
    },
  },
}
