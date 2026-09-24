import { z } from 'zod';
import { request, unwrap } from '../forge/client.js';
import { CATALOG } from '../forge/catalog.js';
import { clip, record, table } from '../forge/format.js';
import { resolveTarget } from '../forge/resolve.js';
import { need, P, view } from './define.js';
const ADMIN = [/^\/teams/, /^\/roles/, /^\/permissions/, /^\/predefined-roles/];
/** Fill {server}/{site} placeholders from names, and require a clean path. */
async function fillPath(a) {
    let path = need(a.path, 'path').trim();
    if (!path.startsWith('/'))
        path = `/${path}`;
    path = path.replace(/^\/orgs\/\{organization\}/, '');
    if (path.includes('{server}') || path.includes('{site}')) {
        const t = await resolveTarget(a, path.includes('{site}') ? 'site' : 'server');
        path = path.replace('{server}', t.serverId).replace('{site}', t.siteId ?? '{site}');
    }
    if (/\{[a-zA-Z]+\}/.test(path))
        throw new Error(`Fill in the remaining placeholders in ${path}`);
    return path;
}
function render(body, a) {
    const r = unwrap(body);
    if (r === null || r === undefined || r === '')
        return 'Done.';
    if (Array.isArray(r))
        return table(r, view(a));
    if (typeof r === 'object' && r && 'content' in r && Object.keys(r).length <= 3)
        return clip(String(r.content), 20000);
    if (typeof r === 'object')
        return record(r, view(a));
    return clip(String(r), 20000);
}
async function call(method, a) {
    const path = await fillPath(a);
    if (method !== 'GET' && ADMIN.some(r => r.test(path)))
        throw new Error('Org administration is not available through this server.');
    return render(await request(method, path, { query: a.query, body: method === 'GET' ? undefined : (a.data ?? {}) }), a);
}
export const apiTool = {
    name: 'forge_api',
    summary: 'Any other Forge API endpoint (monitors, heartbeats, recipes, Laravel integrations, nginx templates, tags, events, …). Search the catalog, then call. {server}/{site} in paths are filled from server/site names. DELETE: forge_destructive target=api_path.',
    params: {
        search: z.string().optional().describe('catalog: words to match in path/summary'),
        path: z.string().optional().describe('e.g. /servers/{server}/monitors'),
        query: z.record(z.unknown()).optional().describe('Query string params'),
        server: P.server,
        site: P.site,
        data: P.data,
        fields: P.fields,
        full: P.full,
        format: P.format,
    },
    actions: {
        catalog: {
            level: 'readonly',
            doc: 'find endpoints (method path — summary [body fields, * required])',
            run: async (a) => {
                const words = String(a.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                const hits = CATALOG.filter(([m, p, s]) => words.every(w => `${m} ${p} ${s}`.toLowerCase().includes(w)));
                if (!hits.length)
                    return 'No endpoints match.';
                const shown = hits.slice(0, 40).map(([m, p, s, b]) => `${m} ${p} — ${s}${b ? ` [${b}]` : ''}`);
                return shown.join('\n') + (hits.length > 40 ? `\n[${hits.length - 40} more; refine the search]` : '');
            },
        },
        get: { level: 'readonly', doc: 'GET `path` (+query)', run: a => call('GET', a) },
        post: { level: 'write', doc: 'POST `path` with data', run: a => call('POST', a) },
        put: { level: 'write', doc: 'PUT `path` with data', run: a => call('PUT', a) },
        patch: { level: 'write', doc: 'PATCH `path` with data', run: a => call('PATCH', a) },
    },
};
