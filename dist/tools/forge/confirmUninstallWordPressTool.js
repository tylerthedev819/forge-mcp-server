import { toMCPToolResult } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
import { createConfirmationStore, createConfirmation, } from '../../utils/confirmationStore.js';
import { CONFIRMATION_DESCRIPTION } from '../../utils/protocolDescriptions.js';
const paramsSchema = {
    serverId: z
        .string()
        .describe('The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'),
    serverName: z
        .string()
        .describe('The name of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'),
    siteId: z
        .string()
        .describe('The ID of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'),
    siteName: z
        .string()
        .describe('The name/domain of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'),
};
export const uninstallWordPressConfirmationStore = createConfirmationStore();
const baseDescription = 'Confirms WordPress uninstallation and returns a summary for user confirmation. WARNING: This will remove WordPress from the site.';
export const confirmUninstallWordPressTool = {
    name: 'confirm_uninstall_wordpress',
    parameters: paramsSchema,
    annotations: {
        title: 'Confirm WordPress Uninstallation',
        description: `${baseDescription}\n\n${CONFIRMATION_DESCRIPTION}`,
        operation: 'confirm',
        resource: 'wordpress_uninstallation',
        safe: false,
        readOnlyHint: false,
        openWorldHint: true,
        readWriteHint: true,
        destructiveHint: true
    },
    handler: async (params) => {
        const entry = createConfirmation(uninstallWordPressConfirmationStore, params);
        const summary = `⚠️ WARNING: You are about to uninstall WordPress!\n\n` +
            `Please confirm WordPress uninstallation with the following settings:\n` +
            `Server: ${params.serverName} (ID: ${params.serverId})\n` +
            `Site: ${params.siteName} (ID: ${params.siteId})\n` +
            `Confirmation ID: ${entry.confirmationId}\n` +
            `\nThis action will remove WordPress from the site. The database will NOT be deleted.\n` +
            `Type "yes" to confirm or "no" to cancel.`;
        return toMCPToolResult({ summary, confirmationId: entry.confirmationId });
    },
};
