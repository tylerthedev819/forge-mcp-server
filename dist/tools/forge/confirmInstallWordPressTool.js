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
    database: z
        .string()
        .describe('The name of the database to use for WordPress. The client MUST validate this value against the available databases from listDatabasesTool before passing it.'),
    userId: z
        .number()
        .describe('The database user ID (integer) for WordPress. The client MUST get this ID from listDatabaseUsersTool. This is the numeric ID of the user, not the username string.'),
    clearExistingApp: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to automatically clear any existing application (including default site page) before installing WordPress. Defaults to true. When true, calls the uninstall WordPress endpoint first to reset the site state, allowing WordPress to be installed on sites that already have an app deployed.'),
};
export const installWordPressConfirmationStore = createConfirmationStore();
const baseDescription = 'Confirms the WordPress installation parameters and returns a summary for user confirmation.';
export const confirmInstallWordPressTool = {
    name: 'confirm_install_wordpress',
    parameters: paramsSchema,
    annotations: {
        title: 'Confirm WordPress Installation',
        description: `${baseDescription}\n\n${CONFIRMATION_DESCRIPTION}`,
        operation: 'confirm',
        resource: 'wordpress_installation',
        safe: false,
        readOnlyHint: false,
        openWorldHint: true,
        readWriteHint: true,
        destructiveHint: false
    },
    handler: async (params) => {
        const clearExistingApp = params.clearExistingApp ?? true;
        const entry = createConfirmation(installWordPressConfirmationStore, { ...params, clearExistingApp });
        const summary = `Please confirm WordPress installation with the following settings:\n` +
            `Server: ${params.serverName} (ID: ${params.serverId})\n` +
            `Site: ${params.siteName} (ID: ${params.siteId})\n` +
            `Database: ${params.database}\n` +
            `Database User ID: ${params.userId}\n` +
            `Clear Existing App: ${clearExistingApp ? 'Yes (will remove any existing app/default page first)' : 'No'}\n` +
            `Confirmation ID: ${entry.confirmationId}\n` +
            `\nType "yes" to confirm or "no" to cancel.`;
        return toMCPToolResult({ summary, confirmationId: entry.confirmationId });
    },
};
