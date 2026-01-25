import { HttpMethod } from '../../core/types/protocols.js';
import { callForgeApi } from '../../utils/forgeApi.js';
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js';
import { z } from 'zod';
import { uninstallWordPressConfirmationStore } from './confirmUninstallWordPressTool.js';
import { validateConfirmation, markConfirmationUsed, } from '../../utils/confirmationStore.js';
const paramsSchema = {
    serverId: z.string().describe('The ID of the server.'),
    serverName: z.string().describe('The name of the server.'),
    siteId: z.string().describe('The ID of the site to uninstall WordPress from.'),
    siteName: z.string().describe('The name/domain of the site.'),
    confirmationId: z
        .string()
        .describe('This confirmationId must be obtained from confirm_uninstall_wordpress tool after explicit user confirmation. If an invalid or mismatched confirmationId is provided, the operation will be rejected.'),
};
const paramsZodObject = z.object(paramsSchema);
export const uninstallWordPressTool = {
    name: 'uninstall_wordpress',
    parameters: paramsSchema,
    annotations: {
        title: 'Uninstall WordPress',
        description: `Uninstalls WordPress from a site in Laravel Forge.\n\nThis removes WordPress files from the site. The database will NOT be deleted.\n\nBefore calling this tool, the client MUST call the 'confirm_uninstall_wordpress' tool and present the returned summary to the user for explicit confirmation. Only if the user confirms, the client should proceed to call this tool.`,
        operation: 'delete',
        resource: 'wordpress',
        safe: false,
        readOnlyHint: false,
        openWorldHint: true,
        readWriteHint: true,
        destructiveHint: true
    },
    handler: async (params, forgeApiKey) => {
        try {
            const parsed = paramsZodObject.parse(params);
            const { confirmationId, serverId, siteId, serverName, siteName } = parsed;
            // Validate confirmation using generic utility
            const confirmation = validateConfirmation(uninstallWordPressConfirmationStore, confirmationId, (stored) => {
                return (stored.serverId === serverId &&
                    stored.siteId === siteId);
            });
            if (!confirmation) {
                return toMCPToolResult(false);
            }
            markConfirmationUsed(uninstallWordPressConfirmationStore, confirmationId);
            // Call Forge API to uninstall WordPress
            const data = await callForgeApi({
                endpoint: `/servers/${String(serverId)}/sites/${String(siteId)}/wordpress`,
                method: HttpMethod.DELETE,
            }, forgeApiKey);
            return toMCPToolResult({
                success: true,
                message: `WordPress has been uninstalled from site ${siteName} on server ${serverName}.`,
                data,
            });
        }
        catch (err) {
            return toMCPToolError(err);
        }
    },
};
