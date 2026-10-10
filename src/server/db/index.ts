import "server-only";
/**
 * Service-role Supabase client. Server-only.
 *
 * V2 does not use Supabase Auth: RLS is on with no policies (deny-all), so
 * every read/write goes through this client from server code. Never import
 * this from a client component.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "@/server/env";
import type { Database } from "@/server/db/types";

export type Db = SupabaseClient<Database>;
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

let client: Db | null = null;

/** Lazily create (and reuse) the service-role client. */
export function db(): Db {
  if (!client) {
    client = createClient<Database>(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return client;
}
