import { z } from "zod";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

type AutoDmPlatform = "instagram" | "facebook" | "twitter";
type AutoDmDashboard = {
  connections?: readonly unknown[];
  activity?: readonly unknown[];
  workflows?: readonly unknown[];
  [key: string]: unknown;
};

type AutoDmWebMcpOptions<TDashboard extends AutoDmDashboard> = {
  platform: AutoDmPlatform;
  loadDashboard: () => Promise<TDashboard>;
  getMedia?: (connectionId: string) => Promise<readonly unknown[]>;
  preflight: (automationId: string) => Promise<{ dashboard: TDashboard; checks?: unknown }>;
  repairConnection: (connectionId: string) => Promise<TDashboard>;
  onDashboard: (dashboard: TDashboard) => void;
};

const idInput = (key: "automationId" | "connectionId") =>
  z
    .object({ [key]: z.string().uuid() })
    .strict()
    .transform((input) => input as Record<typeof key, string>);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, maxLength = 280) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function strings(value: unknown, maxItems = 20) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, maxItems)
    : [];
}

function rows(value: unknown, maxItems = 50) {
  return Array.isArray(value) ? value.slice(0, maxItems).map(record) : [];
}

export function autoDmWebMcpSummary(platform: AutoDmPlatform, value: unknown) {
  const dashboard = record(value);
  return {
    platform,
    locked: dashboard.locked === true,
    plan: text(dashboard.plan, 40),
    configured: dashboard.configured === true,
    generalCustomerAccess:
      typeof dashboard.generalCustomerAccess === "boolean" ? dashboard.generalCustomerAccess : null,
    connections: rows(dashboard.connections, 20).map((connection) => ({
      id: text(connection.id, 80),
      handle: text(connection.handle, 100),
      displayName: text(connection.displayName, 120),
      status: text(connection.status, 40),
      health: text(connection.health, 40),
      ready: connection.ready === true,
      needsReconnect: connection.needsReconnect === true,
      readinessIssues: strings(connection.readinessIssues),
      readinessMessage: text(connection.readinessMessage),
      lastVerifiedAt: text(connection.lastVerifiedAt, 40),
      lastHealthCheckAt: text(connection.lastHealthCheckAt, 40),
    })),
    activity: rows(dashboard.activity).map((event) => ({
      id: text(event.id, 80),
      automationName: text(event.automationName, 80),
      eventType: text(event.eventType, 40),
      status: text(event.status, 40),
      createdAt: text(event.createdAt, 40),
    })),
    workflows: rows(dashboard.workflows).map((workflow) => ({
      id: text(workflow.id, 80),
      automationName: text(workflow.automationName, 80),
      status: text(workflow.status, 40),
      emailCaptured: workflow.emailCaptured === true,
      marketingConsent: workflow.marketingConsent === true,
      createdAt: text(workflow.createdAt, 40),
      completedAt: text(workflow.completedAt, 40),
    })),
  };
}

export function autoDmWebMcpMedia(value: unknown) {
  return rows(value).map((media) => ({
    id: text(media.id, 255),
    caption: text(media.caption),
    mediaType: text(media.mediaType, 40),
    timestamp: text(media.timestamp, 40),
  }));
}

function safePreflightChecks(value: unknown) {
  const checks = record(value);
  return {
    officialMetaSubscription:
      typeof checks.officialMetaSubscription === "boolean" ? checks.officialMetaSubscription : null,
    officialApiAccess:
      typeof checks.officialApiAccess === "boolean" ? checks.officialApiAccess : null,
    requiredPermissions:
      typeof checks.requiredPermissions === "boolean" ? checks.requiredPermissions : null,
    connectionHealthy:
      typeof checks.connectionHealthy === "boolean" ? checks.connectionHealthy : null,
    workflowValid: typeof checks.workflowValid === "boolean" ? checks.workflowValid : null,
    verifiedAt: text(checks.verifiedAt, 40),
  };
}

export function createAutoDmWebMcpTools<TDashboard extends AutoDmDashboard>({
  platform,
  loadDashboard,
  getMedia,
  preflight,
  repairConnection,
  onDashboard,
}: AutoDmWebMcpOptions<TDashboard>): WebMcpTool[] {
  const label = platform === "twitter" ? "X" : `${platform[0].toUpperCase()}${platform.slice(1)}`;
  const id = { type: "string", format: "uuid" };
  const tools: WebMcpTool[] = [
    {
      name: "bento_get_auto_dm_activity",
      title: `Get ${label} Auto-DM activity`,
      description:
        `Loads current ${label} connection readiness and bounded delivery/workflow status. ` +
        "Customer identities, captured addresses, provider errors, and credentials are excluded.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        z.object({}).strict().parse(input);
        signal.throwIfAborted();
        const dashboard = await loadDashboard();
        signal.throwIfAborted();
        onDashboard(dashboard);
        return webMcpResult(`Loaded safe ${label} Auto-DM activity.`, {
          workspace: autoDmWebMcpSummary(platform, dashboard),
        });
      },
    },
    {
      name: "bento_run_auto_dm_preflight",
      title: `Run ${label} Auto-DM preflight`,
      description:
        `Runs the existing official-provider readiness check for one owned ${label} automation ` +
        "after browser approval.",
      inputSchema: {
        type: "object",
        properties: { automationId: id },
        required: ["automationId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        const { automationId } = idInput("automationId").parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation(`Run ${label} Auto-DM preflight`, { automationId });
        signal.throwIfAborted();
        const result = await preflight(automationId);
        signal.throwIfAborted();
        onDashboard(result.dashboard);
        return webMcpResult(`${label} Auto-DM preflight passed.`, {
          automationId,
          checks: safePreflightChecks(result.checks),
        });
      },
    },
    {
      name: "bento_repair_auto_dm_connection",
      title: `Repair ${label} Auto-DM connection`,
      description:
        `Rechecks the official ${label} connection and restores its required delivery subscription ` +
        "after browser approval.",
      inputSchema: {
        type: "object",
        properties: { connectionId: id },
        required: ["connectionId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        const { connectionId } = idInput("connectionId").parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation(`Repair ${label} Auto-DM connection`, { connectionId });
        signal.throwIfAborted();
        const dashboard = await repairConnection(connectionId);
        signal.throwIfAborted();
        onDashboard(dashboard);
        return webMcpResult(`Rechecked the ${label} Auto-DM connection.`, {
          connectionId,
          workspace: autoDmWebMcpSummary(platform, dashboard),
        });
      },
    },
  ];

  if (getMedia) {
    tools.splice(1, 0, {
      name: "bento_get_auto_dm_media",
      title: `Get ${label} Auto-DM media`,
      description:
        `Lists bounded ${label} media identifiers and captions for an owned connection. ` +
        "Storage URLs, provider permalinks, credentials, and private keys are excluded.",
      inputSchema: {
        type: "object",
        properties: { connectionId: id },
        required: ["connectionId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        const { connectionId } = idInput("connectionId").parse(input);
        signal.throwIfAborted();
        const media = await getMedia(connectionId);
        signal.throwIfAborted();
        return webMcpResult(`Loaded safe ${label} media choices.`, {
          connectionId,
          media: autoDmWebMcpMedia(media),
        });
      },
    });
  }

  return tools;
}
