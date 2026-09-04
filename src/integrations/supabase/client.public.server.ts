import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function createSupabasePublicClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    const missing = [
      ...(!supabaseUrl ? ["SUPABASE_URL"] : []),
      ...(!supabasePublishableKey ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
    ];
    throw new Error(`Missing Supabase environment variable(s): ${missing.join(", ")}.`);
  }

  return createClient<Database>(supabaseUrl, supabasePublishableKey, {
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let publicClient: ReturnType<typeof createSupabasePublicClient> | undefined;

/** Server-only, anonymous client for reads explicitly allowed by public RLS policies. */
export const supabasePublic = new Proxy({} as ReturnType<typeof createSupabasePublicClient>, {
  get(_, property, receiver) {
    if (!publicClient) publicClient = createSupabasePublicClient();
    return Reflect.get(publicClient, property, receiver);
  },
});
