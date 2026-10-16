import { captureServerEvent } from "./posthog.server";

export type ContentWorkspaceEvent =
  | "content_agent_delivery"
  | "content_agent_dismissal"
  | "content_agent_image"
  | "content_agent_image_quota"
  | "content_agent_draft_review"
  | "content_agent_novelty_rejection"
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
  const number = typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function choice(value: unknown, allowed: readonly string[]) {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}
function safeProperties(event: ContentWorkspaceEvent, properties: Record<string, unknown>) {
  switch (event) {
    case "content_agent_delivery":
      return {
        status: choice(properties.status, ["delivered", "skipped", "failed"]),
        count: count(properties.count),
      };
    case "content_agent_dismissal":
      return {
        action: choice(properties.action, ["useful", "not_relevant", "less_like_this"]),
        count: count(properties.count),
      };
    case "content_agent_image":
      return {
        status: choice(properties.status, [
          "submitted",
          "ambiguous",
          "failed",
          "ready",
          "storage_pending",
        ]),
        count: count(properties.count),
      };
    case "content_agent_image_quota":
      return { successful: count(properties.successful), pending: count(properties.pending) };
    case "content_agent_draft_review":
      return {
        status: choice(properties.status, [
          "ready",
          "needs_input",
          "retry",
          "approved",
          "edited",
          "rejected",
          "handoff",
        ]),
        count: count(properties.count),
      };
    case "content_agent_novelty_rejection":
      return {
        issue: choice(properties.issue, ["repeated_argument", "novelty"]),
        count: count(properties.count),
      };
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
