import * as SecureStore from 'expo-secure-store'
import { createClient } from '@supabase/supabase-js'

/**
 * ExpoSecureStoreAdapter stores ONLY the Supabase session (access_token + refresh_token).
 * The Google provider_token is intentionally NOT stored in the keychain.
 * expo-secure-store has a 2KB per-key size limit. Google's provider_token can exceed this,
 * causing silent storage failures on app re-launch. Since the mobile app uses signInWithIdToken,
 * the provider_token is not needed client-side after the initial auth call.
 * Supabase's ExpoSecureStoreAdapter handles this correctly by default — it only persists
 * the Supabase auth session, not the raw OAuth provider_token.
 */
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
