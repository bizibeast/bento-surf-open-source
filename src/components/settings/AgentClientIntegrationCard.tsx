import { useState } from "react";
import { Bot, Copy, ExternalLink, MessageSquareText } from "lucide-react";
import { SiClaude, SiCursor } from "react-icons/si";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AGENT_CLIENT_SETUP,
  AGENT_CLIENT_STARTER_PROMPT,
  agentClientConfiguration,
  type AgentMcpClient,
} from "@/lib/agent-client-setup";
import { micro } from "@/lib/micro-app-ui";

const ICONS = { chatgpt: MessageSquareText, claude: SiClaude, cursor: SiCursor, grok: Bot };

export function AgentClientIntegrationCard({
  client,
  mcpUrl,
}: {
  client: AgentMcpClient;
  mcpUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [grokBot, setGrokBot] = useState(false);
  const setup = AGENT_CLIENT_SETUP[client];
  const Icon = ICONS[client];
  const label = client === "grok" ? "Grok / Grok Bot" : setup.name;
  const isBot = client === "grok" && grokBot;
  const appOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const starterPrompt = isBot
    ? `Open ${appOrigin}/content?tab=agent in your browser. Ask me to take over to sign in to Bento. Then review my Brain and Agent drafts, prepare one new LinkedIn draft and one X draft, and show them to me. Do not publish, schedule, or purchase anything without my approval.`
    : AGENT_CLIENT_STARTER_PROMPT;

  async function copy(value: string, name: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${name} copied`);
    } catch {
      toast.error(`Could not copy ${name.toLowerCase()}. Select and copy the text below.`);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Set up ${label} integration`}
        title={`Use Bento from ${label}`}
        className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
      >
        <span className="flex size-14 items-center justify-center rounded-[18px] bg-white text-[#17213a] shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <span className="mt-2.5 text-xs font-semibold text-[#17213a]">{label}</span>
        <span className="mt-0.5 text-[10px] text-[#17213a]/48">
          {client === "grok" ? "Setup options" : "Set up MCP"}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg rounded-[24px]">
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>Use Bento from {label}</DialogTitle>
            <DialogDescription>
              {isBot
                ? "Let Grok Bot work in your Bento workspace through its browser."
                : setup.description}
            </DialogDescription>
          </DialogHeader>
          {client === "grok" && (
            <div role="group" aria-label="Choose Grok app" className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={!grokBot}
                className={!grokBot ? micro.btnPrimary : micro.btnOutline}
                onClick={() => setGrokBot(false)}
              >
                Grok web
              </button>
              <button
                type="button"
                aria-pressed={grokBot}
                className={grokBot ? micro.btnPrimary : micro.btnOutline}
                onClick={() => setGrokBot(true)}
              >
                Grok Bot
              </button>
            </div>
          )}
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
            {(isBot
              ? [
                  "Ask Grok Bot to open Bento in its browser using the prompt below.",
                  "Take over the browser to sign in yourself, then return control to Grok Bot. Keep passwords and sign-in codes out of chat.",
                  "Review the drafts it prepares in Bento. Grok Bot uses its own approvals for external actions.",
                ]
              : setup.steps
            ).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {!isBot && (
            <div className="min-w-0 rounded-xl border border-border bg-muted/40 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">
                  {client === "cursor" ? "MCP configuration" : "Bento MCP URL"}
                </p>
                <button
                  type="button"
                  title={client === "cursor" ? "Copy MCP configuration" : "Copy MCP URL"}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-muted"
                  onClick={() =>
                    void copy(
                      agentClientConfiguration(client, mcpUrl),
                      client === "cursor" ? "MCP configuration" : "MCP URL",
                    )
                  }
                >
                  <Copy className="size-3.5" /> Copy
                </button>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">
                <code>{agentClientConfiguration(client, mcpUrl)}</code>
              </pre>
            </div>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            {isBot
              ? "Grok Bot's native connectors are installed through Connect apps or Marketplace. A Bento marketplace listing is not currently provided; this setup uses browser access. Team admins can manage approved MCP plugins through their Cursor team marketplace."
              : setup.availability}
          </p>
          <div className="min-w-0 rounded-xl border border-border p-3">
            <p className="text-xs font-semibold">Try this after connecting</p>
            <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
              {starterPrompt}
            </p>
            <button
              type="button"
              title="Copy starter prompt"
              className={`${micro.btnOutline} mt-3`}
              onClick={() => void copy(starterPrompt, "Starter prompt")}
            >
              <Copy className="size-3.5" /> Copy starter prompt
            </button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Finish setup and manage access in {isBot ? "Grok Bot" : setup.name}. Bento does not send
            proactive messages into these apps. Connect Telegram for draft notifications.
          </p>
          <div className="flex flex-wrap gap-2">
            {!isBot && (
              <a
                href={setup.openUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={micro.btnPrimary}
              >
                {client === "cursor" ? "Open Cursor setup guide" : `Open ${setup.name}`}
                <ExternalLink className="size-3.5" />
              </a>
            )}
            <a
              href={isBot ? "https://docs.x.ai/grok-bot/computer-and-apps" : setup.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={micro.btnOutline}
            >
              {isBot ? "Grok Bot connection guide" : "Provider instructions"}
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
