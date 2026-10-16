import { z } from "zod";
export const agentStockPhotoSchema = z.object({
  id: z.number().int().positive(),
  provider: z.enum(["pixabay", "pexels", "commons"]),
  previewUrl: z.string().url(),
  url: z.string().url(),
  photographer: z.string().max(200),
  description: z.string().max(1000),
});
export const agentAppActionSchema = z.object({
  id: z.string().uuid(),
  tool: z.string().max(100),
  title: z.string().max(200),
  arguments: z.record(z.string(), z.json()),
  labels: z.record(z.string().uuid(), z.string().max(160)).optional(),
  stockPhoto: agentStockPhotoSchema.optional(),
});
export type AgentAppAction = z.infer<typeof agentAppActionSchema>;
export const agentAppActionStateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "running", "completed", "failed", "dismissed"]),
  message: z.string().nullable().optional(),
  revision: z.string().optional(),
  arguments: z.record(z.string(), z.json()).optional(),
});
export type AgentAppActionState = z.infer<typeof agentAppActionStateSchema>;

export const agentPostEditSchema = z
  .object({
    connectionId: z.string().uuid(),
    body: z.string().trim().min(1).max(25000),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type AgentPostEdit = z.infer<typeof agentPostEditSchema>;
