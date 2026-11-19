import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listGranolaGatewayConnections,
  setGranolaGatewayPermission,
} from "./granola-mcp-gateway.server";

export const getGranolaMcpDelegation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listGranolaGatewayConnections(context.workspaceId, context.authUserId));

export const updateGranolaMcpDelegation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.uuid(), enabled: z.boolean() }).strict().parse(input))
  .handler(({ context, data }) =>
    setGranolaGatewayPermission(context.workspaceId, context.authUserId, data.id, data.enabled),
  );
