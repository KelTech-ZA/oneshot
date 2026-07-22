import { createClient } from "@supabase/supabase-js";

// Set in Netlify env (VITE_ prefixed) or a local .env file
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const supabase = createClient(SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
