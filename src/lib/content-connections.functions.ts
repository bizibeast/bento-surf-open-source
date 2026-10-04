import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireContentWorkspace } from "./content-access.server";
import { enforceRequestRateLimit } from "./request-security.server";
import {
  deleteContentConnectionDataForUser,
  disconnectContentConnectionForUser,
  loadContentConnectionForUser,
  syncContentConnectionWithAdapter,
  updateContentResourceSelectionWithAdapter,
} from "./content-connections.server";
import { createContentOAuthState } from "./content-connections.server";
import { completeNotionConnectionForUser, notionAuthorizationUrl } from "./notion-content.server";
import {
  beginGranolaConnectionForUser,
  completeGranolaConnectionForUser,
} from "./granola-content.server";
import { completeGitHubConnectionForUser, githubAppInstallationUrl } from "./github-content.server";
import { completeSlackConnectionForUser, slackAuthorizationUrl } from "./slack-content.server";
import { contentProviderSchema } from "./content-connections";
import { getContentProviderAdapter } from "./content-provider-adapters.server";

export const contentConnectionIdSchema = z.object({ id: z.string().uuid() });
export const contentResourceSelectionSchema = contentConnectionIdSchema.extend({
  resourceIds: z
    .array(z.string().trim().min(1).max(500))
    .max(100)
    .transform((ids) => [...new Set(ids)]),
});
export const contentDataDeletionSchema = contentConnectionIdSchema.extend({
  includeConfirmedBrain: z.boolean().default(false),
});
const contentProviderInputSchema = z.object({ provider: contentProviderSchema });

export const disconnectContentKnowledgeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentConnectionIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return disconnectContentConnectionForUser(context.userId, data.id);
  });

export const deleteContentKnowledgeData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentDataDeletionSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return deleteContentConnectionDataForUser(context.userId, data.id, data.includeConfirmedBrain);
  });

export const beginNotionContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "notion-content-oauth",
      context.userId,
    );
    const state = await createContentOAuthState({ userId: context.userId, provider: "notion" });
    return { url: notionAuthorizationUrl(state) };
  });

export const completeNotionContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(4_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return completeNotionConnectionForUser(context.userId, data);
  });

export const beginGranolaContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "granola-content-oauth",
      context.userId,
    );
    return beginGranolaConnectionForUser(context.userId);
  });

export const completeGranolaContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(4_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return completeGranolaConnectionForUser(context.userId, data);
  });

export const beginGitHubContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "github-content-install",
      context.userId,
    );
    const state = await createContentOAuthState({ userId: context.userId, provider: "github" });
    return { url: githubAppInstallationUrl(state) };
  });

export const completeGitHubContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ installationId: z.string().regex(/^[0-9]{1,20}$/), state: z.string().uuid() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return completeGitHubConnectionForUser(context.userId, data);
  });

export const beginSlackContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "slack-content-oauth",
      context.userId,
    );
    const state = await createContentOAuthState({ userId: context.userId, provider: "slack" });
    return { url: slackAuthorizationUrl(state) };
  });

export const completeSlackContentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(4_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return completeSlackConnectionForUser(context.userId, data);
  });

export const beginContentKnowledgeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentProviderInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      `${data.provider}-content-connect`,
      context.userId,
    );
    if (data.provider === "granola") return beginGranolaConnectionForUser(context.userId);
    const state = await createContentOAuthState({
      userId: context.userId,
      provider: data.provider,
    });
    if (data.provider === "notion") return { url: notionAuthorizationUrl(state) };
    if (data.provider === "github") return { url: githubAppInstallationUrl(state) };
    return { url: slackAuthorizationUrl(state) };
  });

export const getContentKnowledgeResources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentConnectionIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const connection = await loadContentConnectionForUser(context.userId, data.id);
    if (!connection) throw new Error("Content connection not found.");
    const resources = await getContentProviderAdapter(connection.provider).listResources(
      connection,
    );
    const storedIds = Array.isArray(connection.selectedResources.ids)
      ? connection.selectedResources.ids.filter((id): id is string => typeof id === "string")
      : [];
    const selectedIds = storedIds.includes("all")
      ? resources.map((resource) => resource.id)
      : storedIds;
    return { resources, selectedIds };
  });

export const updateContentKnowledgeResources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentResourceSelectionSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const connection = await loadContentConnectionForUser(context.userId, data.id);
    if (!connection) throw new Error("Content connection not found.");
    return updateContentResourceSelectionWithAdapter(
      context.userId,
      data.id,
      data.resourceIds,
      getContentProviderAdapter(connection.provider),
    );
  });

export const syncContentKnowledgeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentConnectionIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-knowledge-sync",
      context.userId,
    );
    const connection = await loadContentConnectionForUser(context.userId, data.id);
    if (!connection) throw new Error("Content connection not found.");
    return syncContentConnectionWithAdapter(
      context.userId,
      data.id,
      getContentProviderAdapter(connection.provider),
    );
  });
