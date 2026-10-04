/* eslint-disable @typescript-eslint/no-explicit-any -- Routine table ships with the Content migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { nextContentRoutineRun } from "./content-routines";
import { SOCIAL_PROVIDERS } from "./social-scheduler";
import { isValidTimeZone } from "./timezones";

export const CONTENT_ROUTINE_TEMPLATES = [
  "nightly_niche_brief",
  "fill_schedule",
  "morning_ready_email",
  "weekly_performance_review",
] as const;

const routineInputSchema = z
  .object({
    template: z
      .enum(CONTENT_ROUTINE_TEMPLATES)
      .or(
        z
          .string()
          .regex(
            /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
      ),
    enabled: z.boolean(),
    intervalMinutes: z.union([z.literal(1_440), z.literal(10_080)]),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(100).refine(isValidTimeZone, "Choose a valid timezone."),
    platforms: z
      .array(z.enum(SOCIAL_PROVIDERS))
      .max(8)
      .transform((values) => [...new Set(values)]),
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.string().trim().min(1).max(4_000).optional(),
    catalogKey: z.string().trim().max(100).optional(),
  })
  .superRefine((value, context) => {
    if (value.template.startsWith("custom:") && (!value.name || !value.instructions))
      context.addIssue({ code: "custom", message: "Give your routine a name and instructions." });
  });
export type ContentRoutineInput = z.infer<typeof routineInputSchema>;

export const getContentRoutines = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    const { data, error } = await (supabaseAdmin as any)
      .from("content_routines")
      .select("id,template,enabled,schedule,timezone,platforms,next_run_at,last_run_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error("Content routines could not be loaded.");
    return data || [];
  });

export const saveContentRoutine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => routineInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const schedule = {
      intervalMinutes: data.intervalMinutes,
      time: data.time,
      ...(data.name ? { name: data.name } : {}),
      ...(data.instructions ? { instructions: data.instructions } : {}),
      ...(data.catalogKey ? { catalogKey: data.catalogKey } : {}),
    };
    const nextRunAt = data.enabled
      ? nextContentRoutineRun(schedule, data.timezone).toISOString()
      : null;
    const { data: saved, error } = await (supabaseAdmin as any)
      .from("content_routines")
      .upsert(
        {
          user_id: context.userId,
          template: data.template,
          enabled: data.enabled,
          schedule,
          timezone: data.timezone,
          platforms: data.platforms,
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,template" },
      )
      .select("id")
      .maybeSingle();
    if (error || !saved) throw new Error("The Content routine could not be saved.");
    return { id: saved.id, nextRunAt };
  });

export const getContentRoutineActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    const { data, error } = await (supabaseAdmin as any)
      .from("content_routine_runs")
      .select("id,routine_id,status,result_count,error_message,scheduled_for")
      .eq("user_id", context.userId)
      .order("scheduled_for", { ascending: false })
      .limit(30);
    if (error) throw new Error("Routine activity could not be loaded.");
    return data || [];
  });

export const setContentRoutinePaused = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), paused: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: routine, error: loadError } = await (supabaseAdmin as any)
      .from("content_routines")
      .select("schedule,timezone")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (loadError || !routine) throw new Error("This Content routine is unavailable.");
    const nextRunAt = data.paused
      ? null
      : nextContentRoutineRun(routine.schedule, routine.timezone).toISOString();
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("content_routines")
      .update({ enabled: !data.paused, next_run_at: nextRunAt })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !updated) throw new Error("The Content routine could not be changed.");
    return { id: data.id, paused: data.paused };
  });
