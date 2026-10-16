// Connection instructions are shared by Settings and the MCP setup page.
// Provider docs checked 2026-10-16. These are user-authorized MCP connections,
// not paid provider APIs or a claim that the client is already connected.
export const AGENT_CLIENT_SETUP = {
  chatgpt: {
    name: "ChatGPT",
    description: "Use your Bento Brain, drafts, and tools from ChatGPT.",
    steps: [
      "In ChatGPT, open Plugins, choose +, then Add custom MCP server. In the older interface, use Settings → Apps → Create.",
      "Name it Bento, paste the MCP URL, and choose OAuth authentication. Sign in to Bento and review the access request.",
      "Create the plugin, review its tools, and add Bento to your conversation. Try the starter prompt below.",
    ],
    availability:
      "Custom MCP access depends on your ChatGPT plan and workspace permissions. If the option is missing, check with your workspace admin.",
    openUrl: "https://chatgpt.com/",
    docsUrl:
      "https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt",
  },
  claude: {
    name: "Claude",
    description: "Bring your Bento workspace into Claude with a custom connector.",
    steps: [
      "Open Customize → Connectors, choose + Add, then Add custom connector. Team members may need their owner to add it first.",
      "Name it Bento and paste the MCP URL. Choose OAuth and Register automatically if asked, then sign in to Bento and approve access.",
      "Enable Bento from the + menu in your conversation. Try the starter prompt below.",
    ],
    availability:
      "Claude Free allows one custom connector. Team and Enterprise connector access is managed by your organization.",
    openUrl: "https://claude.ai/",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  cursor: {
    name: "Cursor",
    description: "Let Cursor work with your Bento Brain, drafts, and publishing tools.",
    steps: [
      "Add the configuration below to ~/.cursor/mcp.json for all projects, or .cursor/mcp.json for this project. Merge it with any existing servers.",
      "Enable Bento in Cursor's MCP tools. Complete the browser sign-in and approve access to your Bento workspace.",
      "Use Bento from Cursor Agent and try the starter prompt below. Review any publishing or deletion action before approving it.",
    ],
    availability:
      "Your team may restrict which MCP servers you can add. Connection settings and disconnection are managed in Cursor.",
    openUrl: "https://cursor.com/docs/mcp",
    docsUrl: "https://cursor.com/docs/mcp",
  },
  grok: {
    name: "Grok",
    description: "Connect Bento to Grok on the web using a custom MCP connector.",
    steps: [
      "Open grok.com/connectors, choose New Connector, then Custom.",
      "Enter the Bento MCP URL. Complete OAuth sign-in with your Bento account and review the requested access.",
      "Use the Bento connector in a Grok conversation and try the starter prompt below.",
    ],
    availability:
      "Business and Enterprise users may need an admin to provision the connector. Grok Bot has a separate plugin and browser workflow.",
    openUrl: "https://grok.com/connectors",
    docsUrl: "https://docs.x.ai/grok/connectors",
  },
} as const;

export type AgentMcpClient = keyof typeof AGENT_CLIENT_SETUP;

export const AGENT_CLIENT_STARTER_PROMPT =
  "Use my Bento Brain to understand my voice and review my latest Agent drafts. Suggest one fresh LinkedIn post and one X post. Save them as drafts for my review. Do not publish or schedule anything.";

export function agentClientConfiguration(client: AgentMcpClient, mcpUrl: string) {
  return client === "cursor"
    ? JSON.stringify({ mcpServers: { bento: { url: mcpUrl } } }, null, 2)
    : mcpUrl;
}
