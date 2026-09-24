import { z } from 'zod';
import { request, unwrap } from '../forge/client.js';
import { clip, record } from '../forge/format.js';
import { invalidateCache, resolveTarget } from '../forge/resolve.js';
import { getOne, LIST_PARAMS, listOf, need, P, send, view } from './define.js';
const srv = async (a) => `/servers/${(await resolveTarget(a, 'server')).serverId}`;
export const serversTool = {
    name: 'forge_servers',
    summary: 'Servers: details, events, and control (reboot, restart services).',
    params: {
        server: P.server,
        id: P.id,
        data: P.data,
        service: z.enum(['nginx', 'php', 'mysql', 'postgres', 'redis', 'supervisor']).optional(),
        service_action: z.string().optional().describe('nginx/mysql/postgres: reboot|stop; php: reboot|reload; redis/supervisor: reboot'),
        version: z.string().optional().describe('PHP version for php service actions, e.g. php84'),
        ...LIST_PARAMS,
    },
    actions: {
        list: { level: 'readonly', doc: 'list servers (forge_overview is cheaper for a fleet view)', run: a => listOf('/servers', a, 'servers') },
        get: { level: 'readonly', doc: 'server details', run: async (a) => getOne(await srv(a), a) },
        events: { level: 'readonly', doc: 'recent server events (or org-wide without server)', run: async (a) => listOf(a.server || a.site ? `${await srv(a)}/events` : '/events', a, 'events') },
        event_output: {
            level: 'readonly',
            doc: 'output of event `id`',
            run: async (a) => {
                const body = unwrap(await request('GET', `${await srv(a)}/events/${need(a.id, 'id')}/output`));
                return clip(body?.output ?? '(no output)');
            },
        },
        public_key: { level: 'readonly', doc: "server's own public SSH key", run: async (a) => getOne(`${await srv(a)}/key`, a) },
        network: { level: 'readonly', doc: 'network settings', run: async (a) => getOne(`${await srv(a)}/network`, a) },
        create: {
            level: 'write',
            doc: 'create a server; data per Forge API (see forge_options for providers/regions/sizes)',
            run: async (a) => {
                const out = await send('POST', '/servers', need(a.data, 'data'), a);
                invalidateCache();
                return out;
            },
        },
        update: { level: 'write', doc: 'update server (data: name, ip_address, …)', run: async (a) => send('PUT', await srv(a), need(a.data, 'data'), a) },
        update_network: { level: 'write', doc: 'update network settings (data)', run: async (a) => send('PUT', `${await srv(a)}/network`, need(a.data, 'data'), a) },
        reboot: { level: 'write', doc: 'reboot the server', run: async (a) => send('POST', `${await srv(a)}/actions`, { action: 'reboot' }, a, 'Reboot started.') },
        power_cycle: { level: 'write', doc: 'hard power-cycle (when reboot hangs)', run: async (a) => send('POST', `${await srv(a)}/actions`, { action: 'power-cycle' }, a, 'Power cycle started.') },
        service: {
            level: 'write',
            doc: 'service + service_action (+version for php), e.g. php reboot php84',
            run: async (a) => {
                const svc = need(a.service, 'service');
                const body = { action: need(a.service_action, 'service_action') };
                if (svc === 'php')
                    body.version = need(a.version, 'version');
                return send('POST', `${await srv(a)}/services/${svc}/actions`, body, a, `${svc} ${body.action} started.`);
            },
        },
    },
};
const SETTINGS = {
    cli_version: { path: () => '/php/cli-version', key: 'php_version' },
    site_version: { path: () => '/php/site-version', key: 'php_version' },
    max_upload_size: { path: () => '/php/max-upload-size', key: 'max_upload_size' },
    max_execution_time: { path: () => '/php/max-execution-time', key: 'max_execution_time' },
    opcache: { path: () => '/php/opcache' },
    fpm_config: { path: v => `/php/versions/${v}/configs/fpm`, key: 'config' },
    cli_config: { path: v => `/php/versions/${v}/configs/cli`, key: 'config' },
    pool_config: { path: v => `/php/versions/${v}/configs/pool`, key: 'config' },
};
function settingPath(a) {
    const s = SETTINGS[need(a.setting, 'setting')];
    if (!s)
        throw new Error(`Unknown setting. Use one of: ${Object.keys(SETTINGS).join(', ')}`);
    if (a.setting && String(a.setting).endsWith('_config'))
        need(a.version_id, 'version_id (from action=versions)');
    return s.path(a.version_id);
}
export const phpTool = {
    name: 'forge_php',
    summary: 'Server PHP: installed versions and settings (CLI/site default version, upload size, execution time, OPcache, FPM/CLI/pool config). Site PHP version: forge_sites update.',
    params: {
        server: P.server,
        site: P.site,
        setting: z.enum(Object.keys(SETTINGS)).optional(),
        version_id: z.string().optional().describe('PHP version record id (for *_config settings)'),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('New value, e.g. "8.4", 64, true'),
        data: P.data,
        format: P.format,
    },
    actions: {
        versions: { level: 'readonly', doc: 'installed PHP versions', run: async (a) => listOf(`${await srv(a)}/php/versions`, { ...a, all: true }, 'versions') },
        get: {
            level: 'readonly',
            doc: 'read `setting`',
            run: async (a) => {
                const path = `${await srv(a)}${settingPath(a)}`;
                if (String(a.setting).endsWith('_config'))
                    return clip(String(unwrap(await request('GET', path))?.configuration ?? ''), 20000);
                return record(unwrap(await request('GET', path)), view(a));
            },
        },
        set: {
            level: 'write',
            doc: 'change `setting` to `value` (opcache: true/false; *_config: full config text)',
            run: async (a) => {
                const base = await srv(a);
                const setting = need(a.setting, 'setting');
                if (setting === 'opcache') {
                    const on = a.value === true || a.value === 'true';
                    await request(on ? 'POST' : 'DELETE', `${base}/php/opcache`);
                    return `OPcache ${on ? 'enabled' : 'disabled'}.`;
                }
                const key = SETTINGS[setting].key;
                const body = a.data ?? { [key]: need(a.value, 'value') };
                return send('PUT', `${base}${settingPath(a)}`, body, a, `${setting} updated.`);
            },
        },
        install: { level: 'write', doc: 'install a PHP version (data: {version:"php85", cli_default?, site_default?})', run: async (a) => send('POST', `${await srv(a)}/php/versions`, need(a.data, 'data'), a, 'Install started.') },
        patch: { level: 'write', doc: 'apply patch updates to PHP version `version_id`', run: async (a) => send('PUT', `${await srv(a)}/php/versions/${need(a.version_id, 'version_id')}`, {}, a, 'Update started.') },
    },
};
export const optionsTool = {
    name: 'forge_options',
    summary: 'Reference data for creating servers: providers, regions, sizes, cloud credentials, VPCs. Also your Forge user and org.',
    params: {
        provider: z.string().optional().describe('Provider slug, e.g. ocean2'),
        region: z.string().optional().describe('Region code'),
        credential: z.string().optional().describe('Server credential id'),
        ...LIST_PARAMS,
    },
    actions: {
        providers: { level: 'readonly', doc: 'cloud providers', run: a => listOf('/providers', a, 'providers') },
        regions: { level: 'readonly', doc: 'regions for `provider`', run: a => listOf(`/providers/${need(a.provider, 'provider')}/regions`, { ...a, all: true }, 'regions') },
        sizes: {
            level: 'readonly',
            doc: 'sizes for `provider` (and `region`)',
            run: a => {
                const p = need(a.provider, 'provider');
                return listOf(a.region ? `/providers/${p}/regions/${a.region}/sizes` : `/providers/${p}/sizes`, { ...a, all: true }, 'sizes');
            },
        },
        credentials: { level: 'readonly', doc: 'cloud provider credentials in the org', run: a => listOf('/server-credentials', a, 'credentials') },
        vpcs: {
            level: 'readonly',
            doc: 'VPCs for `credential` + `region`',
            run: a => listOf(`/server-credentials/${need(a.credential, 'credential')}/regions/${need(a.region, 'region')}/vpcs`, a, 'vpcs'),
        },
        me: {
            level: 'readonly',
            doc: 'current user and organization',
            run: async (a) => {
                const [user, org] = await Promise.all([request('GET', '/user'), request('GET', '')]);
                return `${record(unwrap(user), view(a))}\n---\n${record(unwrap(org), view(a))}`;
            },
        },
    },
};
