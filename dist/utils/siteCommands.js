import { HttpMethod } from '../core/types/protocols.js';
import { callForgeApi } from './forgeApi.js';
function toSiteCommand(resource) {
    return { ...(resource.attributes ?? {}), id: String(resource.id) };
}
/** Parse a single command from a v2 (`data`) or v1 (`command`) response body. */
export function parseSiteCommand(body) {
    const b = body;
    if (b?.data?.id !== undefined)
        return toSiteCommand(b.data);
    if (b?.command?.id !== undefined) {
        return { ...b.command, id: String(b.command.id) };
    }
    return null;
}
const commandsPath = (serverId, siteId) => `/servers/${serverId}/sites/${siteId}/commands`;
export async function createSiteCommand(serverId, siteId, command, forgeApiKey) {
    return callForgeApi({
        endpoint: commandsPath(serverId, siteId),
        method: HttpMethod.POST,
        data: { command },
    }, forgeApiKey);
}
export async function getSiteCommand(serverId, siteId, commandId, forgeApiKey) {
    const body = await callForgeApi({
        endpoint: `${commandsPath(serverId, siteId)}/${commandId}`,
        method: HttpMethod.GET,
    }, forgeApiKey);
    return parseSiteCommand(body);
}
/**
 * Fetch a command's stdout. v2 serves it at `/commands/{id}/output` as
 * `data.attributes.output`; v1 put `output` next to `command` in the GET body.
 * Returns null when no output string is present.
 */
export async function getSiteCommandOutput(serverId, siteId, commandId, forgeApiKey) {
    const body = await callForgeApi({
        endpoint: `${commandsPath(serverId, siteId)}/${commandId}/output`,
        method: HttpMethod.GET,
    }, forgeApiKey);
    const b = body;
    const output = b?.data?.attributes?.output ?? b?.output;
    return typeof output === 'string' ? output : null;
}
/** List a site's commands newest-first, one page of at most `limit`. */
export async function listSiteCommands(serverId, siteId, forgeApiKey, limit, cursor) {
    const query = new URLSearchParams({
        sort: '-created_at',
        'page[size]': String(limit),
    });
    if (cursor)
        query.set('page[cursor]', cursor);
    const body = await callForgeApi({
        endpoint: `${commandsPath(serverId, siteId)}?${query.toString()}`,
        method: HttpMethod.GET,
    }, forgeApiKey);
    if (Array.isArray(body?.data)) {
        return {
            commands: body.data.map(toSiteCommand),
            nextCursor: body.meta?.next_cursor ?? null,
        };
    }
    // v1 fallback: no server-side sort/paging, so apply both here.
    const legacy = (body?.commands ?? [])
        .map(c => ({ ...c, id: String(c.id) }))
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    return { commands: legacy.slice(0, limit), nextCursor: null };
}
