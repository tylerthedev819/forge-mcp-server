import { HttpMethod } from '../../core/types/protocols.js';
import { callForgeApi } from '../../utils/forgeApi.js';
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
import { installWordPressConfirmationStore } from './confirmInstallWordPressTool.js';
import { validateConfirmation, markConfirmationUsed, } from '../../utils/confirmationStore.js';
const paramsSchema = {
    serverId: z.string().describe('The ID of the server.'),
    serverName: z.string().describe('The name of the server.'),
    siteId: z.string().describe('The ID of the site to install WordPress on.'),
    siteName: z.string().describe('The name/domain of the site.'),
    database: z.string().describe('The name of the database to use for WordPress.'),
    userId: z.number().describe('The database user ID (integer) for WordPress. Get this ID from list_database_users tool.'),
    clearExistingApp: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to automatically clear any existing application before installing WordPress. Defaults to true. This allows WordPress to be installed on sites that already have an app deployed (like the default site page).'),
    confirmationId: z
        .string()
        .describe('This confirmationId must be obtained from confirm_install_wordpress tool after explicit user confirmation. If an invalid or mismatched confirmationId is provided, the operation will be rejected.'),
};
const paramsZodObject = z.object(paramsSchema);
export const installWordPressTool = {
    name: 'install_wordpress',
    parameters: paramsSchema,
    annotations: {
        title: 'Install WordPress',
        description: `Installs WordPress on an existing site in Laravel Forge.\n\nThis tool automatically handles sites that already have an application installed (like the default site page) by calling the uninstall endpoint first when clearExistingApp is true (the default).\n\nIMPORTANT: The userId parameter must be the numeric database user ID (integer) from list_database_users, NOT the username string.\n\nAfter installation, visit the site URL to complete the WordPress setup wizard.\n\nBefore calling this tool, the client MUST call the 'confirm_install_wordpress' tool and present the returned summary to the user for explicit confirmation. Only if the user confirms, the client should proceed to call this tool.`,
        operation: 'create',
        resource: 'wordpress',
        safe: true,
        readOnlyHint: false,
        openWorldHint: true,
        readWriteHint: true,
        destructiveHint: false
    },
    handler: async (params, forgeApiKey) => {
        try {
            const parsed = paramsZodObject.parse(params);
            const { confirmationId, serverId, siteId, database, userId, clearExistingApp } = parsed;
            // Validate confirmation using generic utility
            const confirmation = validateConfirmation(installWordPressConfirmationStore, confirmationId, (stored) => {
                return (stored.serverId === serverId &&
                    stored.siteId === siteId &&
                    stored.database === database &&
                    stored.userId === userId);
            });
            if (!confirmation) {
                return toMCPToolResult(false);
            }
            markConfirmationUsed(installWordPressConfirmationStore, confirmationId);
            // If clearExistingApp is true, first call the uninstall endpoint to clear any existing application
            // This handles the case where the site has the default page deployed or another app
            if (clearExistingApp !== false) {
                try {
                    await callForgeApi({
                        endpoint: `/servers/${String(serverId)}/sites/${String(siteId)}/wordpress`,
                        method: HttpMethod.DELETE,
                    }, forgeApiKey);
                    // Small delay to allow Forge to process the uninstall
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                catch (uninstallError) {
                    // Ignore errors from uninstall - it may fail if there's no WordPress installed
                    // This is expected and we should continue with the installation
                }
            }
            // Call Forge API to install WordPress
            // The Forge API expects { "database": "name", "user": 1 } where "user" is the integer ID
            const payload = {
                database,
                user: userId,
            };
            const data = await callForgeApi({
                endpoint: `/servers/${String(serverId)}/sites/${String(siteId)}/wordpress`,
                method: HttpMethod.POST,
                data: payload,
            }, forgeApiKey);
            return toMCPToolResult({
                success: true,
                message: `WordPress installation initiated on site ${parsed.siteName}. Visit the site URL to complete the WordPress setup wizard.`,
                data,
            });
        }
        catch (err) {
            return toMCPToolError(err);
        }
    },
};
