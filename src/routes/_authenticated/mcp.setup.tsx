import { createFileRoute } from "@tanstack/react-router";
import {
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Link2,
  MessageCircleMore,
  MessageSquareText,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Store,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { SiClaude, SiClaudecode, SiCursor } from "react-icons/si";
import { toast } from "sonner";
import { AppHeader } from "@/components/AppHeader";
import { MobileTabSelect } from "@/components/MobileTabSelect";
import { micro } from "@/lib/micro-app-ui";
import { configuredMcpEndpoint } from "@/lib/application-urls";
import bentoSkill from "../../../skills/bento/SKILL.md?raw";

const MCP_URL = configuredMcpEndpoint(import.meta.env.VITE_APP_URL);
const MCP_CONFIG = `{
  "mcpServers": {
    "bento": {
      "url": "${MCP_URL}"
    }
  }
}`;

const SETUP_GLASS =
  "h-36 overflow-hidden rounded-xl border border-white/[0.14] bg-white/[0.075] p-4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_38px_-30px_rgba(0,0,0,0.8)] backdrop-blur-xl";

type UiIcon = LucideIcon | ComponentType<{ className?: string }>;

const CLIENTS = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: MessageSquareText,
    description: "Connect Bento as a custom app from ChatGPT settings.",
    setup: MCP_URL,
    setupLabel: "MCP URL",
    steps: [
      "Open Settings → Apps & Connectors → Advanced settings. Turn on Developer mode, choose Create, and paste the Bento MCP URL.",
      "ChatGPT opens Bento in your browser. Sign in with your existing Bento account.",
      "Review the requested access, choose Allow access, and start asking ChatGPT to work in Bento.",
    ],
  },
  {
    id: "claude",
    name: "Claude",
    icon: SiClaude,
    description: "Use one secure remote connector in Claude web or desktop.",
    setup: MCP_URL,
    setupLabel: "MCP URL",
    steps: [
      "Open Settings → Connectors, choose Add custom connector, name it Bento, and paste the MCP URL.",
      "Claude opens Bento in your browser. Sign in with your existing Bento account.",
      "Approve access, return to Claude, and ask it to create or update anything in your workspace.",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: SiCursor,
    description: "Add Bento to Cursor's MCP tools with the standard JSON config.",
    setup: MCP_CONFIG,
    setupLabel: "Cursor config",
    steps: [
      "Open Cursor Settings → Tools & MCP → New MCP Server, then add the configuration below.",
      "Enable Bento and complete the secure browser sign-in when Cursor opens it.",
      "Approve access, then use Agent mode to work across your Bento workspace.",
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    icon: SiClaudecode,
    description: "Connect from the terminal with one command.",
    setup: `claude mcp add --transport http bento ${MCP_URL}`,
    setupLabel: "Terminal command",
    steps: [
      "Run the command below in your terminal to add Bento as a remote HTTP MCP server.",
      "Follow the browser sign-in and authorization flow using your Bento account.",
      "Run /mcp in Claude Code to confirm Bento is connected, then start asking naturally.",
    ],
  },
  {
    id: "other",
    name: "Other",
    icon: Code2,
    description: "Connect Codex or any client that supports remote Streamable HTTP MCP.",
    setup: MCP_CONFIG,
    setupLabel: "MCP config",
    steps: [
      "Create a remote MCP server in your client's settings and use the configuration below.",
      "Keep OAuth enabled, then sign in to Bento when your client opens the browser.",
      "Approve the requested access and confirm Bento appears in the client's tool list.",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  icon: UiIcon;
  description: string;
  setup: string;
  setupLabel: string;
  steps: readonly [string, string, string];
}>;

const CAPABILITIES = [
  {
    id: "pages",
    title: "Pages & links",
    icon: Link2,
    detail: "Pages, links, media, capture blocks, commerce blocks, and layout.",
    prompt: "Create a new Links page called Media Kit and add my portfolio link to it.",
    events: [
      "List your existing pages",
      "Create the Media Kit page",
      "Add and place the portfolio link",
    ],
  },
  {
    id: "store",
    title: "Store",
    icon: Store,
    detail: "Products, publication, discounts, order bumps, audiences, and campaigns.",
    prompt: "Create a $29 digital product for this PDF and add it to my main page.",
    events: [
      "Check Store and payment readiness",
      "Create the digital product",
      "Add the product block to your page",
    ],
  },
  {
    id: "calendar",
    title: "Calendar",
    icon: CalendarDays,
    detail: "Sessions, availability, connections, reviews, and bookings.",
    prompt: "Create a 30-minute strategy session for Tuesday and Thursday afternoons.",
    events: [
      "Read your Calendar settings",
      "Create the strategy session",
      "Apply your new availability",
    ],
  },
  {
    id: "community",
    title: "Community",
    icon: UsersRound,
    detail: "Members, creator posts, comments, moderation, and settings.",
    prompt: "Draft a welcome post for my community and leave it ready for review.",
    events: [
      "Load the community workspace",
      "Draft the welcome post",
      "Return it for approval before publishing",
    ],
  },
  {
    id: "social",
    title: "Social & Auto-DM",
    icon: MessageCircleMore,
    detail: "Uploads, drafts, scheduling, publishing, and Instagram, Facebook, or X Auto-DMs.",
    prompt: "Post this to Instagram and send the guide to anyone who comments GUIDE.",
    events: [
      "Check the connected Instagram account",
      "Prepare the post and media",
      "Create the GUIDE comment automation",
    ],
  },
  {
    id: "profile",
    title: "Profile & growth",
    icon: UserRound,
    detail: "Branding, analytics, integrations, referrals, commissions, and payouts.",
    prompt: "Show me what grew this week and update my profile bio with this new positioning.",
    events: [
      "Read profile and recent analytics",
      "Summarize the strongest signals",
      "Prepare the bio update for review",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  icon: LucideIcon;
  detail: string;
  prompt: string;
  events: readonly [string, string, string];
}>;

const FAQS = [
  {
    question: "How does Bento connect to an AI agent?",
    answer:
      "Your client connects to Bento's remote MCP endpoint, then opens Bento's secure OAuth flow. The agent receives scoped access only after you sign in and approve it.",
  },
  {
    question: "Which agents are supported?",
    answer:
      "ChatGPT, Claude, Cursor, Claude Code, Codex, and any client that supports remote Streamable HTTP MCP and OAuth can connect.",
  },
  {
    question: "Do I need an API key?",
    answer:
      "No. Use your normal Bento account. OAuth handles authentication, so you never copy your password or a Bento API key into the agent.",
  },
  {
    question: "What can my agent change?",
    answer:
      "It can work across pages, Store, Calendar, Community, profile, analytics, referrals, social publishing, and Auto-DMs while respecting your plan and workspace permissions.",
  },
  {
    question: "Can an agent publish or delete without asking?",
    answer:
      "Bento marks destructive and externally visible actions for confirmation. Good MCP clients ask before publishing, sending campaigns, deleting records, or requesting payouts.",
  },
  {
    question: "How do I disconnect Bento?",
    answer:
      "Remove or disable the Bento connector in your AI client's MCP settings. You can reconnect later through the same secure sign-in flow.",
  },
] as const;

export const Route = createFileRoute("/_authenticated/mcp/setup")({
  head: () => ({ meta: [{ title: "MCP | bento.surf" }] }),
  component: McpSetupPage,
});

export function McpSetupPage() {
  const [activeClientId, setActiveClientId] = useState<(typeof CLIENTS)[number]["id"]>("chatgpt");
  const [activeCapabilityId, setActiveCapabilityId] =
    useState<(typeof CAPABILITIES)[number]["id"]>("pages");
  const activeClient = CLIENTS.find((client) => client.id === activeClientId) ?? CLIENTS[0];
  const activeCapability =
    CAPABILITIES.find((capability) => capability.id === activeCapabilityId) ?? CAPABILITIES[0];

  return (
    <main className={micro.shell}>
      <AppHeader title="MCP" />

      <div className={`${micro.main} pb-10 pt-7 sm:pb-14 sm:pt-10`}>
        <section aria-labelledby="mcp-hero-heading" className="mx-auto max-w-5xl pt-8 sm:pt-0">
          <h2
            id="mcp-hero-heading"
            className="max-w-4xl font-ui-display text-4xl leading-[0.98] tracking-[-0.035em] text-[#17213a] sm:text-6xl lg:text-7xl"
          >
            Your Bento. In any AI agent.
          </h2>
          <p className="mt-5 max-w-3xl text-base leading-7 text-[#17213a]/58 sm:text-lg sm:leading-8">
            Connect ChatGPT, Claude, Cursor, Claude Code, Codex, or another MCP client. Your agent
            can safely work across your pages, Store, Calendar, Community, social posts, and
            Auto-DMs, with your permission.
          </p>

          <div className="mt-7 flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3 shadow-sm">
              <Link2 className="size-4 shrink-0 text-[#3478f6]" aria-hidden="true" />
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-[#17213a]/72 sm:text-sm">
                {MCP_URL}
              </code>
            </div>
            <CopyButton value={MCP_URL} label="Copy MCP URL" primary />
          </div>
        </section>

        <section aria-label="Connect your AI agent" className="mx-auto mt-9 max-w-6xl sm:mt-11">
          <MobileTabSelect
            value={activeClientId}
            options={CLIENTS.map((client) => ({ value: client.id, label: client.name }))}
            onChange={setActiveClientId}
            ariaLabel="Choose AI client"
            variant="product"
            className="mb-2"
          />
          <div
            role="tablist"
            aria-label="AI client"
            className="hidden overflow-x-auto overflow-y-hidden rounded-t-2xl border border-b-0 border-black/[0.08] bg-white/80 px-[3px] pt-[3px] backdrop-blur-xl sm:flex"
          >
            {CLIENTS.map((client) => (
              <ClientTab
                key={client.id}
                client={client}
                selected={client.id === activeClient.id}
                onSelect={() => setActiveClientId(client.id)}
              />
            ))}
          </div>

          <div
            role="tabpanel"
            aria-label={`${activeClient.name} setup`}
            className="overflow-hidden rounded-2xl bg-[#17213a] text-white shadow-[0_36px_80px_-46px_rgba(23,33,58,0.95)] sm:rounded-t-none"
          >
            <div className="border-b border-white/10 px-5 py-4 sm:px-7">
              <p className="text-sm text-white/55">{activeClient.description}</p>
            </div>
            <div className="grid lg:grid-cols-3">
              <SetupStep
                number="1"
                title="Add Bento"
                detail={activeClient.steps[0]}
                className="border-b border-white/10 lg:border-b-0 lg:border-r"
              >
                <div data-testid="setup-glass" className={SETUP_GLASS}>
                  <div className="mb-2 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
                    <span>{activeClient.setupLabel}</span>
                    <CopyButton
                      value={activeClient.setup}
                      label={`Copy ${activeClient.setupLabel}`}
                      dark
                      compact
                    />
                  </div>
                  <pre className="max-h-[5.25rem] overflow-auto overscroll-contain whitespace-pre-wrap break-all pr-1 text-[11px] leading-5 text-white/72">
                    <code>{activeClient.setup}</code>
                  </pre>
                </div>
              </SetupStep>

              <SetupStep
                number="2"
                title="Sign in"
                detail={activeClient.steps[1]}
                className="border-b border-white/10 lg:border-b-0 lg:border-r"
              >
                <div data-testid="setup-glass" className={SETUP_GLASS}>
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/10 text-[#7aa7ff]">
                      <Bot className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-white">Bento authorization</p>
                      <p className="mt-0.5 text-[10px] text-white/45">
                        Opens securely in your browser
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.065] px-3 py-2 text-[11px] text-white/65">
                    <ShieldCheck className="size-3.5 text-[#7aa7ff]" aria-hidden="true" />
                    Sign in with your Bento account
                  </div>
                </div>
              </SetupStep>

              <SetupStep number="3" title="Approve" detail={activeClient.steps[2]}>
                <div data-testid="setup-glass" className={`${SETUP_GLASS} space-y-2`}>
                  {[
                    "Read your workspace",
                    "Create and update content",
                    "Publish only when you ask",
                  ].map((permission) => (
                    <div
                      key={permission}
                      className="flex items-center gap-2 text-[11px] text-white/72"
                    >
                      <CheckCircle2 className="size-3.5 text-[#7ce0b2]" aria-hidden="true" />
                      {permission}
                    </div>
                  ))}
                </div>
              </SetupStep>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="capabilities-heading"
          className="mx-auto mt-16 max-w-6xl sm:mt-20"
        >
          <SectionHeading
            id="capabilities-heading"
            title="See what your agent can do"
            description="Ask naturally. Bento gives your agent the right context, IDs, validation, and safety checks for the task."
          />

          <div className={`${micro.panel} mt-6 grid lg:grid-cols-[17rem_minmax(0,1fr)]`}>
            <MobileTabSelect
              value={activeCapabilityId}
              options={CAPABILITIES.map((capability) => ({
                value: capability.id,
                label: capability.title,
              }))}
              onChange={setActiveCapabilityId}
              ariaLabel="Choose Bento capability"
              variant="product"
              className="m-3"
            />
            <div
              role="tablist"
              aria-label="Bento capabilities"
              className="hidden gap-2 overflow-x-auto border-b border-black/[0.07] p-3 sm:flex lg:block lg:space-y-1 lg:border-b-0 lg:border-r lg:p-4"
            >
              {CAPABILITIES.map((capability) => (
                <CapabilityTab
                  key={capability.id}
                  capability={capability}
                  selected={capability.id === activeCapability.id}
                  onSelect={() => setActiveCapabilityId(capability.id)}
                />
              ))}
            </div>

            <div role="tabpanel" aria-label={activeCapability.title} className="min-w-0 p-5 sm:p-7">
              <div className="flex items-center gap-3">
                <span className={`${micro.iconWellLavender} size-10 shrink-0`}>
                  <Sparkles className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-semibold text-[#17213a]">Example request</p>
                  <p className="text-[11px] text-[#17213a]/45">Say it in your own words</p>
                </div>
              </div>
              <blockquote className="mt-4 rounded-xl bg-[#eef5ff] px-4 py-3 text-sm leading-6 text-[#17213a]/78 sm:text-base">
                “{activeCapability.prompt}”
              </blockquote>

              <div className="mt-7">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/38">
                  Bento agent workflow
                </p>
                <ol className="mt-3 divide-y divide-black/[0.06] border-y border-black/[0.06]">
                  {activeCapability.events.map((event, index) => (
                    <li key={event} className="flex items-center gap-3 py-3.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f2f5fb] text-xs font-semibold text-[#3478f6]">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium text-[#17213a]">
                        {event}
                      </span>
                      <Check className="size-4 shrink-0 text-[#22a06b]" aria-hidden="true" />
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="skill-heading"
          className="mx-auto mt-6 max-w-6xl overflow-hidden rounded-2xl border border-[#6d5bd0]/15 bg-[#f1edff]"
        >
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-7">
            <div className="flex items-start gap-3">
              <span className={`${micro.iconWellLavender} size-11 shrink-0`}>
                <PlugZap className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2
                  id="skill-heading"
                  className="font-ui-display text-2xl text-[#17213a] sm:text-3xl"
                >
                  Give your agent the Bento skill
                </h2>
                <p className={`mt-1 max-w-3xl ${micro.muted}`}>
                  Compatible agents load it automatically from Bento MCP. If yours does not support
                  MCP skills yet, copy these instructions into its project or custom instructions.
                </p>
              </div>
            </div>
            <CopyButton value={bentoSkill} label="Copy skill" />
          </div>
          <details className="group border-t border-[#6d5bd0]/12 bg-white/55">
            <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-[#17213a] sm:px-7">
              <span className="flex items-center justify-between gap-3">
                View complete Bento skill
                <span className="text-[#17213a]/35 transition-transform group-open:rotate-45">
                  +
                </span>
              </span>
            </summary>
            <pre className="max-h-[32rem] overflow-auto border-t border-[#6d5bd0]/12 bg-white/65 p-5 text-xs leading-5 text-[#17213a]/70 sm:px-7">
              <code>{bentoSkill}</code>
            </pre>
          </details>
        </section>

        <section aria-labelledby="faq-heading" className="mx-auto mt-16 max-w-4xl sm:mt-20">
          <SectionHeading
            id="faq-heading"
            title="Common questions"
            description="Everything you need to know before connecting an agent to Bento."
            centered
          />
          <div className="mt-7 divide-y divide-black/[0.08] border-y border-black/[0.08]">
            {FAQS.map((faq, index) => (
              <details key={faq.question} className="group" open={index === 0 ? true : undefined}>
                <summary className="cursor-pointer list-none py-4 text-sm font-semibold text-[#17213a] sm:text-base">
                  <span className="flex items-center justify-between gap-4">
                    {faq.question}
                    <span className="text-lg font-normal text-[#17213a]/35 transition-transform group-open:rotate-45">
                      +
                    </span>
                  </span>
                </summary>
                <p className="max-w-3xl pb-5 pr-8 text-sm leading-6 text-[#17213a]/55">
                  {faq.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto mt-10 flex max-w-6xl items-start gap-3 rounded-2xl border border-[#3478f6]/18 bg-[#dfeaff] p-4 text-[#17213a] sm:p-5">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#3478f6]" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">You stay in control</h2>
            <p className="mt-1 text-xs leading-5 text-[#17213a]/60 sm:text-sm">
              Bento only grants access to the account you approve. Agents are asked to confirm
              destructive actions and externally visible actions such as publishing, sending
              campaigns, or requesting payouts.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function ClientTab({
  client,
  selected,
  onSelect,
}: {
  client: (typeof CLIENTS)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = client.icon;
  return (
    <button
      type="button"
      role="tab"
      data-mcp-client-tab
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-w-[8.5rem] flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold outline-none transition first:!rounded-tl-[24px] last:!rounded-tr-[24px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3478f6]/40 sm:text-sm ${
        selected
          ? "border-[#3478f6] bg-transparent text-[#3478f6]"
          : "border-transparent text-[#17213a]/52 hover:bg-[#f7f8fc]/80 hover:text-[#17213a]"
      }`}
    >
      <Icon className="size-4 shrink-0" />
      {client.name}
    </button>
  );
}

function SetupStep({
  number,
  title,
  detail,
  className = "",
  children,
}: {
  number: string;
  title: string;
  detail: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={`flex min-w-0 flex-col p-5 sm:p-7 ${className}`}>
      <span className="flex size-7 items-center justify-center rounded-full border border-[#3478f6] text-xs font-semibold text-[#7aa7ff]">
        {number}
      </span>
      <h3 className="mt-4 font-ui-display text-2xl">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-white/52 sm:text-sm sm:leading-6">{detail}</p>
      <div data-testid="setup-step-content" className="mt-auto pt-7">
        {children}
      </div>
    </article>
  );
}

function CapabilityTab({
  capability,
  selected,
  onSelect,
}: {
  capability: (typeof CAPABILITIES)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = capability.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-w-[13rem] items-start gap-3 rounded-xl p-3 text-left transition lg:w-full lg:min-w-0 ${
        selected ? "bg-[#eef5ff] text-[#17213a]" : "text-[#17213a]/55 hover:bg-[#f7f8fc]"
      }`}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
          selected ? "bg-[#dceaff] text-[#3478f6]" : "bg-[#f2f5fb] text-[#17213a]/42"
        }`}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-sm font-semibold">{capability.title}</span>
        <span className="mt-0.5 hidden text-[11px] leading-4 text-[#17213a]/45 lg:block">
          {capability.detail}
        </span>
      </span>
    </button>
  );
}

function SectionHeading({
  id,
  title,
  description,
  centered = false,
}: {
  id: string;
  title: string;
  description: string;
  centered?: boolean;
}) {
  return (
    <div className={centered ? "text-center" : undefined}>
      <h2
        id={id}
        className="font-ui-display text-3xl tracking-[-0.02em] text-[#17213a] sm:text-4xl"
      >
        {title}
      </h2>
      <p className={`mt-2 ${centered ? "mx-auto" : ""} max-w-3xl ${micro.muted}`}>{description}</p>
    </div>
  );
}

function CopyButton({
  value,
  label,
  dark = false,
  primary = false,
  compact = false,
}: {
  value: string;
  label: string;
  dark?: boolean;
  primary?: boolean;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy to clipboard");
        }
      }}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-xs font-semibold transition hover:-translate-y-0.5 ${
        compact ? "size-8" : "h-11 px-4"
      } ${
        primary
          ? "bg-[#3478f6] text-white shadow-[0_14px_30px_-18px_rgba(52,120,246,0.95)] hover:bg-[#2168e5]"
          : dark
            ? "bg-white/10 text-white hover:bg-white/15"
            : "bg-[#17213a] text-white hover:bg-[#263252]"
      }`}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {!compact && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
