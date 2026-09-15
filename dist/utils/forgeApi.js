import fetch from 'node-fetch';
const API_ROOT = 'https://forge.laravel.com/api';
/**
 * Endpoints that are not organization-scoped in Forge API v2.
 * Everything else is served beneath /orgs/{slug}.
 */
const UNSCOPED_PREFIXES = [
    '/user',
    '/organizations',
    '/providers',
    '/regions',
    '/permissions',
    '/predefined-roles',
    '/recipes',
];
let cachedOrgSlug;
function isUnscoped(endpoint) {
    return UNSCOPED_PREFIXES.some(prefix => endpoint === prefix ||
        endpoint.startsWith(`${prefix}/`) ||
        endpoint.startsWith(`${prefix}?`));
}
async function request(url, method, data, forgeApiKey) {
    const headers = {
        Authorization: `Bearer ${forgeApiKey}`,
        Accept: 'application/vnd.api+json, application/json',
        'Content-Type': 'application/json',
    };
    let response;
    try {
        response = await fetch(url, {
            method: method.toUpperCase(),
            headers,
            body: data ? JSON.stringify(data) : undefined,
        });
    }
    catch (err) {
        throw new Error(`Network error: ${err}`);
    }
    // v2 answers with application/vnd.api+json, so match on the suffix rather
    // than the exact application/json type.
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('json')
        ? await response.json()
        : await response.text();
    return { status: response.status, ok: response.ok, body };
}
/**
 * Resolve the organization slug every scoped call needs. An explicit
 * FORGE_ORG wins; otherwise fall back to the account's first organization.
 */
async function resolveOrgSlug(forgeApiKey) {
    const configured = process.env.FORGE_ORG?.trim();
    if (configured)
        return configured;
    if (cachedOrgSlug)
        return cachedOrgSlug;
    const res = await request(`${API_ROOT}/organizations`, 'GET', undefined, forgeApiKey);
    if (!res.ok) {
        throw new Error(`Forge API error (${res.status}) while resolving organization: ${JSON.stringify(res.body)}`);
    }
    const payload = res.body;
    const list = payload?.data ?? payload?.organizations ?? payload;
    const slug = Array.isArray(list) ? list[0]?.slug : undefined;
    if (!slug) {
        throw new Error('Could not determine a Forge organization for this API token. Set FORGE_ORG to your organization slug.');
    }
    cachedOrgSlug = slug;
    return slug;
}
export async function callForgeApi(req, forgeApiKey) {
    const attempt = async (withOrg) => {
        const url = withOrg
            ? `${API_ROOT}/orgs/${await resolveOrgSlug(forgeApiKey)}${req.endpoint}`
            : `${API_ROOT}${req.endpoint}`;
        return request(url, req.method, req.data, forgeApiKey);
    };
    const preferOrg = !isUnscoped(req.endpoint);
    let res = await attempt(preferOrg);
    // The v2 scoping of a few account-level endpoints is undocumented. If the
    // first shape 404s, try the other one once before reporting failure.
    if (res.status === 404) {
        const alternate = await attempt(!preferOrg).catch(() => null);
        if (alternate?.ok)
            res = alternate;
    }
    if (!res.ok) {
        throw new Error(`Forge API error (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res.body;
}
