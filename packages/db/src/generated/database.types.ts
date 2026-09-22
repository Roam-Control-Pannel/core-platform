export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          detail: Json
          entity_id: string | null
          entity_type: string | null
          id: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_users: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          role: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id: string
          note?: string | null
          role?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_users_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_users_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_journeys: {
        Row: {
          active: boolean
          created_at: string
          definition: Json
          id: string
          name: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          definition?: Json
          id?: string
          name: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          definition?: Json
          id?: string
          name?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_journeys_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      awin_deals: {
        Row: {
          active: boolean
          advertiser_id: string
          advertiser_name: string | null
          awin_promotion_id: string | null
          category: string | null
          created_at: string
          description: string | null
          destination_url: string
          ends_at: string | null
          id: string
          image_url: string | null
          kind: string
          region: string | null
          starts_at: string | null
          terms: string | null
          title: string
          updated_at: string
          voucher_code: string | null
        }
        Insert: {
          active?: boolean
          advertiser_id: string
          advertiser_name?: string | null
          awin_promotion_id?: string | null
          category?: string | null
          created_at?: string
          description?: string | null
          destination_url: string
          ends_at?: string | null
          id?: string
          image_url?: string | null
          kind?: string
          region?: string | null
          starts_at?: string | null
          terms?: string | null
          title: string
          updated_at?: string
          voucher_code?: string | null
        }
        Update: {
          active?: boolean
          advertiser_id?: string
          advertiser_name?: string | null
          awin_promotion_id?: string | null
          category?: string | null
          created_at?: string
          description?: string | null
          destination_url?: string
          ends_at?: string | null
          id?: string
          image_url?: string | null
          kind?: string
          region?: string | null
          starts_at?: string | null
          terms?: string | null
          title?: string
          updated_at?: string
          voucher_code?: string | null
        }
        Relationships: []
      }
      billing_customers: {
        Row: {
          created_at: string
          current_period_end: string | null
          stripe_customer_id: string | null
          tier: Database["public"]["Enums"]["subscription_tier"]
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          stripe_customer_id?: string | null
          tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          stripe_customer_id?: string | null
          tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_customers_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_transactions: {
        Row: {
          amount_pence: number
          created_at: string
          currency: string
          description: string | null
          id: string
          refunded_at: string | null
          refunded_pence: number
          stripe_charge_id: string | null
          stripe_payment_intent: string | null
          vat_pence: number
          venue_id: string
        }
        Insert: {
          amount_pence: number
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          refunded_at?: string | null
          refunded_pence?: number
          stripe_charge_id?: string | null
          stripe_payment_intent?: string | null
          vat_pence?: number
          venue_id: string
        }
        Update: {
          amount_pence?: number
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          refunded_at?: string | null
          refunded_pence?: number
          stripe_charge_id?: string | null
          stripe_payment_intent?: string | null
          vat_pence?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_transactions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      birthday_deliveries: {
        Row: {
          code: string | null
          created_at: string
          delivered_on: string
          expires_at: string | null
          id: string
          redeemed_at: string | null
          title: string | null
          user_id: string
          venue_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          delivered_on?: string
          expires_at?: string | null
          id?: string
          redeemed_at?: string | null
          title?: string | null
          user_id: string
          venue_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          delivered_on?: string
          expires_at?: string | null
          id?: string
          redeemed_at?: string | null
          title?: string | null
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "birthday_deliveries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "birthday_deliveries_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_domains: {
        Row: {
          channel_id: string
          created_at: string
          host: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          host: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          host?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_domains_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_import_runs: {
        Row: {
          actor_id: string | null
          backfilled: number
          channel_id: string
          created_at: string
          errors: number
          finished_at: string | null
          id: string
          imported: number
          invited: number
          matched_accept: number
          matched_reject: number
          matched_review: number
          report: Json
          started_at: string | null
          updated: number
        }
        Insert: {
          actor_id?: string | null
          backfilled?: number
          channel_id: string
          created_at?: string
          errors?: number
          finished_at?: string | null
          id?: string
          imported?: number
          invited?: number
          matched_accept?: number
          matched_reject?: number
          matched_review?: number
          report?: Json
          started_at?: string | null
          updated?: number
        }
        Update: {
          actor_id?: string | null
          backfilled?: number
          channel_id?: string
          created_at?: string
          errors?: number
          finished_at?: string | null
          id?: string
          imported?: number
          invited?: number
          matched_accept?: number
          matched_reject?: number
          matched_review?: number
          report?: Json
          started_at?: string | null
          updated?: number
        }
        Relationships: [
          {
            foreignKeyName: "channel_import_runs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_import_runs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_members: {
        Row: {
          channel_id: string
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          id: string
          invited_at: string | null
          lapsed_at: string | null
          match_dismissed_at: string | null
          match_dismissed_by: string | null
          membership_ref: string
          source_address: string | null
          source_council: string | null
          source_email: string | null
          source_name: string
          source_phone: string | null
          source_postcode: string | null
          source_raw: Json
          status: string
          updated_at: string
          venue_id: string | null
        }
        Insert: {
          channel_id: string
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          lapsed_at?: string | null
          match_dismissed_at?: string | null
          match_dismissed_by?: string | null
          membership_ref: string
          source_address?: string | null
          source_council?: string | null
          source_email?: string | null
          source_name: string
          source_phone?: string | null
          source_postcode?: string | null
          source_raw?: Json
          status?: string
          updated_at?: string
          venue_id?: string | null
        }
        Update: {
          channel_id?: string
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          lapsed_at?: string | null
          match_dismissed_at?: string | null
          match_dismissed_by?: string | null
          membership_ref?: string
          source_address?: string | null
          source_council?: string | null
          source_email?: string | null
          source_name?: string
          source_phone?: string | null
          source_postcode?: string | null
          source_raw?: Json
          status?: string
          updated_at?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_members_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_match_dismissed_by_fkey"
            columns: ["match_dismissed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          active: boolean
          created_at: string
          id: string
          is_default: boolean
          key: string
          logo_url: string | null
          membership_mode: string
          name: string
          nav: Json
          platform_fee_bps: number
          sections: Json
          surface: string
          tagline: string | null
          theme: Json
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          is_default?: boolean
          key: string
          logo_url?: string | null
          membership_mode?: string
          name: string
          nav?: Json
          platform_fee_bps?: number
          sections?: Json
          surface?: string
          tagline?: string | null
          theme?: Json
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          is_default?: boolean
          key?: string
          logo_url?: string | null
          membership_mode?: string
          name?: string
          nav?: Json
          platform_fee_bps?: number
          sections?: Json
          surface?: string
          tagline?: string | null
          theme?: Json
          updated_at?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          payload: Json | null
          sender_id: string | null
          thread_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          payload?: Json | null
          sender_id?: string | null
          thread_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          payload?: Json | null
          sender_id?: string | null
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_participants: {
        Row: {
          created_at: string
          last_read_at: string | null
          profile_id: string
          thread_id: string
        }
        Insert: {
          created_at?: string
          last_read_at?: string | null
          profile_id: string
          thread_id: string
        }
        Update: {
          created_at?: string
          last_read_at?: string | null
          profile_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_participants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_participants_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_poll_votes: {
        Row: {
          created_at: string
          message_id: string
          option_id: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          message_id: string
          option_id: string
          profile_id: string
        }
        Update: {
          created_at?: string
          message_id?: string
          option_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_poll_votes_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_poll_votes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_polls: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          message_id: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          message_id: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_polls_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_polls_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          image_path: string | null
          is_group: boolean
          plan_id: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_path?: string | null
          is_group?: boolean
          plan_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          image_path?: string | null
          is_group?: boolean
          plan_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_threads_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      cj_advertisers: {
        Row: {
          advertiser_id: string
          advertiser_name: string | null
          logo_url: string | null
          program_url: string | null
          updated_at: string
        }
        Insert: {
          advertiser_id: string
          advertiser_name?: string | null
          logo_url?: string | null
          program_url?: string | null
          updated_at?: string
        }
        Update: {
          advertiser_id?: string
          advertiser_name?: string | null
          logo_url?: string | null
          program_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      cj_deals: {
        Row: {
          active: boolean
          advertiser_id: string
          advertiser_name: string | null
          category: string | null
          cj_link_id: string | null
          created_at: string
          description: string | null
          destination_url: string
          ends_at: string | null
          id: string
          image_url: string | null
          kind: string
          region: string | null
          starts_at: string | null
          terms: string | null
          title: string
          updated_at: string
          voucher_code: string | null
        }
        Insert: {
          active?: boolean
          advertiser_id: string
          advertiser_name?: string | null
          category?: string | null
          cj_link_id?: string | null
          created_at?: string
          description?: string | null
          destination_url: string
          ends_at?: string | null
          id?: string
          image_url?: string | null
          kind?: string
          region?: string | null
          starts_at?: string | null
          terms?: string | null
          title: string
          updated_at?: string
          voucher_code?: string | null
        }
        Update: {
          active?: boolean
          advertiser_id?: string
          advertiser_name?: string | null
          category?: string | null
          cj_link_id?: string | null
          created_at?: string
          description?: string | null
          destination_url?: string
          ends_at?: string | null
          id?: string
          image_url?: string | null
          kind?: string
          region?: string | null
          starts_at?: string | null
          terms?: string | null
          title?: string
          updated_at?: string
          voucher_code?: string | null
        }
        Relationships: []
      }
      event_interest: {
        Row: {
          created_at: string
          event_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_interest_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_interest_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          author_id: string | null
          category: string | null
          cover_image_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          geo: unknown
          id: string
          interested_count: number
          lat: number | null
          lng: number | null
          locality: string
          locality_label: string
          location_name: string | null
          moderation: Database["public"]["Enums"]["moderation_status"]
          starts_at: string
          status: string
          title: string
          updated_at: string
          url: string | null
          venue_id: string | null
        }
        Insert: {
          author_id?: string | null
          category?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          geo?: unknown
          id?: string
          interested_count?: number
          lat?: number | null
          lng?: number | null
          locality: string
          locality_label: string
          location_name?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          starts_at: string
          status?: string
          title: string
          updated_at?: string
          url?: string | null
          venue_id?: string | null
        }
        Update: {
          author_id?: string | null
          category?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          geo?: unknown
          id?: string
          interested_count?: number
          lat?: number | null
          lng?: number | null
          locality?: string
          locality_label?: string
          location_name?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          starts_at?: string
          status?: string
          title?: string
          updated_at?: string
          url?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      external_refs: {
        Row: {
          created_at: string
          dataset: string
          entity_id: string
          entity_type: string
          external_id: string
          id: string
          matched_at: string
          matched_by: string | null
          method: string
          score: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          dataset: string
          entity_id: string
          entity_type: string
          external_id: string
          id?: string
          matched_at?: string
          matched_by?: string | null
          method?: string
          score?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          dataset?: string
          entity_id?: string
          entity_type?: string
          external_id?: string
          id?: string
          matched_at?: string
          matched_by?: string | null
          method?: string
          score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "external_refs_matched_by_fkey"
            columns: ["matched_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean
          key: string
          updated_at: string
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          key: string
          updated_at?: string
        }
        Update: {
          description?: string | null
          enabled?: boolean
          key?: string
          updated_at?: string
        }
        Relationships: []
      }
      follows: {
        Row: {
          created_at: string
          follower_id: string
          push_enabled: boolean
          venue_id: string
        }
        Insert: {
          created_at?: string
          follower_id: string
          push_enabled?: boolean
          venue_id: string
        }
        Update: {
          created_at?: string
          follower_id?: string
          push_enabled?: boolean
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      friend_presence: {
        Row: {
          availability:
            | Database["public"]["Enums"]["presence_availability"]
            | null
          expires_at: string | null
          geo: unknown
          geo_accuracy_m: number | null
          geo_expires_at: string | null
          note: string | null
          profile_id: string
          updated_at: string
        }
        Insert: {
          availability?:
            | Database["public"]["Enums"]["presence_availability"]
            | null
          expires_at?: string | null
          geo?: unknown
          geo_accuracy_m?: number | null
          geo_expires_at?: string | null
          note?: string | null
          profile_id: string
          updated_at?: string
        }
        Update: {
          availability?:
            | Database["public"]["Enums"]["presence_availability"]
            | null
          expires_at?: string | null
          geo?: unknown
          geo_accuracy_m?: number | null
          geo_expires_at?: string | null
          note?: string | null
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "friend_presence_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          requester_id: string
          status: Database["public"]["Enums"]["friendship_status"]
          updated_at: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          requester_id: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          requester_id?: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_addressee_id_fkey"
            columns: ["addressee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fsa_establishments: {
        Row: {
          address: string | null
          business_name: string
          business_type: string | null
          created_at: string
          fhrsid: string
          id: string
          lat: number | null
          lng: number | null
          local_authority: string | null
          postcode: string | null
          rating_date: string | null
          rating_key: string | null
          rating_value: string
          raw: Json
          synced_at: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          business_name: string
          business_type?: string | null
          created_at?: string
          fhrsid: string
          id?: string
          lat?: number | null
          lng?: number | null
          local_authority?: string | null
          postcode?: string | null
          rating_date?: string | null
          rating_key?: string | null
          rating_value: string
          raw?: Json
          synced_at?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          business_name?: string
          business_type?: string | null
          created_at?: string
          fhrsid?: string
          id?: string
          lat?: number | null
          lng?: number | null
          local_authority?: string | null
          postcode?: string | null
          rating_date?: string | null
          rating_key?: string | null
          rating_value?: string
          raw?: Json
          synced_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      fsa_match_dismissals: {
        Row: {
          dismissed_at: string
          dismissed_by: string | null
          note: string | null
          venue_id: string
        }
        Insert: {
          dismissed_at?: string
          dismissed_by?: string | null
          note?: string | null
          venue_id: string
        }
        Update: {
          dismissed_at?: string
          dismissed_by?: string | null
          note?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fsa_match_dismissals_dismissed_by_fkey"
            columns: ["dismissed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fsa_match_dismissals_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      job_posts: {
        Row: {
          apply_url: string
          author_id: string | null
          channel_id: string
          created_at: string
          description: string | null
          employment_type: string | null
          expires_at: string | null
          id: string
          locality: string
          locality_label: string
          location_name: string | null
          moderation: Database["public"]["Enums"]["moderation_status"]
          salary_text: string | null
          starts_at: string | null
          status: string
          title: string
          updated_at: string
          venue_id: string | null
        }
        Insert: {
          apply_url: string
          author_id?: string | null
          channel_id: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          expires_at?: string | null
          id?: string
          locality: string
          locality_label: string
          location_name?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          salary_text?: string | null
          starts_at?: string | null
          status?: string
          title: string
          updated_at?: string
          venue_id?: string | null
        }
        Update: {
          apply_url?: string
          author_id?: string | null
          channel_id?: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          expires_at?: string | null
          id?: string
          locality?: string
          locality_label?: string
          location_name?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          salary_text?: string | null
          starts_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_posts_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_posts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      market_listings: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          lat: number | null
          lng: number | null
          locality: string | null
          mode: string
          owner_id: string
          photo_urls: Json
          price_pence: number | null
          status: string
          title: string
          updated_at: string
          views: number
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          locality?: string | null
          mode?: string
          owner_id: string
          photo_urls?: Json
          price_pence?: number | null
          status?: string
          title: string
          updated_at?: string
          views?: number
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          locality?: string | null
          mode?: string
          owner_id?: string
          photo_urls?: Json
          price_pence?: number | null
          status?: string
          title?: string
          updated_at?: string
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "market_listings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meetup_locations: {
        Row: {
          geo: unknown
          meetup_id: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          geo: unknown
          meetup_id: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          geo?: unknown
          meetup_id?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetup_locations_meetup_id_fkey"
            columns: ["meetup_id"]
            isOneToOne: false
            referencedRelation: "meetups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meetup_options: {
        Row: {
          added_by: string | null
          id: string
          meetup_id: string
          venue_id: string
        }
        Insert: {
          added_by?: string | null
          id?: string
          meetup_id: string
          venue_id: string
        }
        Update: {
          added_by?: string | null
          id?: string
          meetup_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetup_options_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_options_meetup_id_fkey"
            columns: ["meetup_id"]
            isOneToOne: false
            referencedRelation: "meetups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_options_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      meetup_votes: {
        Row: {
          meetup_id: string
          option_id: string
          voted_at: string
          voter_id: string
        }
        Insert: {
          meetup_id: string
          option_id: string
          voted_at?: string
          voter_id: string
        }
        Update: {
          meetup_id?: string
          option_id?: string
          voted_at?: string
          voter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetup_votes_meetup_id_fkey"
            columns: ["meetup_id"]
            isOneToOne: false
            referencedRelation: "meetups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_votes_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "meetup_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_votes_voter_id_fkey"
            columns: ["voter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meetups: {
        Row: {
          ended_at: string | null
          id: string
          resolved_at: string | null
          resolved_venue_id: string | null
          started_at: string
          started_by: string | null
          state: string
          thread_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          resolved_at?: string | null
          resolved_venue_id?: string | null
          started_at?: string
          started_by?: string | null
          state?: string
          thread_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          resolved_at?: string | null
          resolved_venue_id?: string | null
          started_at?: string
          started_by?: string | null
          state?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetups_resolved_venue_id_fkey"
            columns: ["resolved_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetups_started_by_fkey"
            columns: ["started_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetups_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_queue: {
        Row: {
          created_at: string
          detail: string | null
          entity_id: string
          entity_type: string
          id: string
          reason: string
          reporter_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["moderation_status"]
        }
        Insert: {
          created_at?: string
          detail?: string | null
          entity_id: string
          entity_type: string
          id?: string
          reason: string
          reporter_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
        }
        Update: {
          created_at?: string
          detail?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          reason?: string
          reporter_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "moderation_queue_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_queue_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          entity_id: string | null
          id: string
          payload: Json
          read_at: string | null
          recipient_id: string
          type: string
        }
        Insert: {
          created_at?: string
          entity_id?: string | null
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id: string
          type: string
        }
        Update: {
          created_at?: string
          entity_id?: string | null
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_redemptions: {
        Row: {
          id: string
          offer_id: string
          profile_id: string | null
          redeemed_at: string
        }
        Insert: {
          id?: string
          offer_id: string
          profile_id?: string | null
          redeemed_at?: string
        }
        Update: {
          id?: string
          offer_id?: string
          profile_id?: string | null
          redeemed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offer_redemptions_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_redemptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_saves: {
        Row: {
          created_at: string
          offer_id: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          offer_id: string
          profile_id: string
        }
        Update: {
          created_at?: string
          offer_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offer_saves_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_saves_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          code: string | null
          created_at: string
          details: string | null
          discount_pct: number | null
          ends_at: string | null
          id: string
          max_redemptions: number | null
          notify_followers: boolean
          offer_type: string | null
          post_id: string | null
          starts_at: string | null
          title: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          details?: string | null
          discount_pct?: number | null
          ends_at?: string | null
          id?: string
          max_redemptions?: number | null
          notify_followers?: boolean
          offer_type?: string | null
          post_id?: string | null
          starts_at?: string | null
          title: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          details?: string | null
          discount_pct?: number | null
          ends_at?: string | null
          id?: string
          max_redemptions?: number | null
          notify_followers?: boolean
          offer_type?: string | null
          post_id?: string | null
          starts_at?: string | null
          title?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offers_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          created_at: string
          id: string
          order_id: string
          product_id: string | null
          product_title: string
          quantity: number
          unit_price_pence: number
        }
        Insert: {
          created_at?: string
          id?: string
          order_id: string
          product_id?: string | null
          product_title: string
          quantity?: number
          unit_price_pence: number
        }
        Update: {
          created_at?: string
          id?: string
          order_id?: string
          product_id?: string | null
          product_title?: string
          quantity?: number
          unit_price_pence?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "venue_products"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          amount_pence: number
          application_fee_pence: number
          buyer_id: string | null
          channel_id: string | null
          created_at: string
          currency: string
          delivered_at: string | null
          delivery_address: Json | null
          delivery_eta_at: string | null
          delivery_fee_pence: number
          fulfilment_type: string
          id: string
          out_for_delivery_at: string | null
          product_id: string | null
          product_kind: string
          product_title: string
          quantity: number
          ready_at: string | null
          redeem_code: string | null
          referrer_profile_id: string | null
          status: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          amount_pence: number
          application_fee_pence?: number
          buyer_id?: string | null
          channel_id?: string | null
          created_at?: string
          currency?: string
          delivered_at?: string | null
          delivery_address?: Json | null
          delivery_eta_at?: string | null
          delivery_fee_pence?: number
          fulfilment_type?: string
          id?: string
          out_for_delivery_at?: string | null
          product_id?: string | null
          product_kind: string
          product_title: string
          quantity?: number
          ready_at?: string | null
          redeem_code?: string | null
          referrer_profile_id?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          amount_pence?: number
          application_fee_pence?: number
          buyer_id?: string | null
          channel_id?: string | null
          created_at?: string
          currency?: string
          delivered_at?: string | null
          delivery_address?: Json | null
          delivery_eta_at?: string | null
          delivery_fee_pence?: number
          fulfilment_type?: string
          id?: string
          out_for_delivery_at?: string | null
          product_id?: string | null
          product_kind?: string
          product_title?: string
          quantity?: number
          ready_at?: string | null
          redeem_code?: string | null
          referrer_profile_id?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_buyer_id_fkey"
            columns: ["buyer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "venue_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_referrer_profile_id_fkey"
            columns: ["referrer_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          links: Json
          locality: string | null
          logo_url: string | null
          moderation: Database["public"]["Enums"]["moderation_status"]
          name: string
          owner_id: string | null
          slug: string
          status: string
          updated_at: string
          website: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          links?: Json
          locality?: string | null
          logo_url?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          name: string
          owner_id?: string | null
          slug: string
          status?: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          links?: Json
          locality?: string | null
          logo_url?: string | null
          moderation?: Database["public"]["Enums"]["moderation_status"]
          name?: string
          owner_id?: string | null
          slug?: string
          status?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orgs_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_digest_state: {
        Row: {
          last_emailed_at: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          last_emailed_at?: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          last_emailed_at?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_digest_state_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      places_fetch_quota: {
        Row: {
          bucket: string
          calls: number
          window_start: string
        }
        Insert: {
          bucket: string
          calls?: number
          window_start: string
        }
        Update: {
          bucket?: string
          calls?: number
          window_start?: string
        }
        Relationships: []
      }
      plan_members: {
        Row: {
          accepted: boolean
          created_at: string
          plan_id: string
          profile_id: string
        }
        Insert: {
          accepted?: boolean
          created_at?: string
          plan_id: string
          profile_id: string
        }
        Update: {
          accepted?: boolean
          created_at?: string
          plan_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_members_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_venues: {
        Row: {
          added_by: string | null
          created_at: string
          plan_id: string
          position: number
          venue_id: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          plan_id: string
          position?: number
          venue_id: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          plan_id?: string
          position?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_venues_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_venues_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_venues_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          created_at: string
          header_url: string | null
          id: string
          notes: string | null
          owner_id: string
          planned_for: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          header_url?: string | null
          id?: string
          notes?: string | null
          owner_id: string
          planned_for?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          header_url?: string | null
          id?: string
          notes?: string | null
          owner_id?: string
          planned_for?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plans_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_id: string | null
          body: string | null
          comment_count: number
          created_at: string
          destinations: Database["public"]["Enums"]["post_destination"][]
          id: string
          is_draft: boolean
          kind: Database["public"]["Enums"]["post_kind"]
          like_count: number
          media: Json
          moderation: Database["public"]["Enums"]["moderation_status"]
          publish_at: string | null
          published_at: string | null
          title: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          author_id?: string | null
          body?: string | null
          comment_count?: number
          created_at?: string
          destinations?: Database["public"]["Enums"]["post_destination"][]
          id?: string
          is_draft?: boolean
          kind: Database["public"]["Enums"]["post_kind"]
          like_count?: number
          media?: Json
          moderation?: Database["public"]["Enums"]["moderation_status"]
          publish_at?: string | null
          published_at?: string | null
          title?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          author_id?: string | null
          body?: string | null
          comment_count?: number
          created_at?: string
          destinations?: Database["public"]["Enums"]["post_destination"][]
          id?: string
          is_draft?: boolean
          kind?: Database["public"]["Enums"]["post_kind"]
          like_count?: number
          media?: Json
          moderation?: Database["public"]["Enums"]["moderation_status"]
          publish_at?: string | null
          published_at?: string | null
          title?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      posts_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          post_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          post_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          post_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts_likes: {
        Row: {
          created_at: string
          liker_id: string
          post_id: string
        }
        Insert: {
          created_at?: string
          liker_id: string
          post_id: string
        }
        Update: {
          created_at?: string
          liker_id?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_likes_liker_id_fkey"
            columns: ["liker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      presence_alerts: {
        Row: {
          alerted_at: string
          from_id: string
          to_id: string
        }
        Insert: {
          alerted_at?: string
          from_id: string
          to_id: string
        }
        Update: {
          alerted_at?: string
          from_id?: string
          to_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "presence_alerts_from_id_fkey"
            columns: ["from_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presence_alerts_to_id_fkey"
            columns: ["to_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_post_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          post_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          post_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          post_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_post_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_post_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "profile_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_post_likes: {
        Row: {
          created_at: string
          liker_id: string
          post_id: string
        }
        Insert: {
          created_at?: string
          liker_id: string
          post_id: string
        }
        Update: {
          created_at?: string
          liker_id?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_post_likes_liker_id_fkey"
            columns: ["liker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_post_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "profile_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_posts: {
        Row: {
          author_id: string
          body: string | null
          comment_count: number
          created_at: string
          id: string
          like_count: number
          location: string | null
          media: Json
          moderation: Database["public"]["Enums"]["moderation_status"]
          updated_at: string
        }
        Insert: {
          author_id: string
          body?: string | null
          comment_count?: number
          created_at?: string
          id?: string
          like_count?: number
          location?: string | null
          media?: Json
          moderation?: Database["public"]["Enums"]["moderation_status"]
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string | null
          comment_count?: number
          created_at?: string
          id?: string
          like_count?: number
          location?: string | null
          media?: Json
          moderation?: Database["public"]["Enums"]["moderation_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          banned_at: string | null
          bio: string | null
          created_at: string
          display_name: string | null
          handle: string
          header_url: string | null
          home_geo: unknown
          home_layout: Json | null
          home_locality: string | null
          id: string
          invited_by: string | null
          owner_digest_opt_out: boolean
          place_prefs: Json | null
          social_links: Json
          updated_at: string
          verified_local: boolean
          wall_view_count: number
        }
        Insert: {
          avatar_url?: string | null
          banned_at?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          handle: string
          header_url?: string | null
          home_geo?: unknown
          home_layout?: Json | null
          home_locality?: string | null
          id: string
          invited_by?: string | null
          owner_digest_opt_out?: boolean
          place_prefs?: Json | null
          social_links?: Json
          updated_at?: string
          verified_local?: boolean
          wall_view_count?: number
        }
        Update: {
          avatar_url?: string | null
          banned_at?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          handle?: string
          header_url?: string | null
          home_geo?: unknown
          home_layout?: Json | null
          home_locality?: string | null
          id?: string
          invited_by?: string | null
          owner_digest_opt_out?: boolean
          place_prefs?: Json | null
          social_links?: Json
          updated_at?: string
          verified_local?: boolean
          wall_view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "profiles_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      push_credit_ledger: {
        Row: {
          created_at: string
          delta: number
          id: string
          reason: string
          ref: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string
          delta: number
          id?: string
          reason: string
          ref?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string
          delta?: number
          id?: string
          reason?: string
          ref?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_credit_ledger_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          consent: boolean
          created_at: string
          id: string
          platform: string
          profile_id: string
          token: string
        }
        Insert: {
          consent?: boolean
          created_at?: string
          id?: string
          platform: string
          profile_id: string
          token: string
        }
        Update: {
          consent?: boolean
          created_at?: string
          id?: string
          platform?: string
          profile_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_transit_stops: {
        Row: {
          created_at: string
          lat: number
          lng: number
          name: string
          profile_id: string
          stop_id: string
        }
        Insert: {
          created_at?: string
          lat: number
          lng: number
          name: string
          profile_id: string
          stop_id: string
        }
        Update: {
          created_at?: string
          lat?: number
          lng?: number
          name?: string
          profile_id?: string
          stop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_transit_stops_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_orders: {
        Row: {
          buyer_id: string | null
          created_at: string
          currency: string
          id: string
          status: string
          total_pence: number
          venue_id: string
        }
        Insert: {
          buyer_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          status?: string
          total_pence?: number
          venue_id: string
        }
        Update: {
          buyer_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          status?: string
          total_pence?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_orders_buyer_id_fkey"
            columns: ["buyer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_products: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          description: string | null
          id: string
          media: Json
          name: string
          price_pence: number | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          media?: Json
          name: string
          price_pence?: number | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          media?: Json
          name?: string
          price_pence?: number | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_products_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      town_hall_replies: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          topic_id: string
          updated_at: string
          upvote_count: number
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          topic_id: string
          updated_at?: string
          upvote_count?: number
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          topic_id?: string
          updated_at?: string
          upvote_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "town_hall_replies_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "town_hall_replies_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "town_hall_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      town_hall_reply_votes: {
        Row: {
          created_at: string
          reply_id: string
          voter_id: string
        }
        Insert: {
          created_at?: string
          reply_id: string
          voter_id: string
        }
        Update: {
          created_at?: string
          reply_id?: string
          voter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "town_hall_reply_votes_reply_id_fkey"
            columns: ["reply_id"]
            isOneToOne: false
            referencedRelation: "town_hall_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "town_hall_reply_votes_voter_id_fkey"
            columns: ["voter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      town_hall_topics: {
        Row: {
          author_id: string | null
          body: string
          category: string | null
          created_at: string
          id: string
          last_activity_at: string
          link_domain: string | null
          link_image_url: string | null
          link_title: string | null
          link_url: string | null
          locality: string
          locality_label: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          reply_count: number
          slug: string
          title: string
          updated_at: string
          upvote_count: number
        }
        Insert: {
          author_id?: string | null
          body: string
          category?: string | null
          created_at?: string
          id?: string
          last_activity_at?: string
          link_domain?: string | null
          link_image_url?: string | null
          link_title?: string | null
          link_url?: string | null
          locality: string
          locality_label: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          reply_count?: number
          slug: string
          title: string
          updated_at?: string
          upvote_count?: number
        }
        Update: {
          author_id?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          last_activity_at?: string
          link_domain?: string | null
          link_image_url?: string | null
          link_title?: string | null
          link_url?: string | null
          locality?: string
          locality_label?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          reply_count?: number
          slug?: string
          title?: string
          updated_at?: string
          upvote_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "town_hall_topics_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      town_hall_votes: {
        Row: {
          created_at: string
          topic_id: string
          voter_id: string
        }
        Insert: {
          created_at?: string
          topic_id: string
          voter_id: string
        }
        Update: {
          created_at?: string
          topic_id?: string
          voter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "town_hall_votes_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "town_hall_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "town_hall_votes_voter_id_fkey"
            columns: ["voter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_stops: {
        Row: {
          arrive_on: string | null
          geo: unknown
          id: string
          label: string | null
          position: number
          trip_id: string
          venue_id: string | null
        }
        Insert: {
          arrive_on?: string | null
          geo?: unknown
          id?: string
          label?: string | null
          position?: number
          trip_id: string
          venue_id?: string | null
        }
        Update: {
          arrive_on?: string | null
          geo?: unknown
          id?: string
          label?: string | null
          position?: number
          trip_id?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_stops_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stops_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          created_at: string
          ends_on: string | null
          id: string
          owner_id: string
          starts_on: string | null
          title: string
        }
        Insert: {
          created_at?: string
          ends_on?: string | null
          id?: string
          owner_id: string
          starts_on?: string | null
          title: string
        }
        Update: {
          created_at?: string
          ends_on?: string | null
          id?: string
          owner_id?: string
          starts_on?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_private: {
        Row: {
          birth_date: string | null
          birthday_offers_enabled: boolean
          created_at: string
          presence_alerts_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          birth_date?: string | null
          birthday_offers_enabled?: boolean
          created_at?: string
          presence_alerts_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          birth_date?: string | null
          birthday_offers_enabled?: boolean
          created_at?: string
          presence_alerts_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_private_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_activity: {
        Row: {
          actor_id: string | null
          created_at: string
          id: string
          payload: Json
          read_at: string | null
          type: string
          venue_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: string
          payload?: Json
          read_at?: string | null
          type: string
          venue_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: string
          payload?: Json
          read_at?: string | null
          type?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_activity_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_activity_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_birthday_offer: {
        Row: {
          created_at: string
          details: string | null
          enabled: boolean
          title: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          enabled?: boolean
          title?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          details?: string | null
          enabled?: boolean
          title?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_birthday_offer_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_channels: {
        Row: {
          added_by: string | null
          channel_id: string
          created_at: string
          venue_id: string
        }
        Insert: {
          added_by?: string | null
          channel_id: string
          created_at?: string
          venue_id: string
        }
        Update: {
          added_by?: string | null
          channel_id?: string
          created_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_channels_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_channels_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_channels_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_claims: {
        Row: {
          claimant_id: string
          created_at: string
          id: string
          note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["venue_claim_status"]
          updated_at: string
          venue_id: string
          verified_domain: boolean
        }
        Insert: {
          claimant_id: string
          created_at?: string
          id?: string
          note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["venue_claim_status"]
          updated_at?: string
          venue_id: string
          verified_domain?: boolean
        }
        Update: {
          claimant_id?: string
          created_at?: string
          id?: string
          note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["venue_claim_status"]
          updated_at?: string
          venue_id?: string
          verified_domain?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "venue_claims_claimant_id_fkey"
            columns: ["claimant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_claims_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_claims_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_collection_settings: {
        Row: {
          collection_instructions: string | null
          created_at: string
          order_ahead: boolean
          paused: boolean
          prep_time_mins: number
          updated_at: string
          venue_id: string
        }
        Insert: {
          collection_instructions?: string | null
          created_at?: string
          order_ahead?: boolean
          paused?: boolean
          prep_time_mins?: number
          updated_at?: string
          venue_id: string
        }
        Update: {
          collection_instructions?: string | null
          created_at?: string
          order_ahead?: boolean
          paused?: boolean
          prep_time_mins?: number
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_collection_settings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_delivery_settings: {
        Row: {
          created_at: string
          delivery_enabled: boolean
          delivery_fee_pence: number
          delivery_notes: string | null
          eta_mins: number
          min_order_pence: number
          paused: boolean
          postcode_allow: string[]
          postcode_block: string[]
          radius_m: number | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          delivery_enabled?: boolean
          delivery_fee_pence?: number
          delivery_notes?: string | null
          eta_mins?: number
          min_order_pence?: number
          paused?: boolean
          postcode_allow?: string[]
          postcode_block?: string[]
          radius_m?: number | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          delivery_enabled?: boolean
          delivery_fee_pence?: number
          delivery_notes?: string | null
          eta_mins?: number
          min_order_pence?: number
          paused?: boolean
          postcode_allow?: string[]
          postcode_block?: string[]
          radius_m?: number | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_delivery_settings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_marketing_prefs: {
        Row: {
          created_at: string
          discount_cap_pct: number | null
          offer_types: string[]
          onboarded_at: string | null
          product_notes: string | null
          suggestions_enabled: boolean
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          discount_cap_pct?: number | null
          offer_types?: string[]
          onboarded_at?: string | null
          product_notes?: string | null
          suggestions_enabled?: boolean
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          discount_cap_pct?: number | null
          offer_types?: string[]
          onboarded_at?: string | null
          product_notes?: string | null
          suggestions_enabled?: boolean
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_marketing_prefs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_payment_accounts: {
        Row: {
          charges_enabled: boolean
          country: string
          created_at: string
          details_submitted: boolean
          payouts_enabled: boolean
          stripe_account_id: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          charges_enabled?: boolean
          country?: string
          created_at?: string
          details_submitted?: boolean
          payouts_enabled?: boolean
          stripe_account_id: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          charges_enabled?: boolean
          country?: string
          created_at?: string
          details_submitted?: boolean
          payouts_enabled?: boolean
          stripe_account_id?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_payment_accounts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_photos: {
        Row: {
          alt_text: string | null
          attribution: Json | null
          created_at: string
          height: number | null
          id: string
          is_cover: boolean
          places_photo_ref: string | null
          position: number
          source: string
          storage_path: string | null
          updated_at: string
          venue_id: string
          width: number | null
        }
        Insert: {
          alt_text?: string | null
          attribution?: Json | null
          created_at?: string
          height?: number | null
          id?: string
          is_cover?: boolean
          places_photo_ref?: string | null
          position?: number
          source: string
          storage_path?: string | null
          updated_at?: string
          venue_id: string
          width?: number | null
        }
        Update: {
          alt_text?: string | null
          attribution?: Json | null
          created_at?: string
          height?: number | null
          id?: string
          is_cover?: boolean
          places_photo_ref?: string | null
          position?: number
          source?: string
          storage_path?: string | null
          updated_at?: string
          venue_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_photos_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_products: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          description: string | null
          id: string
          kind: string
          photo_url: string | null
          price_pence: number
          stock: number | null
          title: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          kind: string
          photo_url?: string | null
          price_pence: number
          stock?: number | null
          title: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          kind?: string
          photo_url?: string | null
          price_pence?: number
          stock?: number | null
          title?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_products_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_reviews: {
        Row: {
          author_id: string
          body: string | null
          created_at: string
          id: string
          moderation: Database["public"]["Enums"]["moderation_status"]
          rating: number
          updated_at: string
          venue_id: string
        }
        Insert: {
          author_id: string
          body?: string | null
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          rating: number
          updated_at?: string
          venue_id: string
        }
        Update: {
          author_id?: string
          body?: string | null
          created_at?: string
          id?: string
          moderation?: Database["public"]["Enums"]["moderation_status"]
          rating?: number
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_reviews_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_reviews_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_views: {
        Row: {
          day: string
          venue_id: string
          views: number
        }
        Insert: {
          day: string
          venue_id: string
          views?: number
        }
        Update: {
          day?: string
          venue_id?: string
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "venue_views_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string | null
          attributes: Json | null
          business_status: string | null
          categories: string[]
          category: string | null
          country_code: string | null
          created_at: string
          custom_sections: Json
          description: string | null
          details_fetched_at: string | null
          dress_code: string | null
          fetched_at: string | null
          geo: unknown
          google_photos_refreshed_at: string | null
          id: string
          lat: number | null
          links: Json
          lng: number | null
          locality: string | null
          name: string
          opening_times: Json | null
          owner_id: string | null
          phone: string | null
          price_level: string | null
          price_range: Json | null
          primary_type_label: string | null
          rating: number | null
          rating_count: number
          region: string | null
          roam_rating: number | null
          roam_rating_count: number
          slug: string
          source: string | null
          source_attribution: string | null
          source_ref: string | null
          status: Database["public"]["Enums"]["venue_status"]
          subscription_tier: Database["public"]["Enums"]["subscription_tier"]
          updated_at: string
          website_url: string | null
        }
        Insert: {
          address?: string | null
          attributes?: Json | null
          business_status?: string | null
          categories?: string[]
          category?: string | null
          country_code?: string | null
          created_at?: string
          custom_sections?: Json
          description?: string | null
          details_fetched_at?: string | null
          dress_code?: string | null
          fetched_at?: string | null
          geo: unknown
          google_photos_refreshed_at?: string | null
          id?: string
          lat?: number | null
          links?: Json
          lng?: number | null
          locality?: string | null
          name: string
          opening_times?: Json | null
          owner_id?: string | null
          phone?: string | null
          price_level?: string | null
          price_range?: Json | null
          primary_type_label?: string | null
          rating?: number | null
          rating_count?: number
          region?: string | null
          roam_rating?: number | null
          roam_rating_count?: number
          slug: string
          source?: string | null
          source_attribution?: string | null
          source_ref?: string | null
          status?: Database["public"]["Enums"]["venue_status"]
          subscription_tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          address?: string | null
          attributes?: Json | null
          business_status?: string | null
          categories?: string[]
          category?: string | null
          country_code?: string | null
          created_at?: string
          custom_sections?: Json
          description?: string | null
          details_fetched_at?: string | null
          dress_code?: string | null
          fetched_at?: string | null
          geo?: unknown
          google_photos_refreshed_at?: string | null
          id?: string
          lat?: number | null
          links?: Json
          lng?: number | null
          locality?: string | null
          name?: string
          opening_times?: Json | null
          owner_id?: string | null
          phone?: string | null
          price_level?: string | null
          price_range?: Json | null
          primary_type_label?: string | null
          rating?: number | null
          rating_count?: number
          region?: string | null
          roam_rating?: number | null
          roam_rating_count?: number
          slug?: string
          source?: string | null
          source_attribution?: string | null
          source_ref?: string | null
          status?: Database["public"]["Enums"]["venue_status"]
          subscription_tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venues_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      apply_venue_details: {
        Args: {
          p_attributes: Json
          p_business_status?: string
          p_phone: string
          p_price_range: Json
          p_venue_id: string
          p_website: string
        }
        Returns: undefined
      }
      approve_venue_claim: {
        Args: { target_claim_id: string }
        Returns: Database["public"]["CompositeTypes"]["venue_claim_approval"]
        SetofOptions: {
          from: "*"
          to: "venue_claim_approval"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      are_friends: { Args: { a: string; b: string }; Returns: boolean }
      bump_engagement_notification: {
        Args: {
          p_actor: string
          p_entity: string
          p_href: string
          p_recipient: string
          p_subject: string
          p_type: string
          p_verb: string
        }
        Returns: undefined
      }
      cast_poll_vote: {
        Args: { p_message: string; p_option: string }
        Returns: undefined
      }
      channel_members_search: {
        Args: {
          p_channel_key: string
          p_council?: string
          p_lat?: number
          p_limit?: number
          p_lng?: number
          p_offset?: number
          p_query?: string
          p_radius_m?: number
        }
        Returns: {
          council: string
          distance_m: number
          member_id: string
          name: string
          status: string
          venue_id: string
          venue_locality: string
          venue_name: string
          venue_rating: number
          venue_slug: string
        }[]
      }
      claim_channel_member_venue: {
        Args: { p_claimant_id: string; p_member_id: string; p_venue_id: string }
        Returns: Database["public"]["CompositeTypes"]["channel_member_claim_result"]
        SetofOptions: {
          from: "*"
          to: "channel_member_claim_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_nearby_alert_targets: {
        Args: { cooldown_secs?: number; radius_m?: number }
        Returns: {
          profile_id: string
        }[]
      }
      claim_places_detail_quota: {
        Args: {
          p_client_cap: number
          p_client_key: string
          p_client_window_secs: number
          p_daily_cap: number
        }
        Returns: {
          allowed: boolean
          client_used: number
          global_used: number
          reason: string
        }[]
      }
      claim_places_fetch_quota: {
        Args: {
          p_client_cap: number
          p_client_key: string
          p_client_window_secs: number
          p_daily_cap: number
        }
        Returns: {
          allowed: boolean
          client_used: number
          global_used: number
          reason: string
        }[]
      }
      close_expired_job_posts: { Args: never; Returns: number }
      close_poll: { Args: { p_message: string }; Returns: undefined }
      count_fresh_places_venues: {
        Args: {
          cat: string
          origin_lat: number
          origin_lng: number
          radius_m: number
        }
        Returns: number
      }
      create_thread_with_creator: {
        Args: { p_is_group?: boolean; p_plan_id?: string; p_title?: string }
        Returns: {
          created_at: string
          id: string
          image_path: string | null
          is_group: boolean
          plan_id: string | null
          title: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "chat_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_profile: { Args: never; Returns: string }
      deal_categories: {
        Args: { p_limit?: number }
        Returns: {
          category: string
          deal_count: number
        }[]
      }
      decrement_stock: {
        Args: { product_id_param: string; qty: number }
        Returns: {
          new_stock: number
          outcome: string
        }[]
      }
      deliver_birthday_offers: {
        Args: never
        Returns: {
          code: string
          push_ok: boolean
          title: string
          user_id: string
          venue_id: string
          venue_name: string
        }[]
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      events_near: {
        Args: {
          lat: number
          lng: number
          max_results?: number
          radius_m?: number
        }
        Returns: {
          category: string
          distance_m: number
          ends_at: string
          id: string
          interested_count: number
          locality: string
          locality_label: string
          location_name: string
          starts_at: string
          title: string
          venue_id: string
        }[]
      }
      f2g_can_post_as_member: {
        Args: { p_channel_id: string }
        Returns: boolean
      }
      f2g_can_post_supplier: { Args: never; Returns: boolean }
      f2g_member_venue_ids: {
        Args: { p_channel_id: string }
        Returns: {
          venue_id: string
        }[]
      }
      founder_badges_for_profile: {
        Args: { p_max_rank?: number; p_profile: string }
        Returns: {
          founded_at: string
          locality: string
          locality_label: string
          rank: number
        }[]
      }
      friends_availability: {
        Args: never
        Returns: {
          availability: Database["public"]["Enums"]["presence_availability"]
          avatar_url: string
          display_name: string
          expires_at: string
          handle: string
          note: string
          profile_id: string
          updated_at: string
        }[]
      }
      friends_nearby: {
        Args: { origin_lat: number; origin_lng: number; radius_m?: number }
        Returns: {
          availability: Database["public"]["Enums"]["presence_availability"]
          avatar_url: string
          display_name: string
          distance_m: number
          geo_expires_at: string
          handle: string
          lat: number
          lng: number
          note: string
          profile_id: string
          updated_at: string
        }[]
      }
      gen_unique_handle: { Args: { seed: string }; Returns: string }
      gen_unique_org_slug: {
        Args: { p_locality: string; p_name: string }
        Returns: string
      }
      gen_unique_topic_slug: {
        Args: { p_locality: string; p_title: string }
        Returns: string
      }
      gen_unique_venue_slug: {
        Args: { p_locality: string; p_name: string }
        Returns: string
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      get_or_create_direct_thread: {
        Args: { p_other: string }
        Returns: {
          created_at: string
          id: string
          image_path: string | null
          is_group: boolean
          plan_id: string | null
          title: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "chat_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_or_create_plan_thread: {
        Args: { p_plan_id: string }
        Returns: {
          created_at: string
          id: string
          image_path: string | null
          is_group: boolean
          plan_id: string | null
          title: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "chat_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      gettransactionid: { Args: never; Returns: unknown }
      in_thread: { Args: { t: string }; Returns: boolean }
      is_free_mail_host: { Args: { host: string }; Returns: boolean }
      is_non_evidence_host: { Args: { host: string }; Returns: boolean }
      is_plan_member: { Args: { p_plan: string }; Returns: boolean }
      list_google_photo_venues: {
        Args: { p_limit?: number; p_venue_id?: string }
        Returns: {
          google_photos_refreshed_at: string
          id: string
          name: string
          source_ref: string
        }[]
      }
      locality_founding_stats: {
        Args: { p_locality: string; p_viewer?: string }
        Returns: {
          contributor_count: number
          viewer_rank: number
        }[]
      }
      longtransactionsenabled: { Args: never; Returns: boolean }
      mark_thread_read: { Args: { p_thread: string }; Returns: undefined }
      mark_venue_activity_read: { Args: { p_venue: string }; Returns: number }
      moderate_ban_profile: {
        Args: { p_banned: boolean; p_user_id: string }
        Returns: undefined
      }
      moderate_revoke_claim: {
        Args: { p_venue_id: string }
        Returns: undefined
      }
      moderate_set_venue_suspended: {
        Args: { p_suspended: boolean; p_venue_id: string }
        Returns: undefined
      }
      order_channel_for_venue: {
        Args: { p_venue_id: string }
        Returns: {
          channel_id: string
          channel_key: string
          platform_fee_bps: number
        }[]
      }
      owns_plan: { Args: { p_plan: string }; Returns: boolean }
      plan_venue_suggestions: {
        Args: { max_results?: number; plan_id_param: string }
        Returns: {
          category: string
          distance_m: number
          id: string
          name: string
          primary_type_label: string
          rating: number
          rating_count: number
        }[]
      }
      poll_results: { Args: { p_message: string }; Returns: Json }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      posts_feed_near: {
        Args: {
          lat: number
          lng: number
          max_results?: number
          radius_m?: number
        }
        Returns: {
          body: string
          distance_m: number
          id: string
          kind: Database["public"]["Enums"]["post_kind"]
          media: Json
          published_at: string
          title: string
          venue_id: string
          venue_locality: string
          venue_name: string
        }[]
      }
      record_listing_view: { Args: { p_listing: string }; Returns: undefined }
      record_profile_view: { Args: { p_profile: string }; Returns: undefined }
      record_venue_view: { Args: { p_venue: string }; Returns: undefined }
      redeem_birthday_offer: { Args: { p_venue: string }; Returns: Json }
      redeem_offer: { Args: { p_offer: string }; Returns: Json }
      refresh_venue_google_photos: { Args: { payload: Json }; Returns: number }
      reject_venue_claim: {
        Args: { reason?: string; target_claim_id: string }
        Returns: Database["public"]["CompositeTypes"]["venue_claim_approval"]
        SetofOptions: {
          from: "*"
          to: "venue_claim_approval"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_venue_claim: {
        Args: { claim_note?: string; target_venue_id: string }
        Returns: {
          claimant_id: string
          created_at: string
          id: string
          note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["venue_claim_status"]
          updated_at: string
          venue_id: string
          verified_domain: boolean
        }
        SetofOptions: {
          from: "*"
          to: "venue_claims"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      search_offers: {
        Args: { max_results?: number; q: string }
        Returns: {
          locality: string
          offer_id: string
          title: string
          venue_id: string
          venue_name: string
          venue_slug: string
        }[]
      }
      send_venue_notification: {
        Args: { p_recipient?: string; p_text: string; p_venue: string }
        Returns: number
      }
      set_my_location: {
        Args: {
          p_accuracy_m?: number
          p_lat: number
          p_lng: number
          p_ttl_hours?: number
        }
        Returns: string
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      stop_my_location: { Args: never; Returns: undefined }
      suggested_friends: {
        Args: { max_results?: number }
        Returns: {
          avatar_url: string
          display_name: string
          handle: string
          id: string
          mutual_count: number
        }[]
      }
      thread_inbox: {
        Args: never
        Returns: {
          last_body: string
          last_created_at: string
          last_kind: string
          last_sender_id: string
          thread_id: string
          unread_count: number
        }[]
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      upsert_place_venues: {
        Args: { places: Json }
        Returns: {
          out_id: string
          out_source_ref: string
          out_was_claimed: boolean
        }[]
      }
      upsert_venue_photos: { Args: { payload: Json }; Returns: number }
      venue_audience_stats: { Args: { p_venue: string }; Returns: Json }
      venue_birthday_stats: { Args: { p_venue: string }; Returns: Json }
      venue_link_hosts: { Args: { target_venue_id: string }; Returns: string[] }
      venue_offer_engagement: {
        Args: { p_venue: string }
        Returns: {
          offer_type: string
          offers: number
          redemptions: number
          saves: number
        }[]
      }
      venue_review_histogram: {
        Args: { venue_id_param: string }
        Returns: {
          cnt: number
          stars: number
        }[]
      }
      venue_reviews_list: {
        Args: {
          max_results?: number
          page_offset?: number
          venue_id_param: string
        }
        Returns: {
          author_avatar: string
          author_handle: string
          author_id: string
          author_name: string
          body: string
          created_at: string
          id: string
          rating: number
          updated_at: string
        }[]
      }
      venues_food_to_go_near: {
        Args: {
          filter_channel_id?: string
          origin_lat: number
          origin_lng: number
          page_offset?: number
          page_size?: number
        }
        Returns: {
          business_status: string
          categories: string[]
          category: string
          cover_photo_id: string
          delivers: boolean
          distance_m: number
          id: string
          is_member: boolean
          lat_out: number
          lng_out: number
          name: string
          owner_id: string
          prep_time_mins: number
          price_level: string
          primary_type_label: string
          rating: number
          rating_count: number
          status: Database["public"]["Enums"]["venue_status"]
        }[]
      }
      venues_in_category_near: {
        Args: {
          filter_category: string
          origin_lat: number
          origin_lng: number
          page_offset?: number
          page_size?: number
        }
        Returns: {
          business_status: string
          categories: string[]
          category: string
          cover_photo_id: string
          distance_m: number
          id: string
          lat_out: number
          lng_out: number
          name: string
          owner_id: string
          price_level: string
          primary_type_label: string
          rating: number
          rating_count: number
          status: Database["public"]["Enums"]["venue_status"]
        }[]
      }
      venues_in_channel_near: {
        Args: {
          filter_channel_id: string
          origin_lat: number
          origin_lng: number
          page_offset?: number
          page_size?: number
        }
        Returns: {
          business_status: string
          categories: string[]
          category: string
          cover_photo_id: string
          distance_m: number
          id: string
          lat_out: number
          lng_out: number
          name: string
          owner_id: string
          prep_time_mins: number
          price_level: string
          primary_type_label: string
          rating: number
          rating_count: number
          status: Database["public"]["Enums"]["venue_status"]
        }[]
      }
      venues_near: {
        Args: { max_results?: number; origin_lat: number; origin_lng: number }
        Returns: {
          business_status: string
          categories: string[]
          category: string
          cover_photo_id: string
          distance_m: number
          id: string
          lat_out: number
          lng_out: number
          name: string
          owner_id: string
          price_level: string
          primary_type_label: string
          rating: number
          rating_count: number
          status: Database["public"]["Enums"]["venue_status"]
        }[]
      }
      venues_search_by_name: {
        Args: {
          max_results?: number
          origin_lat: number
          origin_lng: number
          q: string
        }
        Returns: {
          business_status: string
          categories: string[]
          category: string
          cover_photo_id: string
          distance_m: number
          id: string
          lat_out: number
          lng_out: number
          name: string
          owner_id: string
          price_level: string
          primary_type_label: string
          rating: number
          rating_count: number
          status: Database["public"]["Enums"]["venue_status"]
        }[]
      }
    }
    Enums: {
      friendship_status: "pending" | "accepted" | "blocked"
      moderation_status:
        | "pending"
        | "auto_approved"
        | "auto_flagged"
        | "approved"
        | "rejected"
      post_destination: "profile" | "feed" | "follower_push"
      post_kind: "news" | "offer" | "event"
      presence_availability: "free_to_meet" | "out_and_about" | "heads_down"
      subscription_tier: "free" | "premium" | "gold"
      venue_claim_status: "pending" | "approved" | "rejected"
      venue_status: "unclaimed" | "pending_claim" | "claimed" | "suspended"
    }
    CompositeTypes: {
      channel_member_claim_result: {
        member_id: string | null
        venue_id: string | null
        claimed: boolean | null
        venue_status: Database["public"]["Enums"]["venue_status"] | null
        outcome: string | null
      }
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
      venue_claim_approval: {
        claim_id: string | null
        venue_id: string | null
        verified: boolean | null
        venue_status: Database["public"]["Enums"]["venue_status"] | null
        method: string | null
      }
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
    Enums: {
      friendship_status: ["pending", "accepted", "blocked"],
      moderation_status: [
        "pending",
        "auto_approved",
        "auto_flagged",
        "approved",
        "rejected",
      ],
      post_destination: ["profile", "feed", "follower_push"],
      post_kind: ["news", "offer", "event"],
      presence_availability: ["free_to_meet", "out_and_about", "heads_down"],
      subscription_tier: ["free", "premium", "gold"],
      venue_claim_status: ["pending", "approved", "rejected"],
      venue_status: ["unclaimed", "pending_claim", "claimed", "suspended"],
    },
  },
} as const
