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
    user: z.string().describe('The database user for WordPress.'),
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
        description: `Installs WordPress on an existing site in Laravel Forge.\n\nThis calls the Forge WordPress installation endpoint which uses WP-CLI to download and install WordPress. The site must be a PHP site type. After installation, visit the site URL to complete the WordPress setup wizard.\n\nBefore calling this tool, the client MUST call the 'confirm_install_wordpress' tool and present the returned summary to the user for explicit confirmation. Only if the user confirms, the client should proceed to call this tool.`,
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
            const { confirmationId, serverId, siteId, database, user } = parsed;
            // Validate confirmation using generic utility
            const confirmation = validateConfirmation(installWordPressConfirmationStore, confirmationId, (stored) => {
                return (stored.serverId === serverId &&
                    stored.siteId === siteId &&
                    stored.database === database &&
                    stored.user === user);
            });
            if (!confirmation) {
                return toMCPToolResult(false);
            }
            markConfirmationUsed(installWordPressConfirmationStore, confirmationId);
            // Call Forge API to install WordPress
            const payload = {
                database,
                user,
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
