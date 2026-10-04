import { captureServerEvent } from "./posthog.server";

export type ContentWorkspaceEvent =
  | "content_brain_confirmed"
  | "content_recommendation_feedback"
  | "content_agent_turn"
  | "content_draft_approved"
  | "content_draft_rejected"
  | "content_routine_run"
  | "content_drafts_ready_email";

function text(value: unknown, max = 100) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function count(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function safeProperties(event: ContentWorkspaceEvent, properties: Record<string, unknown>) {
  switch (event) {
    case "content_brain_confirmed":
      return { kind: text(properties.kind) };
    case "content_recommendation_feedback":
      return { kind: text(properties.kind), feedback: text(properties.feedback) };
    case "content_agent_turn":
      return { action: text(properties.action), card_count: count(properties.cardCount) };
    case "content_draft_approved":
      return {
        platform: text(properties.platform),
        format: text(properties.format),
        source_count: count(properties.sourceCount),
      };
    case "content_draft_rejected":
      return { platform: text(properties.platform), reason_length: count(properties.reasonLength) };
    case "content_routine_run":
      return {
        template: text(properties.template),
        status: text(properties.status),
        result_count: count(properties.resultCount),
      };
    case "content_drafts_ready_email":
      return {
        draft_count: count(properties.draftCount),
        platform_count: count(properties.platformCount),
      };
  }
}

export function recordContentEvent(
  userId: string,
  event: ContentWorkspaceEvent,
  properties: Record<string, unknown>,
) {
  return captureServerEvent(
    userId,
    event,
    safeProperties(event, properties),
    globalThis.__env__ ?? {},
  );
}
