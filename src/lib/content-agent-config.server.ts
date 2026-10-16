/** Server-only release switches. Preferences cannot enroll a workspace or grant provider access. */
export type ContentAgentConfiguration = {
  CONTENT_AGENT_PROACTIVE_ENABLED?: string;
  CONTENT_AGENT_PROACTIVE_WORKSPACES?: string;
  CONTENT_AGENT_IMAGES_ENABLED?: string;
  CONTENT_AGENT_IMAGES_WORKSPACES?: string;
  CONTENT_AGENT_REFERENCE_VISION_ENABLED?: string;
  APIMART_API_KEY?: string;
};
const current = () => process.env as ContentAgentConfiguration;
const members = (value?: string) => [
  ...new Set(
    (value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
export function proactiveWorkspaceIds(
  config: ContentAgentConfiguration = current(),
): string[] | null {
  if (config.CONTENT_AGENT_PROACTIVE_ENABLED !== "true") return [];
  if (members(config.CONTENT_AGENT_PROACTIVE_WORKSPACES).includes("*")) return null;
  return members(config.CONTENT_AGENT_PROACTIVE_WORKSPACES).filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
}
export function proactiveDeliveryAvailable(
  userId: string,
  config: ContentAgentConfiguration = current(),
) {
  const cohort = proactiveWorkspaceIds(config);
  return cohort === null ? /^[0-9a-f-]{36}$/i.test(userId) : cohort.includes(userId);
}
export function imageProviderAvailable(
  userId: string,
  config: ContentAgentConfiguration = current(),
) {
  return (
    config.CONTENT_AGENT_IMAGES_ENABLED === "true" &&
    Boolean(config.APIMART_API_KEY?.trim()) &&
    (members(config.CONTENT_AGENT_IMAGES_WORKSPACES).includes(userId) ||
      (members(config.CONTENT_AGENT_IMAGES_WORKSPACES).includes("*") &&
        /^[0-9a-f-]{36}$/i.test(userId)))
  );
}
