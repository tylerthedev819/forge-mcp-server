import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { listSiteCommands } from '../../utils/siteCommands.js';
import { z } from 'zod';
// Command strings can be long multi-line scripts; the list is for finding a
// command, so show enough to recognize it. get_site_command has the full text.
const MAX_COMMAND_CHARS = 200;
const paramsSchema = {
    serverId: z
        .string()
        .describe('The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'),
    siteId: z
        .string()
        .describe('The ID of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe('Maximum number of commands to return, newest first (default 5, max 50).'),
    cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous call's nextCursor, to fetch older commands."),
};
const paramsZodObject = z.object(paramsSchema);
export const listSiteCommandsTool = {
    name: 'list_site_commands',
    parameters: paramsSchema,
    annotations: {
        title: 'List Site Commands',
        description: `Lists a site's command history, newest first.

Returns up to \`limit\` commands (default 5), each with:
- Command ID
- The command that was run (truncated to ${MAX_COMMAND_CHARS} characters)
- Status (waiting, running, finished, failed) and exit code
- Timestamps

Pass the returned nextCursor as \`cursor\` to page back through older commands. Use get_site_command with a specific command ID to retrieve its full text and output.`,
        operation: 'list',
        resource: 'site_command',
        safe: true,
        readOnlyHint: true,
        openWorldHint: false,
        readWriteHint: false,
        destructiveHint: false,
    },
    handler: async (params, forgeApiKey) => {
        try {
            const parsed = paramsZodObject.parse(params);
            const { serverId, siteId, limit, cursor } = parsed;
            const { commands, nextCursor } = await listSiteCommands(serverId, siteId, forgeApiKey, limit, cursor);
            return toMCPToolResult({
                commands: commands.map(c => {
                    const text = c.command ?? '';
                    const truncated = text.length > MAX_COMMAND_CHARS;
                    return {
                        id: c.id,
                        command: truncated ? `${text.slice(0, MAX_COMMAND_CHARS)}…` : text,
                        ...(truncated ? { commandTruncated: true } : {}),
                        status: c.status ?? null,
                        exitCode: c.exit_code ?? null,
                        createdAt: c.created_at ?? null,
                        updatedAt: c.updated_at ?? null,
                    };
                }),
                nextCursor,
            });
        }
        catch (err) {
            return toMCPToolError(err);
        }
    },
};
