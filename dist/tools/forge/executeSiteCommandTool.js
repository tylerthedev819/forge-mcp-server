import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
import { executeSiteCommandConfirmationStore } from './confirmExecuteSiteCommandTool.js';
import { validateConfirmation, markConfirmationUsed, } from '../../utils/confirmationStore.js';
import { createSiteCommand, getSiteCommand, getSiteCommandOutput, listSiteCommands, parseSiteCommand, } from '../../utils/siteCommands.js';
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
 * Forge captures a command's stdout to a `~/.forge/provision-<event_id>.output`
 * file and serves it back through the API. That readback can lag a few seconds
 * behind the status flipping to "finished"; an early read has returned the
 * stderr of Forge's own `cat` of the not-yet-written file, e.g.:
 *
 *   cat: /home/forge/.forge/provision-199071958.output: No such file or directory
 *
 * We treat that signature (and a missing body) as "output not ready yet" and
 * keep polling until the real stdout lands.
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
// Polling tolerates transient errors; the caller retries on the next tick.
async function tryGet(fn) {
    try {
        return await fn();
    }
    catch {
        return null;
    }
}
/**
 * Waits for a command to finish AND for its output to become readable.
 *
 * Phase 1 polls the command until its status is terminal (finished/failed/error).
 * Phase 2 polls the output endpoint until it settles — present, not the
 * transient "output not ready" signature, and (if empty) stable across two
 * reads so a pre-write blank isn't mistaken for a genuinely empty result.
 *
 * Returns the last command seen plus its output and `outputReady`, which is
 * false when Phase 2 timed out (status and exit_code are still authoritative).
 */
async function waitForCommandCompletion(serverId, siteId, commandId, forgeApiKey, statusTimeoutMs = 120000, outputTimeoutMs = 20000, statusPollMs = 2000, outputPollMs = 1500) {
    let last = null;
    // Phase 1: wait for a terminal status.
    const statusDeadline = Date.now() + statusTimeoutMs;
    while (Date.now() < statusDeadline) {
        const command = await tryGet(() => getSiteCommand(serverId, siteId, commandId, forgeApiKey));
        if (command) {
            last = command;
            if (isTerminalStatus(command.status))
                break;
        }
        await sleep(statusPollMs);
    }
    if (!last || !isTerminalStatus(last.status)) {
        // Timed out before the command reached a terminal status.
        return last ? { command: last, output: null, outputReady: false } : null;
    }
    // Phase 2: wait for the output readback to settle.
    const outputDeadline = Date.now() + outputTimeoutMs;
    let previousOutput;
    for (;;) {
        const output = await tryGet(() => getSiteCommandOutput(serverId, siteId, commandId, forgeApiKey));
        if (isOutputReady(output)) {
            // Non-empty output is accepted immediately; empty output must repeat once.
            if ((output && output.length > 0) || output === previousOutput) {
                return { command: last, output, outputReady: true };
            }
            previousOutput = output ?? undefined;
        }
        if (Date.now() >= outputDeadline) {
            return {
                command: last,
                output: isOutputReady(output) ? output : null,
                outputReady: isOutputReady(output),
            };
        }
        await sleep(outputPollMs);
    }
}
/**
 * Resolve the ID of a command we just POSTed.
 *
 * Normally it's in the response body (v2: `data.id`). If Forge accepted the
 * POST but the ID can't be read, the command has still been created, so look
 * it up by its text among the newest commands rather than reporting a failure
 * that would invite a duplicate run.
 */
async function resolveCreatedCommandId(postResponse, serverId, siteId, command, forgeApiKey) {
    const parsed = parseSiteCommand(postResponse);
    if (parsed)
        return parsed.id;
    const recent = await tryGet(() => listSiteCommands(serverId, siteId, forgeApiKey, 5));
    return recent?.commands.find(c => c.command === command)?.id ?? null;
}
/**
 * POST the command once, then (optionally) wait for completion and output.
 * The POST is never retried here: once Forge accepts it, the command runs.
 */
async function runSiteCommand(serverId, siteId, command, forgeApiKey, waitForCompletion) {
    const postResponse = await createSiteCommand(serverId, siteId, command, forgeApiKey);
    const commandId = await resolveCreatedCommandId(postResponse, serverId, siteId, command, forgeApiKey);
    const initialStatus = parseSiteCommand(postResponse)?.status;
    if (!commandId) {
        return { submitted: true, commandId: null, status: initialStatus };
    }
    if (!waitForCompletion) {
        return { submitted: true, commandId, status: initialStatus };
    }
    const completed = await waitForCommandCompletion(serverId, siteId, commandId, forgeApiKey);
    if (!completed) {
        return { submitted: true, commandId, timedOut: true };
    }
    return {
        submitted: true,
        commandId,
        status: completed.command.status,
        command: completed.command,
        output: completed.output,
        outputReady: completed.outputReady,
        timedOut: !isTerminalStatus(completed.command.status),
    };
}
const NO_ID_NOTE = 'Forge accepted the command, so it IS running, but its ID could not be read from the response. Do NOT re-run it. Use list_site_commands to find it (newest first).';
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
            const result = await runSiteCommand(serverId, siteId, command, forgeApiKey, waitForCompletion);
            if (!result.commandId) {
                return toMCPToolResult({
                    success: true,
                    message: 'Command submitted',
                    commandId: null,
                    status: result.status ?? null,
                    note: NO_ID_NOTE,
                });
            }
            if (!waitForCompletion) {
                return toMCPToolResult({
                    success: true,
                    message: 'Command execution started',
                    commandId: result.commandId,
                    status: result.status ?? null,
                    note: 'Use get_site_command to check status and retrieve output',
                });
            }
            if (result.timedOut || !result.command) {
                return toMCPToolResult({
                    success: false,
                    message: 'Command execution timed out. The command may still be running.',
                    commandId: result.commandId,
                    status: result.status ?? null,
                    note: 'Use get_site_command to check status and retrieve output. Do not re-run it.',
                });
            }
            const cmd = result.command;
            const succeeded = cmd.status === 'finished' && (cmd.exit_code ?? 0) === 0;
            return toMCPToolResult({
                success: succeeded,
                message: `Command execution ${cmd.status}`,
                commandId: result.commandId,
                status: cmd.status,
                exitCode: cmd.exit_code ?? null,
                duration: cmd.duration ?? null,
                output: result.outputReady ? result.output : '',
                errorOutput: cmd.error_output ?? null,
                ...(result.outputReady
                    ? {}
                    : {
                        outputWarning: 'Command stdout could not be retrieved from Forge in time. The status and exitCode above are authoritative; call get_site_command again shortly to fetch the stdout.',
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
        const result = await runSiteCommand(serverId, siteId, command, forgeApiKey, waitForCompletion);
        if (!result.commandId) {
            return { success: false, status: result.status, error: NO_ID_NOTE };
        }
        if (!waitForCompletion) {
            return {
                success: true,
                commandId: result.commandId,
                status: result.status,
            };
        }
        if (result.timedOut || !result.command) {
            return {
                success: false,
                commandId: result.commandId,
                error: 'Command execution timed out',
            };
        }
        const cmd = result.command;
        return {
            success: cmd.status === 'finished' && (cmd.exit_code ?? 0) === 0,
            commandId: result.commandId,
            status: cmd.status,
            exitCode: cmd.exit_code ?? null,
            output: result.outputReady ? (result.output ?? '') : '',
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
