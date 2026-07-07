import { HttpMethod } from '../../core/types/protocols.js';
import { callForgeApi } from '../../utils/forgeApi.js';
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
import { executeSiteCommandConfirmationStore } from './confirmExecuteSiteCommandTool.js';
import { validateConfirmation, markConfirmationUsed, } from '../../utils/confirmationStore.js';
const paramsSchema = {
    serverId: z
        .string()
        .describe('The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'),
    siteId: z
        .string()
        .describe('The ID of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'),
    command: z
        .string()
        .describe('The shell command to execute on the site. This will run in the context of the site directory.'),
    waitForCompletion: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to wait for the command to complete before returning. If true (default), the tool polls until the command reaches a terminal status AND its stdout is retrievable, then returns { status, exitCode, output, errorOutput, duration }. If false, returns immediately with the command ID; use get_site_command to fetch status and output later.'),
    confirmationId: z
        .string()
        .describe('This confirmationId must be obtained from confirm_execute_site_command tool after explicit user confirmation. If an invalid or mismatched confirmationId is provided, the operation will be rejected.'),
};
const paramsZodObject = z.object(paramsSchema);
// Statuses at which a command has stopped running.
const TERMINAL_STATUSES = ['finished', 'failed', 'error'];
/**
 * Forge does not stream stdout. It writes each command's combined output to a
 * `~/.forge/provision-<event_id>.output` file (in the site user's home) and
 * reads that file back to populate the API's `output` field. That file write
 * lags a few seconds behind the status flipping to "finished", so an early read
 * returns the stderr of Forge's own `cat` of the not-yet-written file, e.g.:
 *
 *   cat: /home/forge/.forge/provision-199071958.output: No such file or directory
 *
 * We treat that signature (and a null/absent body) as "output not ready yet"
 * and keep polling until the real stdout lands. Verified live: re-reading the
 * same finished command a few seconds later returns the true output on both
 * isolated and non-isolated sites.
 */
const OUTPUT_NOT_READY_PATTERN = /cat: .*\.forge\/provision-\d+\.output: No such file or directory/;
function isOutputReady(output) {
    if (output === null || output === undefined)
        return false;
    return !OUTPUT_NOT_READY_PATTERN.test(output);
}
function isTerminalStatus(status) {
    return status !== undefined && TERMINAL_STATUSES.includes(status);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchCommand(serverId, siteId, commandId, forgeApiKey) {
    try {
        return await callForgeApi({
            endpoint: `/servers/${serverId}/sites/${siteId}/commands/${commandId}`,
            method: HttpMethod.GET,
        }, forgeApiKey);
    }
    catch {
        // Ignore transient errors during polling; the caller will retry.
        return null;
    }
}
/**
 * Waits for a command to finish AND for its output to become readable.
 *
 * Phase 1 polls until the status is terminal (finished/failed/error).
 * Phase 2 keeps polling until `output` settles — no longer the transient
 * "output not ready" signature, and stable across reads (an empty body must
 * repeat once so a pre-write blank isn't mistaken for a genuinely empty result).
 *
 * Returns the last response seen plus `outputReady`, which is false when Phase 2
 * timed out (status and exit_code are still authoritative in that case).
 */
async function waitForCommandCompletion(serverId, siteId, commandId, forgeApiKey, statusTimeoutMs = 120000, outputTimeoutMs = 20000, statusPollMs = 2000, outputPollMs = 1500) {
    let last = null;
    // Phase 1: wait for a terminal status.
    const statusDeadline = Date.now() + statusTimeoutMs;
    while (Date.now() < statusDeadline) {
        const response = await fetchCommand(serverId, siteId, commandId, forgeApiKey);
        if (response) {
            last = response;
            if (isTerminalStatus(response.command?.status))
                break;
        }
        await sleep(statusPollMs);
    }
    if (!last || !isTerminalStatus(last.command?.status)) {
        // Timed out before the command reached a terminal status.
        return last ? { response: last, outputReady: false } : null;
    }
    // Phase 2: wait for the output-file readback to settle.
    const outputDeadline = Date.now() + outputTimeoutMs;
    let previousOutput;
    for (;;) {
        const output = last.output;
        if (isOutputReady(output)) {
            // Non-empty output is accepted immediately; empty output must repeat once.
            if ((output && output.length > 0) || output === previousOutput) {
                return { response: last, outputReady: true };
            }
            previousOutput = output;
        }
        if (Date.now() >= outputDeadline) {
            return { response: last, outputReady: isOutputReady(last.output) };
        }
        await sleep(outputPollMs);
        const response = await fetchCommand(serverId, siteId, commandId, forgeApiKey);
        if (response)
            last = response;
    }
}
export const executeSiteCommandTool = {
    name: 'execute_site_command',
    parameters: paramsSchema,
    annotations: {
        title: 'Execute Site Command',
        description: `Executes a shell command on a site in Laravel Forge.

The command runs in the context of the site's directory on the server. This is useful for:
- Clearing files (e.g., rm -rf /home/forge/{domain}/public/*)
- Running artisan commands
- Checking file contents
- Any other shell operations

Before calling this tool, the client MUST call the 'confirm_execute_site_command' tool and present the returned summary to the user for explicit confirmation. Only if the user confirms, the client should proceed to call this tool.

WARNING: Shell commands have full access to the site's filesystem and can be destructive. Always review commands carefully.`,
        operation: 'create',
        resource: 'site_command',
        safe: false,
        readOnlyHint: false,
        openWorldHint: true,
        readWriteHint: true,
        // Classified as a "write" tool (not "destructive") so it is enabled by
        // the standard `--tools=readonly,write` configuration. Command execution
        // can be destructive, but that risk is gated by the mandatory
        // confirm_execute_site_command step and the warning in the description
        // above, not by the category tier.
        destructiveHint: false,
    },
    handler: async (params, forgeApiKey) => {
        try {
            const parsed = paramsZodObject.parse(params);
            const { confirmationId, serverId, siteId, command, waitForCompletion } = parsed;
            // Validate confirmation using generic utility
            const confirmation = validateConfirmation(executeSiteCommandConfirmationStore, confirmationId, (stored) => {
                return (stored.serverId === serverId &&
                    stored.siteId === siteId &&
                    stored.command === command);
            });
            if (!confirmation) {
                return toMCPToolError(new Error('Invalid or expired confirmation ID. Please call confirm_execute_site_command first and get user approval.'));
            }
            markConfirmationUsed(executeSiteCommandConfirmationStore, confirmationId);
            // Execute the command
            const executeResponse = await callForgeApi({
                endpoint: `/servers/${serverId}/sites/${siteId}/commands`,
                method: HttpMethod.POST,
                data: { command },
            }, forgeApiKey);
            const commandId = executeResponse.command?.id;
            if (!commandId) {
                return toMCPToolError(new Error('Failed to execute command: No command ID returned'));
            }
            // If not waiting for completion, return immediately
            if (!waitForCompletion) {
                return toMCPToolResult({
                    success: true,
                    message: 'Command execution started',
                    commandId,
                    status: executeResponse.command.status,
                    note: 'Use get_site_command to check status and retrieve output',
                });
            }
            // Wait for command to complete
            const completedCommand = await waitForCommandCompletion(serverId, siteId, commandId, forgeApiKey);
            if (!completedCommand) {
                return toMCPToolResult({
                    success: false,
                    message: 'Command execution timed out. The command may still be running.',
                    commandId,
                    note: 'Use get_site_command to check status and retrieve output',
                });
            }
            const cmd = completedCommand.response.command;
            const succeeded = cmd.status === 'finished' && (cmd.exit_code ?? 0) === 0;
            return toMCPToolResult({
                success: succeeded,
                message: `Command execution ${cmd.status}`,
                commandId,
                status: cmd.status,
                exitCode: cmd.exit_code ?? null,
                duration: cmd.duration ?? null,
                output: completedCommand.outputReady
                    ? completedCommand.response.output
                    : '',
                errorOutput: cmd.error_output ?? null,
                ...(completedCommand.outputReady
                    ? {}
                    : {
                        outputWarning: 'Command stdout could not be retrieved from Forge in time (a known lag in Forge’s output capture). The status and exitCode above are authoritative; call get_site_command again shortly to fetch the stdout.',
                    }),
            });
        }
        catch (err) {
            return toMCPToolError(err);
        }
    },
};
/**
 * Internal helper function for executing commands without the confirmation flow.
 * This is useful for other tools (like installWordPressTool) that already have
 * their own confirmation mechanisms.
 *
 * @param serverId - The server ID
 * @param siteId - The site ID
 * @param command - The shell command to execute
 * @param forgeApiKey - The Forge API key
 * @param waitForCompletion - Whether to wait for the command to complete
 * @returns The command result with output (if waited) or just the command ID
 */
export async function executeCommandInternal(serverId, siteId, command, forgeApiKey, waitForCompletion = true) {
    try {
        // Execute the command
        const executeResponse = await callForgeApi({
            endpoint: `/servers/${serverId}/sites/${siteId}/commands`,
            method: HttpMethod.POST,
            data: { command },
        }, forgeApiKey);
        const commandId = executeResponse.command?.id;
        if (!commandId) {
            return {
                success: false,
                error: 'No command ID returned from Forge API',
            };
        }
        if (!waitForCompletion) {
            return {
                success: true,
                commandId,
                status: executeResponse.command.status,
            };
        }
        // Wait for command to complete
        const completedCommand = await waitForCommandCompletion(serverId, siteId, commandId, forgeApiKey);
        if (!completedCommand) {
            return {
                success: false,
                commandId,
                error: 'Command execution timed out',
            };
        }
        const cmd = completedCommand.response.command;
        return {
            success: cmd.status === 'finished' && (cmd.exit_code ?? 0) === 0,
            commandId,
            status: cmd.status,
            exitCode: cmd.exit_code ?? null,
            output: completedCommand.outputReady
                ? completedCommand.response.output
                : '',
            errorOutput: cmd.error_output ?? null,
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
