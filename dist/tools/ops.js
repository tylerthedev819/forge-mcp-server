import { readFileSync } from 'fs';
import { homedir } from 'os';
import { z } from 'zod';
import { request, unwrap } from '../forge/client.js';
import { issueToken, redeemToken } from '../forge/confirm.js';
import { clip, table } from '../forge/format.js';
import { allServers, allSites, resolveServer, resolveTarget } from '../forge/resolve.js';
import { getContent, getOne, LIST_PARAMS, listOf, need, P, send } from './define.js';
const srv = async (a) => `/servers/${(await resolveTarget(a, 'server')).serverId}`;
async function sitePath(a) {
    const t = await resolveTarget(a, 'site');
    return `/servers/${t.serverId}/sites/${t.siteId}`;
}
export const jobsTool = {
    name: 'forge_jobs',
    summary: 'Scheduled jobs (cron). With `site`: that site\'s jobs; otherwise server jobs. Deletes: forge_destructive.',
    params: { server: P.server, site: P.site, id: P.id, data: P.data, ...LIST_PARAMS },
    actions: {
        list: { level: 'readonly', doc: 'jobs', run: async (a) => listOf(`${a.site ? await sitePath(a) : await srv(a)}/scheduled-jobs`, a, 'jobs') },
        get: { level: 'readonly', doc: 'job `id`', run: async (a) => getOne(`${a.site ? await sitePath(a) : await srv(a)}/scheduled-jobs/${need(a.id, 'id')}`, a) },
        output: {
            level: 'readonly',
            doc: 'last output of job `id`',
            run: async (a) => {
                const body = unwrap(await request('GET', `${a.site ? await sitePath(a) : await srv(a)}/scheduled-jobs/${need(a.id, 'id')}/output`));
                return clip(body?.output ?? '(no output)');
            },
        },
        create: {
            level: 'write',
            doc: 'new job (data: {command, user, frequency: minutely|hourly|nightly|weekly|monthly|reboot|custom, cron?, name?})',
            run: async (a) => send('POST', `${a.site ? await sitePath(a) : await srv(a)}/scheduled-jobs`, need(a.data, 'data'), a),
        },
    },
};
export const processesTool = {
    name: 'forge_processes',
    summary: 'Background processes / daemons (queue workers etc.) on a server. Deletes: forge_destructive.',
    params: {
        server: P.server,
        site: P.site,
        id: P.id,
        process_action: z.enum(['restart', 'stop', 'start', 'empty-log']).optional(),
        lines: z.number().int().optional().describe('Log lines (default 100)'),
        data: P.data,
        ...LIST_PARAMS,
    },
    actions: {
        list: { level: 'readonly', doc: 'processes', run: async (a) => listOf(`${await srv(a)}/background-processes`, a, 'processes') },
        get: { level: 'readonly', doc: 'process `id`', run: async (a) => getOne(`${await srv(a)}/background-processes/${need(a.id, 'id')}`, a) },
        log: {
            level: 'readonly',
            doc: 'log of process `id`',
            run: async (a) => {
                const content = await getContent(`${await srv(a)}/background-processes/${need(a.id, 'id')}/log`);
                return content.split('\n').slice(-(a.lines ?? 100)).join('\n') || '(empty)';
            },
        },
        create: { level: 'write', doc: 'new process (data: {command, user, directory?, processes?, …})', run: async (a) => send('POST', `${await srv(a)}/background-processes`, need(a.data, 'data'), a) },
        update: { level: 'write', doc: 'update process `id` (data)', run: async (a) => send('PUT', `${await srv(a)}/background-processes/${need(a.id, 'id')}`, need(a.data, 'data'), a) },
        control: {
            level: 'write',
            doc: 'restart | stop | start | empty-log process `id`',
            run: async (a) => send('POST', `${await srv(a)}/background-processes/${need(a.id, 'id')}/actions`, { action: need(a.process_action, 'process_action') }, a, 'Done.'),
        },
    },
};
// ---- SSH keys --------------------------------------------------------------------
function readKey(a) {
    if (a.key)
        return String(a.key).trim();
    const file = need(a.key_file, 'key or key_file');
    const path = file.startsWith('~/') ? `${homedir()}${file.slice(1)}` : file;
    if (!path.endsWith('.pub'))
        throw new Error('key_file must be a public key (.pub).');
    return readFileSync(path, 'utf8').trim();
}
const keyPlans = new Map();
async function keyTargets(a) {
    let servers;
    if (a.every_server)
        servers = await allServers();
    else if (Array.isArray(a.servers) && a.servers.length)
        servers = await Promise.all(a.servers.map(s => resolveServer(s)));
    else
        servers = [await resolveServer(need(a.server, 'server, servers, or every_server'))];
    const sites = a.per_site_user ? await allSites() : [];
    const targets = [];
    for (const s of servers) {
        const users = a.per_site_user
            ? [...new Set(sites.filter(x => x.server_id === s.id).map(x => String(x.user)))]
            : [String(a.user ?? 'forge')];
        for (const user of users.length ? users : [String(a.user ?? 'forge')])
            targets.push({ serverId: s.id, server: String(s.name), user });
    }
    return targets;
}
async function applyKeys(plan) {
    const rows = [];
    for (const t of plan.targets) {
        try {
            await request('POST', `/servers/${t.serverId}/ssh-keys`, { body: { name: plan.name, key: plan.key, user: t.user } });
            rows.push({ id: t.serverId, server: t.server, user: t.user, result: 'added' });
        }
        catch (e) {
            rows.push({ id: t.serverId, server: t.server, user: t.user, result: e.message });
        }
    }
    return table(rows, { fields: ['server', 'user', 'result'] });
}
export const sshKeysTool = {
    name: 'forge_ssh_keys',
    summary: 'SSH keys authorized on servers. add can target one server, a list, or every_server, for user forge or each site user (per_site_user). Multi-server adds need preview→token. Removal: forge_destructive.',
    params: {
        server: P.server,
        servers: z.array(z.string()).optional().describe('Several servers (names/ids)'),
        every_server: z.boolean().optional().describe('Target all servers in the org'),
        id: P.id,
        name: z.string().optional().describe('Key label in Forge'),
        key: z.string().optional().describe('Public key text'),
        key_file: z.string().optional().describe('Local .pub file on this machine, e.g. ~/.ssh/id_ed25519.pub'),
        user: z.string().optional().describe('Server user (default forge)'),
        per_site_user: z.boolean().optional().describe("Add for every site's user on each server (isolated sites)"),
        token: z.string().optional().describe('From a multi-server add preview'),
        ...LIST_PARAMS,
    },
    actions: {
        list: { level: 'readonly', doc: 'keys on `server`', run: async (a) => listOf(`${await srv(a)}/ssh-keys`, a, 'keys') },
        get: { level: 'readonly', doc: 'key `id` on `server`', run: async (a) => getOne(`${await srv(a)}/ssh-keys/${need(a.id, 'id')}`, a) },
        add: {
            level: 'write',
            doc: 'authorize a public key (name + key|key_file); returns a preview+token when more than one target',
            run: async (a) => {
                if (a.token) {
                    const plan = keyPlans.get(String(a.token));
                    if (!plan || !redeemToken(String(a.token), 'ssh-keys'))
                        return 'Unknown or expired token. Run add again without token.';
                    keyPlans.delete(String(a.token));
                    return applyKeys(plan);
                }
                const plan = { name: need(a.name, 'name'), key: readKey(a), targets: await keyTargets(a) };
                if (!/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-)/.test(plan.key))
                    throw new Error('That does not look like an SSH public key.');
                if (plan.targets.length === 1)
                    return applyKeys(plan);
                const token = issueToken('ssh-keys');
                keyPlans.set(token, plan);
                return (`Will add key "${plan.name}" (${plan.key.split(' ')[0]} …${plan.key.slice(-24)}) to ${plan.targets.length} server/user pairs:\n` +
                    table(plan.targets.map(t => ({ id: t.serverId, ...t })), { fields: ['server', 'user'] }) +
                    `\n\nToken: ${token} (15 min). Confirm with the user, then add token=${token}.`);
            },
        },
    },
};
// ---- Firewall, security rules, redirects ----------------------------------------
export const securityTool = {
    name: 'forge_security',
    summary: 'Server firewall rules; site security rules (password-protected paths) and redirect rules. Deletes: forge_destructive.',
    params: { server: P.server, site: P.site, id: P.id, data: P.data, ...LIST_PARAMS },
    actions: {
        firewall: { level: 'readonly', doc: 'firewall rules on `server`', run: async (a) => listOf(`${await srv(a)}/firewall-rules`, a, 'rules') },
        security_rules: { level: 'readonly', doc: 'site security rules', run: async (a) => listOf(`${await sitePath(a)}/security-rules`, a, 'rules') },
        redirects: { level: 'readonly', doc: 'site redirect rules', run: async (a) => listOf(`${await sitePath(a)}/redirect-rules`, a, 'redirects') },
        export_redirects: { level: 'readonly', doc: 'redirects as CSV', run: async (a) => clip(String(unwrap(await request('GET', `${await sitePath(a)}/redirect-rules/export`)) ?? ''), 20000) },
        add_firewall: { level: 'write', doc: 'open a port (data: {name, port, ip_address?, type?})', run: async (a) => send('POST', `${await srv(a)}/firewall-rules`, need(a.data, 'data'), a) },
        add_security_rule: { level: 'write', doc: 'protect a path (data: {name, path?, credentials:[{username,password}]})', run: async (a) => send('POST', `${await sitePath(a)}/security-rules`, need(a.data, 'data'), a) },
        update_security_rule: { level: 'write', doc: 'update rule `id` (data)', run: async (a) => send('PUT', `${await sitePath(a)}/security-rules/${need(a.id, 'id')}`, need(a.data, 'data'), a) },
        add_redirect: { level: 'write', doc: 'add redirect (data: {from, to, type: redirect|permanent})', run: async (a) => send('POST', `${await sitePath(a)}/redirect-rules`, need(a.data, 'data'), a) },
        reorder_redirects: { level: 'write', doc: 'set redirect order (data)', run: async (a) => send('PUT', `${await sitePath(a)}/redirect-rules/reorder`, need(a.data, 'data'), a) },
        import_redirects: { level: 'write', doc: 'import redirects from CSV (data)', run: async (a) => send('POST', `${await sitePath(a)}/redirect-rules/import`, need(a.data, 'data'), a) },
    },
};
