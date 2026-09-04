import { createClientOnlyFn } from "@tanstack/react-start";

export type PublicAnalyticsEvent = {
  kind: "view" | "click";
  user_id: string;
  block_id?: string;
  visitor_hash?: string;
  referrer?: string;
};

export const trackPublicEvent = createClientOnlyFn(async (event: PublicAnalyticsEvent) => {
  const response = await fetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...event, event_id: crypto.randomUUID() }),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Analytics event was rejected (${response.status}).`);
});
