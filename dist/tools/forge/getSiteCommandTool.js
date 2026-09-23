import { getSiteCommand, getSiteCommandOutput, } from '../../utils/siteCommands.js';
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
const paramsSchema = {
    serverId: z
        .string()
        .describe('The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'),
    siteId: z
        .string()
        .describe('The ID of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'),
    commandId: z
        .string()
        .describe('The ID of the command to retrieve. This is returned when executing a command via execute_site_command.'),
};
const paramsZodObject = z.object(paramsSchema);
export const getSiteCommandTool = {
    name: 'get_site_command',
    parameters: paramsSchema,
    annotations: {
        title: 'Get Site Command',
        description: `Retrieves the details and output of a specific site command.

This is useful for:
- Checking the status of a command that was started with waitForCompletion=false
- Retrieving the output of a previously executed command
- Debugging failed commands

The response includes the command text, status ('waiting', 'running', 'finished', 'failed'), exitCode, errorOutput, duration, timestamps, and output (the command's stdout).

Note: output can lag a few seconds behind the status becoming 'finished'. If output is null, or contains a message like "cat: /home/.../.forge/provision-<id>.output: No such file or directory", the stdout is not ready yet — call this tool again shortly. The status and exitCode are authoritative as soon as the status is terminal.`,
        operation: 'get',
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
            const { serverId, siteId, commandId } = parsed;
            const cmd = await getSiteCommand(serverId, siteId, commandId, forgeApiKey);
            if (!cmd) {
                return toMCPToolError(new Error(`Command ${commandId} not found or unreadable`));
            }
            // v2 serves stdout from its own endpoint; a failed read shouldn't hide
            // the status fields, so report it as not-yet-available instead.
            let output = null;
            try {
                output = await getSiteCommandOutput(serverId, siteId, commandId, forgeApiKey);
            }
            catch {
                output = null;
            }
            return toMCPToolResult({
                id: cmd.id,
                command: cmd.command ?? null,
                status: cmd.status ?? null,
                exitCode: cmd.exit_code ?? null,
                errorOutput: cmd.error_output ?? null,
                duration: cmd.duration ?? null,
                createdAt: cmd.created_at ?? null,
                updatedAt: cmd.updated_at ?? null,
                output,
            });
        }
        catch (err) {
            return toMCPToolError(err);
        }
    },
};
