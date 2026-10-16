import { z } from "zod";
export const agentAppActionSchema = z.object({
  id: z.string().uuid(),
  tool: z.string().max(100),
  title: z.string().max(200),
  arguments: z.record(z.string(), z.json()),
});
export type AgentAppAction = z.infer<typeof agentAppActionSchema>;
export const agentAppActionStateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "running", "completed", "failed", "dismissed"]),
  message: z.string().nullable().optional(),
});
export type AgentAppActionState = z.infer<typeof agentAppActionStateSchema>;
