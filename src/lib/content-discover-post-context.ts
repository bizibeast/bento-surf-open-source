import { z } from "zod";
import type { DiscoverBaseline } from "./content-discover-baseline";
import type { DiscoverInspiration } from "./content-discover-ideas.server";
import type { ContentSourceStats } from "./content-sources.server";

const action = z.enum(["chat", "variations", "reverse-engineer", "replicate", "hooks", "brief"]);
export const analyticsPostReferenceSchema = z
  .object({
    connectionId: z.uuid(),
    remotePostId: z.string().min(1).max(300),
  })
  .strict();
export const analyticsHandoffSchema = analyticsPostReferenceSchema.extend({
  intent: z.enum([...action.options, "carousel", "reel"]),
});
export const discoverPostContextInputSchema = z.union([
  z
    .object({
      recommendationId: z.uuid(),
      action,
    })
    .strict(),
  z.object({ analyticsPost: analyticsPostReferenceSchema, action }).strict(),
]);
export type AnalyticsHandoff = z.infer<typeof analyticsHandoffSchema>;
export type AnalyticsPostReference = z.infer<typeof analyticsPostReferenceSchema>;
export type DiscoverPostContextInput = z.infer<typeof discoverPostContextInputSchema>;

export type DiscoverPostContext = DiscoverPostContextInput & {
  version: 1;
  evidence: {
    sourceId: string;
    url: string | null;
    title: string | null;
    summary: string | null;
    platform: string | null;
    author: string | null;
    publishedAt: string | null;
    retrievedAt: string | null;
    metrics: Required<ContentSourceStats>;
    baseline: DiscoverBaseline | null;
  };
  inspiration: (DiscoverInspiration & { title: string; summary: string; angles: string[] }) | null;
};
