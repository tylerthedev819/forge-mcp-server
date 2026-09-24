import fetch from 'node-fetch';
const API_ROOT = 'https://forge.laravel.com/api';
/** Account-level paths that are not served beneath /orgs/{slug}. */
const UNSCOPED = ['/user', '/me', '/orgs', '/providers'];
export class ForgeError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
let config;
export function configureClient(c) {
    config = c;
}
function cfg() {
    if (!config)
        throw new Error('Forge client is not configured');
    return config;
}
export function orgSlug() {
    return cfg().org;
}
function buildUrl(path, query) {
    if (path.startsWith('http'))
        return path;
    const scoped = !UNSCOPED.some(p => path === p || path.startsWith(`${p}/`));
    const url = new URL(`${API_ROOT}${scoped ? `/orgs/${cfg().org}` : ''}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined && v !== null && v !== '')
            url.searchParams.set(k, String(v));
    }
    return url.toString();
}
/** Keep Forge's error message and any validation details, drop the rest. */
function errorMessage(status, body) {
    if (typeof body === 'string')
        return `Forge API ${status}: ${body.slice(0, 300)}`;
    const b = body;
    const details = b?.errors
        ? ' ' +
            Object.entries(b.errors)
                .map(([field, msgs]) => `${field}: ${msgs.join(' ')}`)
                .join('; ')
        : '';
    return `Forge API ${status}: ${b?.message ?? 'request failed'}${details}`;
}
export async function request(method, path, opts = {}) {
    const res = await fetch(buildUrl(path, opts.query), {
        method,
        headers: {
            Authorization: `Bearer ${cfg().apiKey}`,
            Accept: 'application/vnd.api+json, application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'forge-mcp-server',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body = text;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
        try {
            body = JSON.parse(text);
        }
        catch {
            // keep raw text
        }
    }
    if (!res.ok)
        throw new ForgeError(errorMessage(res.status, body), res.status);
    return (text ? body : null);
}
/** Flatten a JSON:API resource to { id, _type, ...attributes, <rel>_id }. */
export function flatten(resource) {
    const r = resource;
    const out = { id: String(r.id), _type: r.type };
    Object.assign(out, r.attributes ?? {});
    out.id = String(r.id);
    out._type = r.type;
    for (const [name, rel] of Object.entries(r.relationships ?? {})) {
        if (rel?.data && !Array.isArray(rel.data))
            out[`${name}_id`] = rel.data.id;
    }
    return out;
}
/** Normalize any Forge response body into records (lists) or one record. */
export function unwrap(body) {
    const b = body;
    if (!b || typeof b !== 'object' || !('data' in b))
        return body;
    if (Array.isArray(b.data))
        return b.data.map(flatten);
    if (b.data && typeof b.data === 'object' && 'id' in b.data) {
        return flatten(b.data);
    }
    return b.data;
}
export const MAX_PAGE_SIZE = 30;
export async function getPage(path, opts = {}) {
    const body = await request('GET', path, {
        query: {
            ...opts.query,
            'page[size]': Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE),
            'page[cursor]': opts.cursor,
        },
    });
    const items = Array.isArray(body?.data) ? body.data.map(flatten) : [];
    return { items, nextCursor: body?.meta?.next_cursor ?? null };
}
/**
 * Fetch a list honoring the caller's budget: one page by default, every page
 * when `all` is set, but never more than `max` items so a runaway list can't
 * flood the conversation.
 */
export async function getList(path, opts = {}) {
    const limit = opts.limit ?? 25;
    if (!opts.all) {
        const page = await getPage(path, { limit, cursor: opts.cursor, query: opts.query });
        return { items: page.items.slice(0, limit), nextCursor: page.nextCursor, capped: false };
    }
    const max = opts.max ?? 500;
    const items = [];
    let cursor = opts.cursor;
    do {
        const page = await getPage(path, { cursor, query: opts.query });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor && items.length < max);
    return {
        items: items.slice(0, max),
        nextCursor: cursor ?? null,
        capped: items.length >= max && !!cursor,
    };
}
