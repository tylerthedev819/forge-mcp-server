import { z } from 'zod';
import { request } from '../forge/client.js';
import { clip } from '../forge/format.js';
import { invalidateCache, resolveTarget } from '../forge/resolve.js';
import { getContent, getOne, LIST_PARAMS, listOf, need, P, send } from './define.js';
async function sitePath(a) {
    const t = await resolveTarget(a, 'site');
    return `/servers/${t.serverId}/sites/${t.siteId}`;
}
export const sitesTool = {
    name: 'forge_sites',
    summary: 'Sites: list, details, create, settings (PHP version, git, healthcheck), nginx config, composer/npm credentials. New WordPress sites: forge_install_wordpress.',
    params: {
        server: P.server,
        site: P.site,
        filter: z.string().optional().describe('Org-wide list: match site name'),
        kind: z.enum(['composer', 'npm']).optional().describe('Credentials type'),
        config: z.string().optional().describe('Full nginx config text for set_nginx'),
        data: P.data,
        ...LIST_PARAMS,
    },
    actions: {
        list: {
            level: 'readonly',
            doc: 'sites on `server`, or org-wide (optionally `filter`)',
            run: async (a) => {
                if (a.server)
                    return listOf(`/servers/${(await resolveTarget(a, 'server')).serverId}/sites`, a, 'sites');
                return listOf('/sites', a, 'sites', { include: 'server', 'filter[name]': a.filter });
            },
        },
        // A single site is served at the org level; the server-scoped URL only accepts PUT/DELETE.
        get: { level: 'readonly', doc: 'site details', run: async (a) => getOne(`/sites/${(await resolveTarget(a, 'site')).siteId}`, a, { include: 'server' }) },
        nginx: { level: 'readonly', doc: "site's nginx config", run: async (a) => clip(await getContent(`${await sitePath(a)}/nginx`), 20000) },
        healthcheck: { level: 'readonly', doc: 'healthcheck endpoint', run: async (a) => getOne(`${await sitePath(a)}/healthcheck`, a) },
        load_balancing: { level: 'readonly', doc: 'load balancer nodes', run: async (a) => listOf(`${await sitePath(a)}/load-balancing-nodes`, a, 'nodes') },
        credentials: { level: 'readonly', doc: 'composer or npm credentials (`kind`)', run: async (a) => getOne(`${await sitePath(a)}/${need(a.kind, 'kind')}/credentials`, a) },
        create: {
            level: 'write',
            doc: 'create site on `server` (data: {type, name, php_version, …})',
            run: async (a) => {
                const t = await resolveTarget(a, 'server');
                const out = await send('POST', `/servers/${t.serverId}/sites`, need(a.data, 'data'), a);
                invalidateCache();
                return out;
            },
        },
        update: { level: 'write', doc: 'update site (data: php_version, directory, root_path, push_to_deploy, repository_branch, …)', run: async (a) => send('PUT', await sitePath(a), need(a.data, 'data'), a) },
        git: { level: 'write', doc: 'install/update git repo (data: source_control_provider, repository, branch)', run: async (a) => send('PUT', `${await sitePath(a)}/git`, need(a.data, 'data'), a, 'Repository update started.') },
        set_nginx: { level: 'write', doc: 'replace nginx config with `config`', run: async (a) => send('PUT', `${await sitePath(a)}/nginx`, { config: need(a.config, 'config') }, a, 'Nginx config updated.') },
        set_healthcheck: { level: 'write', doc: 'set healthcheck (data)', run: async (a) => send('PUT', `${await sitePath(a)}/healthcheck`, need(a.data, 'data'), a) },
        set_load_balancing: { level: 'write', doc: 'set load balancer nodes (data)', run: async (a) => send('PUT', `${await sitePath(a)}/load-balancing-nodes`, need(a.data, 'data'), a) },
        add_credentials: { level: 'write', doc: 'add composer/npm credentials (`kind`, data)', run: async (a) => send('POST', `${await sitePath(a)}/${need(a.kind, 'kind')}/credentials`, need(a.data, 'data'), a) },
    },
};
export const domainsTool = {
    name: 'forge_domains',
    summary: "A site's domains and SSL certificates. `id` = domain record id (from list).",
    params: {
        server: P.server,
        site: P.site,
        id: P.id,
        certificate_id: z.string().optional(),
        domain_action: z.enum(['enable', 'disable', 'mark-as-primary']).optional(),
        certificate_action: z.enum(['enable', 'disable']).optional(),
        config: z.string().optional().describe('Full nginx config for set_nginx'),
        data: P.data,
        ...LIST_PARAMS,
    },
    actions: {
        list: { level: 'readonly', doc: 'domains and aliases', run: async (a) => listOf(`${await sitePath(a)}/domains`, a, 'domains') },
        get: { level: 'readonly', doc: 'domain details', run: async (a) => getOne(`${await sitePath(a)}/domains/${need(a.id, 'id')}`, a) },
        dns: { level: 'readonly', doc: 'DNS records Forge expects for the domain', run: async (a) => getOne(`${await sitePath(a)}/domains/${need(a.id, 'id')}/configurations`, a) },
        nginx: { level: 'readonly', doc: "domain's nginx config", run: async (a) => clip(await getContent(`${await sitePath(a)}/domains/${need(a.id, 'id')}/nginx`), 20000) },
        certificates: {
            level: 'readonly',
            doc: 'certificates for domain `id`, or all site certificates when `id` is omitted (older sites keep them at site level)',
            run: async (a) => listOf(a.id ? `${await sitePath(a)}/domains/${a.id}/certificates` : `${await sitePath(a)}/certificates`, a, 'certificates'),
        },
        certificate: {
            level: 'readonly',
            doc: 'certificate `certificate_id` of domain `id` (or the active one)',
            run: async (a) => {
                const base = await sitePath(a);
                if (a.certificate_id)
                    return getOne(`${base}/domains/${need(a.id, 'id')}/certificates/${a.certificate_id}`, a);
                try {
                    return await getOne(`${base}/domains/${need(a.id, 'id')}/certificates/active`, a);
                }
                catch {
                    return `No domain-level active certificate; site-level certificates:\n${await listOf(`${base}/certificates`, a, 'certificates')}`;
                }
            },
        },
        create: { level: 'write', doc: 'add domain (data: {name, www_redirect_type?, allow_wildcard_subdomains?})', run: async (a) => send('POST', `${await sitePath(a)}/domains`, need(a.data, 'data'), a) },
        update: { level: 'write', doc: 'update domain (data)', run: async (a) => send('PATCH', `${await sitePath(a)}/domains/${need(a.id, 'id')}`, need(a.data, 'data'), a) },
        domain_action: {
            level: 'write',
            doc: 'enable | disable | mark-as-primary (`domain_action`)',
            run: async (a) => send('POST', `${await sitePath(a)}/domains/${need(a.id, 'id')}/actions`, { action: need(a.domain_action, 'domain_action') }, a, 'Started.'),
        },
        set_nginx: { level: 'write', doc: "replace domain's nginx config with `config`", run: async (a) => send('PUT', `${await sitePath(a)}/domains/${need(a.id, 'id')}/nginx`, { config: need(a.config, 'config') }, a, 'Updated.') },
        create_certificate: {
            level: 'write',
            doc: "new certificate; default Let's Encrypt (http-01) enabled. data to override (type: letsencrypt|csr|existing|clone)",
            run: async (a) => send('POST', `${await sitePath(a)}/domains/${need(a.id, 'id')}/certificates`, a.data ?? { type: 'letsencrypt', enable: true, letsencrypt: { verification_method: 'http-01' } }, a, 'Certificate requested.'),
        },
        certificate_action: {
            level: 'write',
            doc: 'enable | disable certificate `certificate_id`',
            run: async (a) => send('POST', `${await sitePath(a)}/domains/${need(a.id, 'id')}/certificates/${need(a.certificate_id, 'certificate_id')}/actions`, { action: need(a.certificate_action, 'certificate_action') }, a, 'Started.'),
        },
    },
};
// ---- .env ------------------------------------------------------------------
function envValue(v) {
    return /^[A-Za-z0-9_./:@-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** Set keys in .env text, updating in place or appending. */
export function mergeEnv(content, values) {
    const lines = content.split('\n');
    for (const [key, raw] of Object.entries(values)) {
        const line = `${key}=${envValue(String(raw ?? ''))}`;
        const idx = lines.findIndex(l => l.replace(/^export\s+/, '').startsWith(`${key}=`));
        if (idx >= 0)
            lines[idx] = line;
        else {
            if (lines.length && lines[lines.length - 1] === '')
                lines.splice(lines.length - 1, 0, line);
            else
                lines.push(line);
        }
    }
    return lines.join('\n');
}
export const envTool = {
    name: 'forge_env',
    summary: "A site's .env file. Prefer `keys` to read only what you need, and `set` to change individual values.",
    params: {
        server: P.server,
        site: P.site,
        keys: z.array(z.string()).optional().describe('Only return these keys'),
        values: z.record(z.string()).optional().describe('For set: {KEY: value}'),
        content: z.string().optional().describe('For replace: full .env text'),
    },
    actions: {
        get: {
            level: 'readonly',
            doc: 'read .env (or just `keys`)',
            run: async (a) => {
                const content = await getContent(`${await sitePath(a)}/environment`);
                const keys = a.keys;
                if (!keys?.length)
                    return content || '(empty)';
                return content
                    .split('\n')
                    .filter(l => keys.some(k => l.replace(/^export\s+/, '').startsWith(`${k}=`)))
                    .join('\n') || '(none of those keys are set)';
            },
        },
        set: {
            level: 'write',
            doc: 'set `values` ({KEY: value}); other lines untouched',
            run: async (a) => {
                const path = `${await sitePath(a)}/environment`;
                const values = need(a.values, 'values');
                const merged = mergeEnv(await getContent(path), values);
                await request('PUT', path, { body: { environment: merged } });
                return `Set ${Object.keys(values).join(', ')}.`;
            },
        },
        replace: {
            level: 'write',
            doc: 'replace the whole file with `content`',
            run: async (a) => {
                await request('PUT', `${await sitePath(a)}/environment`, { body: { environment: need(a.content, 'content') } });
                return '.env replaced.';
            },
        },
    },
};
