import { apiTool } from './api.js';
import { bulkTool, commandsTool, wpTool } from './commands.js';
import { backupsTool, databasesTool, logsTool } from './data.js';
import { deploymentsTool } from './deploy.js';
import { destructiveTool } from './destructive.js';
import { jobsTool, processesTool, securityTool, sshKeysTool } from './ops.js';
import { findTool, overviewTool } from './overview.js';
import { optionsTool, phpTool, serversTool } from './servers.js';
import { domainsTool, envTool, sitesTool } from './sites.js';
import { installWordPressTool } from './wordpress.js';
export const TOOLS = [
    overviewTool,
    findTool,
    serversTool,
    sitesTool,
    domainsTool,
    envTool,
    deploymentsTool,
    commandsTool,
    wpTool,
    bulkTool,
    logsTool,
    databasesTool,
    backupsTool,
    jobsTool,
    processesTool,
    sshKeysTool,
    securityTool,
    phpTool,
    installWordPressTool,
    optionsTool,
    apiTool,
    destructiveTool,
];
