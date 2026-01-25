export function toMCPToolResult(data) {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
}
export function toMCPToolError(error) {
    return {
        content: [
            {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
            },
        ],
        isError: true,
    };
}
