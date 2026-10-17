import { readAutoDmDelay, writeAutoDmDelay } from "./auto-dm-delay-settings.server";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { autoDmDelaySchema } from "./auto-dm-delay";

export const getAutoDmDelay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => readAutoDmDelay(context.userId));
export const setAutoDmDelay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ delaySeconds: autoDmDelaySchema }).strict().parse(input),
  )
  .handler(({ context, data }) => writeAutoDmDelay(context.userId, data));
