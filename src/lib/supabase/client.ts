"use client";

/**
 * The browser Supabase client.
 *
 * ONE instance for the whole app, created lazily. Two clients would each hold
 * their own copy of the session and their own auth listener, so a sign-out in
 * one would leave the other believing it was still signed in.
 *
 * WHAT MAY BE IN HERE: the project URL and the PUBLISHABLE key. Both ship to
 * every visitor's browser, which is what `NEXT_PUBLIC_` means -- there is no
 * server in a static export to keep anything from.
 *
 * WHAT MAY NEVER BE IN HERE: the service-role / secret key. It bypasses Row
 * Level Security completely, so putting it in client code would undo every
 * policy in 0002 and 0005 at once (brief section 8). If a feature seems to need
 * it, the answer is a SECURITY DEFINER function, not a key.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
/** Supabase's current name for the client-side key; the older projects call it
 *  the anon key, so both are accepted. */
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when this build has cloud credentials at all. */
export const isCloudConfigured = Boolean(url && publishableKey);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isCloudConfigured) {
    // A clear message at the one place that knows, rather than a null
    // dereference inside a repository three layers down.
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.",
    );
  }
  client ??= createClient(url!, publishableKey!, {
    auth: {
      // The session lives in localStorage and is refreshed in the background.
      // Required for a static export: there is no server to hold a cookie
      // session for us.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

/**
 * A guard against the mistake that would matter most.
 *
 * A secret key is recognisable, so there is no excuse for shipping one
 * unnoticed. Throwing at startup is kinder than discovering it in a pen test.
 */
if (publishableKey && /^sb_secret_|service_role/.test(publishableKey)) {
  throw new Error(
    "A SECRET key is set in NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. That key " +
      "bypasses Row Level Security and must never reach the browser. Use the " +
      "publishable key instead.",
  );
}
