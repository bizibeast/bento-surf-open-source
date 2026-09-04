import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { SiFacebook, SiInstagram, SiX } from "react-icons/si";
import { BookingAccountsConnect, type BookingConnectAccount } from "./BookingAccountsConnect";
import { SocialAccountsConnect, type SocialConnectAccount } from "./SocialAccountsConnect";
import { getIntegrationOverview } from "@/lib/integrations.functions";
import { micro } from "@/lib/micro-app-ui";
import {
  PUBLIC_SOCIAL_PROVIDERS,
  SOCIAL_PROVIDER_DEFINITIONS,
  type SocialProvider,
} from "@/lib/social-scheduler";

type IntegrationTarget = "social" | "bookings" | "automation" | "payments";

const INTEGRATION_TARGET_IDS: Record<IntegrationTarget, string> = {
  social: "integration-social",
  bookings: "integration-bookings",
  automation: "integration-automation",
  payments: "integration-payments",
};

const AUTOMATIONS = [
  {
    provider: "instagram" as const,
    label: "Instagram DMs",
    to: "/auto-dms/instagram" as const,
    icon: SiInstagram,
    color: "#E4405F",
  },
  {
    provider: "facebook" as const,
    label: "Facebook DMs",
    to: "/auto-dms/facebook" as const,
    icon: SiFacebook,
    color: "#1877F2",
  },
  {
    provider: "twitter" as const,
    label: "X DMs",
    to: "/auto-dms/twitter" as const,
    icon: SiX,
    color: "#111111",
  },
];

type SocialConnection = {
  id: string;
  provider: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  canPublish?: boolean;
  canAutomate?: boolean;
  scopes?: string[];
};

export function IntegrationsOverview({
  target,
  query = "",
}: {
  target?: IntegrationTarget;
  query?: string;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["integration-overview"],
    queryFn: () => getIntegrationOverview(),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!target) return;
    document
      .getElementById(INTEGRATION_TARGET_IDS[target])
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [target]);

  const socialConnections = (data?.socialConnections || []) as SocialConnection[];
  const activeSocialConnections: SocialConnectAccount[] = socialConnections
    .filter((connection) => connection.status === "active")
    .map((connection) => ({
      id: connection.id,
      provider: connection.provider as SocialProvider,
      displayName: connection.displayName,
      avatarUrl: connection.avatarUrl,
      canPublish: connection.canPublish !== false,
      canAutomate: connection.canAutomate !== false,
      scopes: connection.scopes || [],
    }));
  const calendarConnections = (data?.calendarConnections || []) as BookingConnectAccount[];
  const fathomConnections = (data?.fathomConnections || []) as BookingConnectAccount[];
  const readiness = (data?.readiness || {}) as Partial<Record<SocialProvider, boolean>>;
  const bookingReadiness = (data?.bookingReadiness || {}) as {
    google?: boolean;
    fathom?: boolean;
  };
  const refreshOverview = () =>
    void queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (...values: string[]) =>
    !normalizedQuery || values.some((value) => value.toLowerCase().includes(normalizedQuery));
  const showSocial = PUBLIC_SOCIAL_PROVIDERS.some((provider) =>
    matches(provider, SOCIAL_PROVIDER_DEFINITIONS[provider].name),
  );
  const showMeetings = matches("meetings", "google calendar", "google meet", "fathom");
  const shownAutomations = AUTOMATIONS.filter((automation) =>
    matches("automations", automation.label),
  );

  return (
    <div>
      {showSocial && (
        <IntegrationPanel id="integration-social" title="Social">
          {isLoading ? (
            <TileSkeleton count={8} />
          ) : (
            <SocialAccountsConnect
              connections={activeSocialConnections}
              readiness={readiness}
              onChanged={refreshOverview}
              query={query}
            />
          )}
        </IntegrationPanel>
      )}

      {showMeetings && (
        <IntegrationPanel id="integration-bookings" title="Meetings">
          {isLoading ? (
            <TileSkeleton count={2} />
          ) : (
            <BookingAccountsConnect
              calendarConnections={calendarConnections}
              fathomConnections={fathomConnections}
              googleReady={Boolean(bookingReadiness.google)}
              fathomReady={Boolean(bookingReadiness.fathom)}
              onChanged={refreshOverview}
              query={query}
            />
          )}
        </IntegrationPanel>
      )}

      {shownAutomations.length > 0 && (
        <IntegrationPanel id="integration-automation" title="Automations">
          <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 lg:grid-cols-8">
            {shownAutomations.map((automation) => {
              const Icon = automation.icon;
              const connected = activeSocialConnections.some(
                (connection) =>
                  connection.provider === automation.provider && connection.canAutomate !== false,
              );
              return (
                <Link
                  key={automation.provider}
                  to={automation.to}
                  className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
                >
                  <span
                    className="relative flex size-14 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md"
                    style={{ color: automation.color }}
                  >
                    <Icon className="size-6" />
                    {connected && (
                      <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className="mt-2.5 max-w-full truncate text-xs font-semibold text-[#17213a]">
                    {automation.label}
                  </span>
                  <span className="mt-0.5 text-[10px] text-[#17213a]/48">
                    {connected ? "Active" : "Set up"}
                  </span>
                </Link>
              );
            })}
          </div>
        </IntegrationPanel>
      )}

      {!showSocial && !showMeetings && !shownAutomations.length && (
        <div className="border-b border-black/[0.08] py-12 text-center">
          <p className="text-sm font-semibold text-[#17213a]">No integrations found</p>
          <p className="mt-1 text-xs text-[#17213a]/48">Try another app or platform name.</p>
        </div>
      )}
    </div>
  );
}

function TileSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 lg:grid-cols-8">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex min-h-28 flex-col items-center py-2">
          <span className="size-14 animate-pulse rounded-[18px] bg-[#eef1f7]" />
          <span className="mt-3 h-3 w-14 animate-pulse rounded-[4px] bg-[#eef1f7]" />
        </div>
      ))}
    </div>
  );
}

export function IntegrationPanel({
  id,
  icon: _icon,
  title,
  description,
  meta,
  children,
}: {
  id: string;
  icon?: ReactNode;
  title: string;
  description?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-integration-panel
      className="scroll-mt-24 border-b border-black/[0.08] px-1 py-7 sm:py-8"
    >
      <div className="mb-5 flex items-start justify-between gap-4 px-1">
        <div>
          <h3 className="text-base font-semibold text-[#17213a]">{title}</h3>
          {description && (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-[#17213a]/48">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">{meta}</div>
      </div>
      {children}
    </section>
  );
}

export function IntegrationProviderCard({
  icon,
  iconColor,
  name,
  status,
  connected,
  description,
  statusLabel,
  statusTone,
  children,
}: {
  icon: ReactNode;
  iconColor?: string;
  name: string;
  status: string;
  connected: boolean;
  description?: string;
  statusLabel?: string;
  statusTone?: "connected" | "active" | "warning" | "muted";
  children?: ReactNode;
}) {
  const tone = statusTone || (connected ? "connected" : "muted");
  const toneClass = {
    connected: "bg-[#e7f7ee] text-[#197a4d]",
    active: "bg-[#dfeaff] text-[#2168e5]",
    warning: "bg-[#fff1d6] text-[#b7790b]",
    muted: "bg-[#f2f5fb] text-[#17213a]/55",
  }[tone];
  return (
    <div
      data-integration-card
      className="flex min-w-0 flex-col rounded-[18px] border border-black/[0.06] bg-white p-4 shadow-sm transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/[0.05]"
          style={{ color: iconColor }}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-[#17213a]">
            {name}
          </div>
        </div>
      </div>
      <p className={`mt-3 line-clamp-2 min-h-5 ${micro.mutedXs}`}>{status}</p>
      <span className={`mt-2.5 self-start rounded-lg px-2.5 py-1 font-semibold ${toneClass}`}>
        {statusLabel || (connected ? "Connected" : "Not connected")}
      </span>
      {description && <p className={`mt-4 ${micro.mutedXs}`}>{description}</p>}
      {children}
    </div>
  );
}
