export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      agent_runs: {
        Row: {
          channel_id: string | null
          cost_usd: number
          error: string | null
          escalated: boolean
          escalation_reason: string | null
          finished_at: string | null
          id: string
          input_message_ids: string[]
          is_eval: boolean
          iterations: number
          latency_ms: number | null
          llm_call_count: number
          model: string | null
          plan: Json | null
          started_at: string
          status: string
          tool_calls: Json
          trigger: string
          user_id: string
        }
        Insert: {
          channel_id?: string | null
          cost_usd?: number
          error?: string | null
          escalated?: boolean
          escalation_reason?: string | null
          finished_at?: string | null
          id?: string
          input_message_ids?: string[]
          is_eval?: boolean
          iterations?: number
          latency_ms?: number | null
          llm_call_count?: number
          model?: string | null
          plan?: Json | null
          started_at?: string
          status?: string
          tool_calls?: Json
          trigger?: string
          user_id: string
        }
        Update: {
          channel_id?: string | null
          cost_usd?: number
          error?: string | null
          escalated?: boolean
          escalation_reason?: string | null
          finished_at?: string | null
          id?: string
          input_message_ids?: string[]
          is_eval?: boolean
          iterations?: number
          latency_ms?: number | null
          llm_call_count?: number
          model?: string | null
          plan?: Json | null
          started_at?: string
          status?: string
          tool_calls?: Json
          trigger?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      briefing_notes: {
        Row: {
          consumed_at: string | null
          consumed_by: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          item_id: string | null
          kind: string
          payload: Json
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          item_id?: string | null
          kind: string
          payload?: Json
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          item_id?: string | null
          kind?: string
          payload?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "briefing_notes_consumed_by_fkey"
            columns: ["consumed_by"]
            isOneToOne: false
            referencedRelation: "briefings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefing_notes_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "timeline_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefing_notes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      briefings: {
        Row: {
          created_at: string
          generated_at: string | null
          id: string
          kind: string
          llm_cost_usd: number | null
          local_date: string
          plan: Json | null
          sent_at: string | null
          skip_reason: string | null
          snapshot_hash: string | null
          status: string
          target_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string | null
          id?: string
          kind?: string
          llm_cost_usd?: number | null
          local_date: string
          plan?: Json | null
          sent_at?: string | null
          skip_reason?: string | null
          snapshot_hash?: string | null
          status?: string
          target_at: string
          user_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string | null
          id?: string
          kind?: string
          llm_cost_usd?: number | null
          local_date?: string
          plan?: Json | null
          sent_at?: string | null
          skip_reason?: string | null
          snapshot_hash?: string | null
          status?: string
          target_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "briefings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          created_at: string
          handle: string
          handle_kind: string
          id: string
          is_primary: boolean
          kind: string
          last_inbound_at: string | null
          last_service: string | null
          opted_out_at: string | null
          paused_until: string | null
          provider: string | null
          provider_line: string | null
          user_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          handle: string
          handle_kind: string
          id?: string
          is_primary?: boolean
          kind: string
          last_inbound_at?: string | null
          last_service?: string | null
          opted_out_at?: string | null
          paused_until?: string | null
          provider?: string | null
          provider_line?: string | null
          user_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          handle?: string
          handle_kind?: string
          id?: string
          is_primary?: boolean
          kind?: string
          last_inbound_at?: string | null
          last_service?: string | null
          opted_out_at?: string | null
          paused_until?: string | null
          provider?: string | null
          provider_line?: string | null
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channels_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      consents: {
        Row: {
          captured_at: string
          channel_id: string | null
          copy_version: string | null
          granted: boolean
          id: string
          scope: string
          source: string | null
          user_id: string
        }
        Insert: {
          captured_at?: string
          channel_id?: string | null
          copy_version?: string | null
          granted: boolean
          id?: string
          scope: string
          source?: string | null
          user_id: string
        }
        Update: {
          captured_at?: string
          channel_id?: string | null
          copy_version?: string | null
          granted?: boolean
          id?: string
          scope?: string
          source?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "consents_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_summaries: {
        Row: {
          summary: string | null
          through_message_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          summary?: string | null
          through_message_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          summary?: string | null
          through_message_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_summaries_through_message_id_fkey"
            columns: ["through_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_summaries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      email_items: {
        Row: {
          alerted_at: string | null
          category: string | null
          classified_at: string | null
          confidence: number | null
          course: string | null
          created_at: string
          from_addr: string | null
          gmail_message_id: string
          id: string
          importance: string | null
          kind: string | null
          labels: string[] | null
          new_due: string | null
          old_due: string | null
          prefilter_reason: string | null
          received_at: string | null
          rfc822_message_id: string | null
          source: string
          subject: string | null
          summary: string | null
          surfaced_at: string | null
          thread_id: string | null
          user_id: string
        }
        Insert: {
          alerted_at?: string | null
          category?: string | null
          classified_at?: string | null
          confidence?: number | null
          course?: string | null
          created_at?: string
          from_addr?: string | null
          gmail_message_id: string
          id?: string
          importance?: string | null
          kind?: string | null
          labels?: string[] | null
          new_due?: string | null
          old_due?: string | null
          prefilter_reason?: string | null
          received_at?: string | null
          rfc822_message_id?: string | null
          source?: string
          subject?: string | null
          summary?: string | null
          surfaced_at?: string | null
          thread_id?: string | null
          user_id: string
        }
        Update: {
          alerted_at?: string | null
          category?: string | null
          classified_at?: string | null
          confidence?: number | null
          course?: string | null
          created_at?: string
          from_addr?: string | null
          gmail_message_id?: string
          id?: string
          importance?: string | null
          kind?: string | null
          labels?: string[] | null
          new_due?: string | null
          old_due?: string | null
          prefilter_reason?: string | null
          received_at?: string | null
          rfc822_message_id?: string | null
          source?: string
          subject?: string | null
          summary?: string | null
          surfaced_at?: string | null
          thread_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          account_email: string | null
          connected_at: string | null
          consecutive_failures: number
          created_at: string
          enc_access_token: string | null
          enc_ical_url: string | null
          enc_refresh_token: string | null
          feed_hash: string | null
          first_failure_at: string | null
          gcal_aria_calendar_id: string | null
          gcal_calendar_ids: string[]
          gcal_channel_id: string | null
          gcal_channel_token_hash: string | null
          gcal_resource_id: string | null
          gcal_watch_expires_at: string | null
          gmail_history_id: string | null
          gmail_synced_at: string | null
          gmail_triage: Json | null
          gmail_watch_expires_at: string | null
          ical_host: string | null
          ical_url_fp: string | null
          id: string
          last_error: string | null
          last_error_at: string | null
          next_sync_at: string | null
          provider: string
          scopes: string[] | null
          status: string
          status_notified_at: string | null
          status_reason: string | null
          sync_lease_until: string | null
          synced_at: string | null
          token_expires_at: string | null
          user_id: string
        }
        Insert: {
          account_email?: string | null
          connected_at?: string | null
          consecutive_failures?: number
          created_at?: string
          enc_access_token?: string | null
          enc_ical_url?: string | null
          enc_refresh_token?: string | null
          feed_hash?: string | null
          first_failure_at?: string | null
          gcal_aria_calendar_id?: string | null
          gcal_calendar_ids?: string[]
          gcal_channel_id?: string | null
          gcal_channel_token_hash?: string | null
          gcal_resource_id?: string | null
          gcal_watch_expires_at?: string | null
          gmail_history_id?: string | null
          gmail_synced_at?: string | null
          gmail_triage?: Json | null
          gmail_watch_expires_at?: string | null
          ical_host?: string | null
          ical_url_fp?: string | null
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          next_sync_at?: string | null
          provider: string
          scopes?: string[] | null
          status?: string
          status_notified_at?: string | null
          status_reason?: string | null
          sync_lease_until?: string | null
          synced_at?: string | null
          token_expires_at?: string | null
          user_id: string
        }
        Update: {
          account_email?: string | null
          connected_at?: string | null
          consecutive_failures?: number
          created_at?: string
          enc_access_token?: string | null
          enc_ical_url?: string | null
          enc_refresh_token?: string | null
          feed_hash?: string | null
          first_failure_at?: string | null
          gcal_aria_calendar_id?: string | null
          gcal_calendar_ids?: string[]
          gcal_channel_id?: string | null
          gcal_channel_token_hash?: string | null
          gcal_resource_id?: string | null
          gcal_watch_expires_at?: string | null
          gmail_history_id?: string | null
          gmail_synced_at?: string | null
          gmail_triage?: Json | null
          gmail_watch_expires_at?: string | null
          ical_host?: string | null
          ical_url_fp?: string | null
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          next_sync_at?: string | null
          provider?: string
          scopes?: string[] | null
          status?: string
          status_notified_at?: string | null
          status_reason?: string | null
          sync_lease_until?: string | null
          synced_at?: string | null
          token_expires_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          payload: Json
          run_at: string
          started_at: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          id?: string
          kind: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          started_at?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          started_at?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          cache_read: number | null
          cache_write: number | null
          cost_usd: number | null
          created_at: string
          error: string | null
          id: string
          input_tokens: number | null
          iteration: number | null
          job_id: string | null
          latency_ms: number | null
          meta: Json | null
          model: string | null
          output_tokens: number | null
          provider: string
          request_id: string | null
          route: string | null
          run_id: string | null
          stop_reason: string | null
          thinking_tokens: number | null
          user_id: string | null
        }
        Insert: {
          cache_read?: number | null
          cache_write?: number | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number | null
          iteration?: number | null
          job_id?: string | null
          latency_ms?: number | null
          meta?: Json | null
          model?: string | null
          output_tokens?: number | null
          provider?: string
          request_id?: string | null
          route?: string | null
          run_id?: string | null
          stop_reason?: string | null
          thinking_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          cache_read?: number | null
          cache_write?: number | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number | null
          iteration?: number | null
          job_id?: string | null
          latency_ms?: number | null
          meta?: Json | null
          model?: string | null
          output_tokens?: number | null
          provider?: string
          request_id?: string | null
          route?: string | null
          run_id?: string | null
          stop_reason?: string | null
          thinking_tokens?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_calls_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_calls_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      magic_links: {
        Row: {
          created_at: string
          expires_at: string
          purpose: string
          target: string | null
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          purpose: string
          target?: string | null
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          purpose?: string
          target?: string | null
          token_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "magic_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_facts: {
        Row: {
          category: string | null
          confidence: number | null
          content: string
          created_at: string
          deleted_at: string | null
          embedding: string | null
          expires_at: string | null
          id: string
          last_recalled_at: string | null
          source: string
          source_message_id: string | null
          superseded_by: string | null
          tsv: unknown
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          confidence?: number | null
          content: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          expires_at?: string | null
          id?: string
          last_recalled_at?: string | null
          source?: string
          source_message_id?: string | null
          superseded_by?: string | null
          tsv?: unknown
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string | null
          confidence?: number | null
          content?: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          expires_at?: string | null
          id?: string
          last_recalled_at?: string | null
          source?: string
          source_message_id?: string | null
          superseded_by?: string | null
          tsv?: unknown
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_facts_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_facts_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "memory_facts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_facts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string | null
          channel_id: string
          consumed_by_run: string | null
          created_at: string
          delivery_id: string | null
          direction: string
          id: string
          idempotency_key: string | null
          media: Json | null
          outside_window: boolean
          proactive_class: string | null
          provider: string | null
          provider_message_id: string | null
          reply_to_message_id: string | null
          run_id: string | null
          service: string | null
          status: string | null
          trigger: string | null
          user_id: string
        }
        Insert: {
          body?: string | null
          channel_id: string
          consumed_by_run?: string | null
          created_at?: string
          delivery_id?: string | null
          direction: string
          id?: string
          idempotency_key?: string | null
          media?: Json | null
          outside_window?: boolean
          proactive_class?: string | null
          provider?: string | null
          provider_message_id?: string | null
          reply_to_message_id?: string | null
          run_id?: string | null
          service?: string | null
          status?: string | null
          trigger?: string | null
          user_id: string
        }
        Update: {
          body?: string | null
          channel_id?: string
          consumed_by_run?: string | null
          created_at?: string
          delivery_id?: string | null
          direction?: string
          id?: string
          idempotency_key?: string | null
          media?: Json | null
          outside_window?: boolean
          proactive_class?: string | null
          provider?: string | null
          provider_message_id?: string | null
          reply_to_message_id?: string | null
          run_id?: string | null
          service?: string | null
          status?: string | null
          trigger?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_actions: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_via: string | null
          error: string | null
          executed_at: string | null
          expires_at: string
          id: string
          kind: string
          payload: Json
          preview_message_id: string | null
          result: Json | null
          run_id: string | null
          status: string
          summary: string | null
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_via?: string | null
          error?: string | null
          executed_at?: string | null
          expires_at?: string
          id?: string
          kind: string
          payload: Json
          preview_message_id?: string | null
          result?: Json | null
          run_id?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_via?: string | null
          error?: string | null
          executed_at?: string | null
          expires_at?: string
          id?: string
          kind?: string
          payload?: Json
          preview_message_id?: string | null
          result?: Json | null
          run_id?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "pending_actions_preview_message_id_fkey"
            columns: ["preview_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_actions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      proactive_dedupe: {
        Row: {
          dedupe_key: string
          delivered_at: string
          user_id: string
        }
        Insert: {
          dedupe_key: string
          delivered_at?: string
          user_id: string
        }
        Update: {
          dedupe_key?: string
          delivered_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proactive_dedupe_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      reactions: {
        Row: {
          actor: string
          created_at: string
          id: string
          message_id: string
          removed_at: string | null
          type: string
        }
        Insert: {
          actor: string
          created_at?: string
          id?: string
          message_id: string
          removed_at?: string | null
          type: string
        }
        Update: {
          actor?: string
          created_at?: string
          id?: string
          message_id?: string
          removed_at?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      reminders: {
        Row: {
          anchor_item_id: string | null
          body: string
          created_at: string
          due_at: string | null
          fire_count: number
          id: string
          job_id: string | null
          kind: string
          last_fired_at: string | null
          offset_minutes: number | null
          origin: string
          rrule: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          anchor_item_id?: string | null
          body: string
          created_at?: string
          due_at?: string | null
          fire_count?: number
          id?: string
          job_id?: string | null
          kind?: string
          last_fired_at?: string | null
          offset_minutes?: number | null
          origin?: string
          rrule?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          anchor_item_id?: string | null
          body?: string
          created_at?: string
          due_at?: string | null
          fire_count?: number
          id?: string
          job_id?: string | null
          kind?: string
          last_fired_at?: string | null
          offset_minutes?: number | null
          origin?: string
          rrule?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_anchor_fk"
            columns: ["anchor_item_id"]
            isOneToOne: false
            referencedRelation: "timeline_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      signups: {
        Row: {
          consent_version: string | null
          created_at: string
          expires_at: string
          id: string
          ip: unknown
          matched_user_id: string | null
          name: string | null
          phone_e164: string | null
          timezone: string | null
          user_agent: string | null
        }
        Insert: {
          consent_version?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: unknown
          matched_user_id?: string | null
          name?: string | null
          phone_e164?: string | null
          timezone?: string | null
          user_agent?: string | null
        }
        Update: {
          consent_version?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: unknown
          matched_user_id?: string | null
          name?: string | null
          phone_e164?: string | null
          timezone?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signups_matched_user_id_fkey"
            columns: ["matched_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      syllabi: {
        Row: {
          course_code: string | null
          course_key: string
          course_name: string
          id: string
          issues: Json
          model: string | null
          page_count: number | null
          parsed_at: string
          parsed_json: Json
          parser_version: string | null
          pdf_sha256: string | null
          source: string | null
          source_message_id: string | null
          status: string
          term: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          course_code?: string | null
          course_key: string
          course_name: string
          id?: string
          issues?: Json
          model?: string | null
          page_count?: number | null
          parsed_at?: string
          parsed_json: Json
          parser_version?: string | null
          pdf_sha256?: string | null
          source?: string | null
          source_message_id?: string | null
          status?: string
          term?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          course_code?: string | null
          course_key?: string
          course_name?: string
          id?: string
          issues?: Json
          model?: string | null
          page_count?: number | null
          parsed_at?: string
          parsed_json?: Json
          parser_version?: string | null
          pdf_sha256?: string | null
          source?: string | null
          source_message_id?: string | null
          status?: string
          term?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "syllabi_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "syllabi_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      system_heartbeat: {
        Row: {
          beat_at: string
          detail: Json | null
          id: string
        }
        Insert: {
          beat_at?: string
          detail?: Json | null
          id: string
        }
        Update: {
          beat_at?: string
          detail?: Json | null
          id?: string
        }
        Relationships: []
      }
      timeline_items: {
        Row: {
          all_day: boolean
          anchor_at: string | null
          course: string | null
          due_at: string | null
          ends_at: string | null
          external_id: string
          id: string
          kind: string
          match_key: string | null
          raw: Json | null
          removed_at: string | null
          source: string
          starts_at: string | null
          status: string
          timing_key: string | null
          title: string | null
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          all_day?: boolean
          anchor_at?: string | null
          course?: string | null
          due_at?: string | null
          ends_at?: string | null
          external_id: string
          id?: string
          kind: string
          match_key?: string | null
          raw?: Json | null
          removed_at?: string | null
          source: string
          starts_at?: string | null
          status?: string
          timing_key?: string | null
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          all_day?: boolean
          anchor_at?: string | null
          course?: string | null
          due_at?: string | null
          ends_at?: string | null
          external_id?: string
          id?: string
          kind?: string
          match_key?: string | null
          raw?: Json | null
          removed_at?: string | null
          source?: string
          starts_at?: string | null
          status?: string
          timing_key?: string | null
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timeline_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          asked_at: string | null
          category: string | null
          constraint_json: Json | null
          decided_at: string | null
          evidence_message_id: string | null
          id: string
          key: string
          last_used_at: string | null
          proposed_by_run: string | null
          source: string | null
          statement: string
          status: string
          superseded_by: string | null
          user_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          asked_at?: string | null
          category?: string | null
          constraint_json?: Json | null
          decided_at?: string | null
          evidence_message_id?: string | null
          id?: string
          key: string
          last_used_at?: string | null
          proposed_by_run?: string | null
          source?: string | null
          statement: string
          status?: string
          superseded_by?: string | null
          user_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          asked_at?: string | null
          category?: string | null
          constraint_json?: Json | null
          decided_at?: string | null
          evidence_message_id?: string | null
          id?: string
          key?: string
          last_used_at?: string | null
          proposed_by_run?: string | null
          source?: string | null
          statement?: string
          status?: string
          superseded_by?: string | null
          user_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_evidence_message_id_fkey"
            columns: ["evidence_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_proposed_by_run_fkey"
            columns: ["proposed_by_run"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "user_preferences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profile: {
        Row: {
          class_times: Json | null
          courses: Json | null
          rendered_block: string | null
          school: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          class_times?: Json | null
          courses?: Json | null
          rendered_block?: string | null
          school?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          class_times?: Json | null
          courses?: Json | null
          rendered_block?: string | null
          school?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profile_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_runtime: {
        Row: {
          last_run_at: string | null
          lease_owner: string | null
          lease_until: string | null
          memory_extracted_through: string | null
          user_id: string
        }
        Insert: {
          last_run_at?: string | null
          lease_owner?: string | null
          lease_until?: string | null
          memory_extracted_through?: string | null
          user_id: string
        }
        Update: {
          last_run_at?: string | null
          lease_owner?: string | null
          lease_until?: string | null
          memory_extracted_through?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_runtime_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          birth_year: number | null
          briefing_enabled: boolean
          briefing_time: string
          created_at: string
          deadline_nudge_minutes: number[]
          deleted_at: string | null
          id: string
          last_briefing_sent_at: string | null
          name: string | null
          next_briefing_at: string | null
          persona_prefs: Json
          quiet_end: string
          quiet_start: string
          timezone: string
          timezone_source: string
        }
        Insert: {
          birth_year?: number | null
          briefing_enabled?: boolean
          briefing_time?: string
          created_at?: string
          deadline_nudge_minutes?: number[]
          deleted_at?: string | null
          id?: string
          last_briefing_sent_at?: string | null
          name?: string | null
          next_briefing_at?: string | null
          persona_prefs?: Json
          quiet_end?: string
          quiet_start?: string
          timezone?: string
          timezone_source?: string
        }
        Update: {
          birth_year?: number | null
          briefing_enabled?: boolean
          briefing_time?: string
          created_at?: string
          deadline_nudge_minutes?: number[]
          deleted_at?: string | null
          id?: string
          last_briefing_sent_at?: string | null
          name?: string | null
          next_briefing_at?: string | null
          persona_prefs?: Json
          quiet_end?: string
          quiet_start?: string
          timezone?: string
          timezone_source?: string
        }
        Relationships: []
      }
      web_sessions: {
        Row: {
          created_at: string
          expires_at: string
          revoked_at: string | null
          scope: string
          session_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          revoked_at?: string | null
          scope?: string
          session_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          revoked_at?: string | null
          scope?: string
          session_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "web_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_user_lease: {
        Args: { p_owner: string; p_ttl_ms: number; p_user_id: string }
        Returns: boolean
      }
      advance_gmail_cursor: {
        Args: {
          p_expected?: string
          p_force?: boolean
          p_integration_id: string
          p_new: string
        }
        Returns: boolean
      }
      claim_escalation: {
        Args: {
          p_pct?: number
          p_reason: string
          p_run: string
          p_window?: string
        }
        Returns: boolean
      }
      claim_jobs: {
        Args: {
          p_dedupe_key?: string
          p_job_id?: string
          p_kinds: string[]
          p_limit?: number
          p_lock_seconds?: number
          p_token: string
        }
        Returns: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          payload: Json
          run_at: string
          started_at: string | null
          status: string
          user_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      decide_preference: {
        Args: { p_decision: string; p_pref: string; p_user: string }
        Returns: {
          asked_at: string | null
          category: string | null
          constraint_json: Json | null
          decided_at: string | null
          evidence_message_id: string | null
          id: string
          key: string
          last_used_at: string | null
          proposed_by_run: string | null
          source: string | null
          statement: string
          status: string
          superseded_by: string | null
          user_id: string
          valid_from: string
          valid_to: string | null
        }
        SetofOptions: {
          from: "*"
          to: "user_preferences"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      enqueue_job: {
        Args: {
          p_dedupe_key?: string
          p_kind: string
          p_max_attempts?: number
          p_max_delay_ms?: number
          p_mode?: string
          p_payload?: Json
          p_run_at?: string
          p_user_id?: string
        }
        Returns: {
          created: boolean
          db_now: string
          job_id: string
          job_run_at: string
        }[]
      }
      finish_job: {
        Args: {
          p_error?: string
          p_id: string
          p_outcome: string
          p_run_at?: string
          p_token: string
        }
        Returns: string
      }
      ingest_inbound_message: {
        Args: {
          p_body: string
          p_handle: string
          p_handle_kind: string
          p_kind: string
          p_media: Json
          p_provider: string
          p_provider_line: string
          p_provider_message_id: string
          p_provider_opted_out: boolean
          p_reply_to_provider_id: string
          p_sent_at: string
          p_service: string
        }
        Returns: {
          channel_id: string
          db_now: string
          duplicate: boolean
          is_new_user: boolean
          message_id: string
          opted_out_at: string
          paused_until: string
          timezone: string
          timezone_source: string
          user_id: string
          user_name: string
        }[]
      }
      purge_messages_before: {
        Args: { p_before: string; p_limit?: number }
        Returns: number
      }
      recall_facts: {
        Args: {
          p_limit?: number
          p_query: string
          p_recency_weight?: number
          p_user: string
        }
        Returns: {
          category: string
          content: string
          created_at: string
          id: string
          score: number
        }[]
      }
      timeline_apply: {
        Args: {
          p_rekeys?: Json
          p_remove_ids?: string[]
          p_source: string
          p_upserts?: Json
          p_user_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
