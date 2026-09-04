export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      audience_campaigns: {
        Row: {
          body_markdown: string;
          content: Json;
          created_at: string;
          creator_id: string;
          id: string;
          kind: string;
          list_id: string | null;
          name: string;
          preview_text: string;
          publication_id: string | null;
          public_slug: string | null;
          published_at: string | null;
          scheduled_at: string | null;
          sender_postal_address: string | null;
          sent_at: string | null;
          status: string;
          subject: string;
          template_id: string | null;
          updated_at: string;
          web_visibility: string;
        };
        Insert: {
          body_markdown: string;
          content?: Json;
          created_at?: string;
          creator_id: string;
          id?: string;
          kind?: string;
          list_id?: string | null;
          name: string;
          preview_text?: string;
          publication_id?: string | null;
          public_slug?: string | null;
          published_at?: string | null;
          scheduled_at?: string | null;
          sender_postal_address?: string | null;
          sent_at?: string | null;
          status?: string;
          subject: string;
          template_id?: string | null;
          updated_at?: string;
          web_visibility?: string;
        };
        Update: {
          body_markdown?: string;
          content?: Json;
          created_at?: string;
          creator_id?: string;
          id?: string;
          kind?: string;
          list_id?: string | null;
          name?: string;
          preview_text?: string;
          publication_id?: string | null;
          public_slug?: string | null;
          published_at?: string | null;
          scheduled_at?: string | null;
          sender_postal_address?: string | null;
          sent_at?: string | null;
          status?: string;
          subject?: string;
          template_id?: string | null;
          updated_at?: string;
          web_visibility?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audience_campaigns_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "audience_lists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audience_campaigns_publication_id_fkey";
            columns: ["publication_id"];
            isOneToOne: false;
            referencedRelation: "newsletter_publications";
            referencedColumns: ["id"];
          },
        ];
      };
      audience_lists: {
        Row: {
          created_at: string;
          creator_id: string;
          description: string;
          id: string;
          name: string;
          publication_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          creator_id: string;
          description?: string;
          id?: string;
          name: string;
          publication_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          creator_id?: string;
          description?: string;
          id?: string;
          name?: string;
          publication_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audience_lists_publication_id_fkey";
            columns: ["publication_id"];
            isOneToOne: false;
            referencedRelation: "newsletter_publications";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_events: {
        Row: {
          attempts: number;
          created_at: string;
          error_message: string | null;
          event_type: string;
          id: string;
          occurred_at: string | null;
          payload: Json;
          processed_at: string | null;
          status: string;
          updated_at: string;
          user_id: string | null;
          webhook_id: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          error_message?: string | null;
          event_type: string;
          id?: string;
          occurred_at?: string | null;
          payload: Json;
          processed_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
          webhook_id: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          error_message?: string | null;
          event_type?: string;
          id?: string;
          occurred_at?: string | null;
          payload?: Json;
          processed_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
          webhook_id?: string;
        };
        Relationships: [];
      };
      complimentary_plan_grants: {
        Row: {
          granted_at: string;
          granted_by: string | null;
          id: string;
          plan_id: string;
          expires_at: string;
          revoked_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          granted_at?: string;
          granted_by?: string | null;
          id?: string;
          plan_id: string;
          expires_at?: string;
          revoked_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          granted_at?: string;
          granted_by?: string | null;
          id?: string;
          plan_id?: string;
          expires_at?: string;
          revoked_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      block_clicks: {
        Row: {
          block_id: string;
          browser: string | null;
          city: string | null;
          country: string | null;
          created_at: string;
          device: string | null;
          event_id: string | null;
          id: string;
          referrer: string | null;
          source: string | null;
          user_agent: string | null;
          user_id: string;
          visitor_hash: string | null;
        };
        Insert: {
          block_id: string;
          browser?: string | null;
          city?: string | null;
          country?: string | null;
          created_at?: string;
          device?: string | null;
          event_id?: string | null;
          id?: string;
          referrer?: string | null;
          source?: string | null;
          user_agent?: string | null;
          user_id: string;
          visitor_hash?: string | null;
        };
        Update: {
          block_id?: string;
          browser?: string | null;
          city?: string | null;
          country?: string | null;
          created_at?: string;
          device?: string | null;
          event_id?: string | null;
          id?: string;
          referrer?: string | null;
          source?: string | null;
          user_agent?: string | null;
          user_id?: string;
          visitor_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "block_clicks_block_id_fkey";
            columns: ["block_id"];
            isOneToOne: false;
            referencedRelation: "blocks";
            referencedColumns: ["id"];
          },
        ];
      };
      blocks: {
        Row: {
          content: Json;
          cover_url: string | null;
          created_at: string;
          h: number;
          id: string;
          page_id: string | null;
          position: number;
          type: Database["public"]["Enums"]["block_type"];
          updated_at: string;
          user_id: string;
          w: number;
          x: number;
          y: number;
        };
        Insert: {
          content?: Json;
          cover_url?: string | null;
          created_at?: string;
          h?: number;
          id?: string;
          page_id?: string | null;
          position?: number;
          type: Database["public"]["Enums"]["block_type"];
          updated_at?: string;
          user_id: string;
          w?: number;
          x?: number;
          y?: number;
        };
        Update: {
          content?: Json;
          cover_url?: string | null;
          created_at?: string;
          h?: number;
          id?: string;
          page_id?: string | null;
          position?: number;
          type?: Database["public"]["Enums"]["block_type"];
          updated_at?: string;
          user_id?: string;
          w?: number;
          x?: number;
          y?: number;
        };
        Relationships: [
          {
            foreignKeyName: "blocks_page_id_fkey";
            columns: ["page_id"];
            isOneToOne: false;
            referencedRelation: "pages";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_access_grants: {
        Row: {
          buyer_email: string;
          created_at: string;
          creator_id: string;
          delivery_snapshot: Json;
          dispute_suspended_at: string | null;
          expires_at: string | null;
          id: string;
          last_accessed_at: string | null;
          member_name: string | null;
          order_id: string | null;
          product_id: string;
          source: string;
          status: Database["public"]["Enums"]["commerce_access_status"];
          token_hash: string;
          updated_at: string;
        };
        Insert: {
          buyer_email: string;
          created_at?: string;
          creator_id: string;
          delivery_snapshot?: Json;
          dispute_suspended_at?: string | null;
          expires_at?: string | null;
          id?: string;
          last_accessed_at?: string | null;
          member_name?: string | null;
          order_id?: string | null;
          product_id: string;
          source?: string;
          status?: Database["public"]["Enums"]["commerce_access_status"];
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          buyer_email?: string;
          created_at?: string;
          creator_id?: string;
          delivery_snapshot?: Json;
          dispute_suspended_at?: string | null;
          expires_at?: string | null;
          id?: string;
          last_accessed_at?: string | null;
          member_name?: string | null;
          order_id?: string | null;
          product_id?: string;
          source?: string;
          status?: Database["public"]["Enums"]["commerce_access_status"];
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_access_grants_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "commerce_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commerce_access_grants_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_affiliate_clicks: {
        Row: {
          created_at: string;
          creator_id: string;
          id: string;
          product_id: string;
          referrer: string | null;
          user_agent: string | null;
          visitor_hash: string | null;
        };
        Insert: {
          created_at?: string;
          creator_id: string;
          id?: string;
          product_id: string;
          referrer?: string | null;
          user_agent?: string | null;
          visitor_hash?: string | null;
        };
        Update: {
          created_at?: string;
          creator_id?: string;
          id?: string;
          product_id?: string;
          referrer?: string | null;
          user_agent?: string | null;
          visitor_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_affiliate_clicks_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_bookings: {
        Row: {
          buyer_email: string;
          buyer_name: string | null;
          created_at: string;
          creator_id: string;
          ends_at: string;
          id: string;
          meeting_url: string | null;
          notes: string | null;
          order_id: string | null;
          product_id: string;
          starts_at: string;
          status: string;
          timezone: string;
          updated_at: string;
        };
        Insert: {
          buyer_email: string;
          buyer_name?: string | null;
          created_at?: string;
          creator_id: string;
          ends_at: string;
          id?: string;
          meeting_url?: string | null;
          notes?: string | null;
          order_id?: string | null;
          product_id: string;
          starts_at: string;
          status?: string;
          timezone: string;
          updated_at?: string;
        };
        Update: {
          buyer_email?: string;
          buyer_name?: string | null;
          created_at?: string;
          creator_id?: string;
          ends_at?: string;
          id?: string;
          meeting_url?: string | null;
          notes?: string | null;
          order_id?: string | null;
          product_id?: string;
          starts_at?: string;
          status?: string;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_bookings_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "commerce_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commerce_bookings_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_community_comments: {
        Row: {
          access_grant_id: string | null;
          author_kind: string;
          author_name: string;
          body: string;
          created_at: string;
          creator_id: string;
          id: string;
          post_id: string;
          product_id: string;
          updated_at: string;
        };
        Insert: {
          access_grant_id?: string | null;
          author_kind: string;
          author_name: string;
          body: string;
          created_at?: string;
          creator_id: string;
          id?: string;
          post_id: string;
          product_id: string;
          updated_at?: string;
        };
        Update: {
          access_grant_id?: string | null;
          author_kind?: string;
          author_name?: string;
          body?: string;
          created_at?: string;
          creator_id?: string;
          id?: string;
          post_id?: string;
          product_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_community_comments_access_grant_id_fkey";
            columns: ["access_grant_id"];
            isOneToOne: false;
            referencedRelation: "commerce_access_grants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commerce_community_comments_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "commerce_community_posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commerce_community_comments_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_community_posts: {
        Row: {
          access_grant_id: string | null;
          author_kind: string;
          author_name: string;
          body: string;
          created_at: string;
          creator_id: string;
          id: string;
          is_pinned: boolean;
          product_id: string;
          updated_at: string;
        };
        Insert: {
          access_grant_id?: string | null;
          author_kind: string;
          author_name: string;
          body: string;
          created_at?: string;
          creator_id: string;
          id?: string;
          is_pinned?: boolean;
          product_id: string;
          updated_at?: string;
        };
        Update: {
          access_grant_id?: string | null;
          author_kind?: string;
          author_name?: string;
          body?: string;
          created_at?: string;
          creator_id?: string;
          id?: string;
          is_pinned?: boolean;
          product_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_community_posts_access_grant_id_fkey";
            columns: ["access_grant_id"];
            isOneToOne: false;
            referencedRelation: "commerce_access_grants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commerce_community_posts_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_course_lessons: {
        Row: {
          content: Json;
          content_type: string;
          created_at: string;
          creator_id: string;
          id: string;
          is_preview: boolean;
          module_title: string;
          position: number;
          product_id: string;
          summary: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          content?: Json;
          content_type?: string;
          created_at?: string;
          creator_id: string;
          id?: string;
          is_preview?: boolean;
          module_title?: string;
          position?: number;
          product_id: string;
          summary?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          content?: Json;
          content_type?: string;
          created_at?: string;
          creator_id?: string;
          id?: string;
          is_preview?: boolean;
          module_title?: string;
          position?: number;
          product_id?: string;
          summary?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_course_lessons_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_leads: {
        Row: {
          answers: Json;
          created_at: string;
          creator_id: string;
          email: string;
          id: string;
          name: string | null;
          product_id: string;
          source: string | null;
        };
        Insert: {
          answers?: Json;
          created_at?: string;
          creator_id: string;
          email: string;
          id?: string;
          name?: string | null;
          product_id: string;
          source?: string | null;
        };
        Update: {
          answers?: Json;
          created_at?: string;
          creator_id?: string;
          email?: string;
          id?: string;
          name?: string | null;
          product_id?: string;
          source?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_leads_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_orders: {
        Row: {
          attribution: Json;
          buyer_email: string;
          buyer_name: string | null;
          created_at: string;
          creator_id: string | null;
          currency: string;
          dispute_id: string | null;
          dispute_opened_at: string | null;
          dispute_reason: string | null;
          dispute_resolved_at: string | null;
          dispute_status: string | null;
          disputed_amount: number;
          gross_amount: number;
          id: string;
          metadata: Json;
          net_amount: number;
          paid_at: string | null;
          platform_fee_amount: number;
          platform_fee_bps: number;
          pre_dispute_status: Database["public"]["Enums"]["commerce_order_status"] | null;
          processor_fee_amount: number;
          product_id: string | null;
          provider: string;
          provider_checkout_id: string | null;
          provider_payment_id: string | null;
          provider_subscription_id: string | null;
          refunded_amount: number;
          status: Database["public"]["Enums"]["commerce_order_status"];
          tax_amount: number;
          updated_at: string;
        };
        Insert: {
          attribution?: Json;
          buyer_email: string;
          buyer_name?: string | null;
          created_at?: string;
          creator_id?: string | null;
          currency: string;
          dispute_id?: string | null;
          dispute_opened_at?: string | null;
          dispute_reason?: string | null;
          dispute_resolved_at?: string | null;
          dispute_status?: string | null;
          disputed_amount?: number;
          gross_amount?: number;
          id?: string;
          metadata?: Json;
          net_amount?: number;
          paid_at?: string | null;
          platform_fee_amount?: number;
          platform_fee_bps?: number;
          pre_dispute_status?: Database["public"]["Enums"]["commerce_order_status"] | null;
          processor_fee_amount?: number;
          product_id?: string | null;
          provider: string;
          provider_checkout_id?: string | null;
          provider_payment_id?: string | null;
          provider_subscription_id?: string | null;
          refunded_amount?: number;
          status?: Database["public"]["Enums"]["commerce_order_status"];
          tax_amount?: number;
          updated_at?: string;
        };
        Update: {
          attribution?: Json;
          buyer_email?: string;
          buyer_name?: string | null;
          created_at?: string;
          creator_id?: string | null;
          currency?: string;
          dispute_id?: string | null;
          dispute_opened_at?: string | null;
          dispute_reason?: string | null;
          dispute_resolved_at?: string | null;
          dispute_status?: string | null;
          disputed_amount?: number;
          gross_amount?: number;
          id?: string;
          metadata?: Json;
          net_amount?: number;
          paid_at?: string | null;
          platform_fee_amount?: number;
          platform_fee_bps?: number;
          pre_dispute_status?: Database["public"]["Enums"]["commerce_order_status"] | null;
          processor_fee_amount?: number;
          product_id?: string | null;
          provider?: string;
          provider_checkout_id?: string | null;
          provider_payment_id?: string | null;
          provider_subscription_id?: string | null;
          refunded_amount?: number;
          status?: Database["public"]["Enums"]["commerce_order_status"];
          tax_amount?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commerce_orders_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_products: {
        Row: {
          billing_interval: string | null;
          cover_url: string | null;
          created_at: string;
          creator_id: string;
          cta_label: string;
          currency: string;
          description: string;
          gallery_urls: Json;
          id: string;
          inventory_limit: number | null;
          kind: Database["public"]["Enums"]["commerce_product_kind"];
          noindex: boolean;
          price_amount: number;
          pricing_type: Database["public"]["Enums"]["commerce_pricing_type"];
          provider_price_id: string | null;
          provider_product_id: string | null;
          published_at: string | null;
          sales_count: number;
          settings: Json;
          slug: string;
          public_slug: string;
          status: Database["public"]["Enums"]["commerce_product_status"];
          subtitle: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          billing_interval?: string | null;
          cover_url?: string | null;
          created_at?: string;
          creator_id: string;
          cta_label?: string;
          currency?: string;
          description?: string;
          gallery_urls?: Json;
          id?: string;
          inventory_limit?: number | null;
          kind: Database["public"]["Enums"]["commerce_product_kind"];
          noindex?: boolean;
          price_amount?: number;
          pricing_type?: Database["public"]["Enums"]["commerce_pricing_type"];
          provider_price_id?: string | null;
          provider_product_id?: string | null;
          published_at?: string | null;
          sales_count?: number;
          settings?: Json;
          slug: string;
          public_slug: string;
          status?: Database["public"]["Enums"]["commerce_product_status"];
          subtitle?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          billing_interval?: string | null;
          cover_url?: string | null;
          created_at?: string;
          creator_id?: string;
          cta_label?: string;
          currency?: string;
          description?: string;
          gallery_urls?: Json;
          id?: string;
          inventory_limit?: number | null;
          kind?: Database["public"]["Enums"]["commerce_product_kind"];
          noindex?: boolean;
          price_amount?: number;
          pricing_type?: Database["public"]["Enums"]["commerce_pricing_type"];
          provider_price_id?: string | null;
          provider_product_id?: string | null;
          published_at?: string | null;
          sales_count?: number;
          settings?: Json;
          slug?: string;
          public_slug?: string;
          status?: Database["public"]["Enums"]["commerce_product_status"];
          subtitle?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      newsletter_publications: {
        Row: {
          accent_color: string | null;
          cover_url: string | null;
          created_at: string;
          creator_id: string;
          default_template_id: string;
          description: string;
          id: string;
          is_default: boolean;
          logo_url: string | null;
          paid_product_id: string | null;
          postal_address: string;
          published_at: string | null;
          reply_to_email: string | null;
          sender_name: string;
          slug: string;
          status: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          accent_color?: string | null;
          cover_url?: string | null;
          created_at?: string;
          creator_id: string;
          default_template_id?: string;
          description?: string;
          id?: string;
          is_default?: boolean;
          logo_url?: string | null;
          paid_product_id?: string | null;
          postal_address: string;
          published_at?: string | null;
          reply_to_email?: string | null;
          sender_name: string;
          slug: string;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          accent_color?: string | null;
          cover_url?: string | null;
          created_at?: string;
          creator_id?: string;
          default_template_id?: string;
          description?: string;
          id?: string;
          is_default?: boolean;
          logo_url?: string | null;
          paid_product_id?: string | null;
          postal_address?: string;
          published_at?: string | null;
          reply_to_email?: string | null;
          sender_name?: string;
          slug?: string;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "newsletter_publications_paid_product_id_fkey";
            columns: ["paid_product_id"];
            isOneToOne: false;
            referencedRelation: "commerce_products";
            referencedColumns: ["id"];
          },
        ];
      };
      newsletter_subscriptions: {
        Row: {
          consent_proof: Json;
          contact_id: string;
          created_at: string;
          email_enabled: boolean;
          id: string;
          publication_id: string;
          source: string;
          status: string;
          subscribed_at: string | null;
          unsubscribed_at: string | null;
          updated_at: string;
        };
        Insert: {
          consent_proof?: Json;
          contact_id: string;
          created_at?: string;
          email_enabled?: boolean;
          id?: string;
          publication_id: string;
          source: string;
          status?: string;
          subscribed_at?: string | null;
          unsubscribed_at?: string | null;
          updated_at?: string;
        };
        Update: {
          consent_proof?: Json;
          contact_id?: string;
          created_at?: string;
          email_enabled?: boolean;
          id?: string;
          publication_id?: string;
          source?: string;
          status?: string;
          subscribed_at?: string | null;
          unsubscribed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "newsletter_subscriptions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "audience_contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "newsletter_subscriptions_publication_id_fkey";
            columns: ["publication_id"];
            isOneToOne: false;
            referencedRelation: "newsletter_publications";
            referencedColumns: ["id"];
          },
        ];
      };
      commerce_webhook_events: {
        Row: {
          attempts: number;
          created_at: string;
          error_message: string | null;
          event_type: string;
          id: string;
          payload: Json;
          processed_at: string | null;
          provider: string;
          provider_event_id: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          error_message?: string | null;
          event_type: string;
          id?: string;
          payload: Json;
          processed_at?: string | null;
          provider: string;
          provider_event_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          error_message?: string | null;
          event_type?: string;
          id?: string;
          payload?: Json;
          processed_at?: string | null;
          provider?: string;
          provider_event_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      creator_payment_accounts: {
        Row: {
          access_token_ciphertext: string | null;
          charges_enabled: boolean;
          country: string | null;
          created_at: string;
          credential_fingerprint: string | null;
          credential_mode: string;
          creator_id: string;
          default_currency: string | null;
          details_submitted: boolean;
          id: string;
          onboarding_status: string;
          payouts_enabled: boolean;
          provider: string;
          provider_account_id: string | null;
          provider_metadata: Json;
          refresh_token_ciphertext: string | null;
          requirements: Json;
          scopes: string[];
          token_expires_at: string | null;
          updated_at: string;
          webhook_endpoint_id: string | null;
          webhook_secret_ciphertext: string | null;
        };
        Insert: {
          access_token_ciphertext?: string | null;
          charges_enabled?: boolean;
          country?: string | null;
          created_at?: string;
          credential_fingerprint?: string | null;
          credential_mode?: string;
          creator_id: string;
          default_currency?: string | null;
          details_submitted?: boolean;
          id?: string;
          onboarding_status?: string;
          payouts_enabled?: boolean;
          provider: string;
          provider_account_id?: string | null;
          provider_metadata?: Json;
          refresh_token_ciphertext?: string | null;
          requirements?: Json;
          scopes?: string[];
          token_expires_at?: string | null;
          updated_at?: string;
          webhook_endpoint_id?: string | null;
          webhook_secret_ciphertext?: string | null;
        };
        Update: {
          access_token_ciphertext?: string | null;
          charges_enabled?: boolean;
          country?: string | null;
          created_at?: string;
          credential_fingerprint?: string | null;
          credential_mode?: string;
          creator_id?: string;
          default_currency?: string | null;
          details_submitted?: boolean;
          id?: string;
          onboarding_status?: string;
          payouts_enabled?: boolean;
          provider?: string;
          provider_account_id?: string | null;
          provider_metadata?: Json;
          refresh_token_ciphertext?: string | null;
          requirements?: Json;
          scopes?: string[];
          token_expires_at?: string | null;
          updated_at?: string;
          webhook_endpoint_id?: string | null;
          webhook_secret_ciphertext?: string | null;
        };
        Relationships: [];
      };
      custom_domains: {
        Row: {
          cloudflare_hostname_id: string | null;
          created_at: string;
          hostname: string;
          id: string;
          last_checked_at: string | null;
          last_error: string | null;
          ssl_status: string;
          status: string;
          updated_at: string;
          user_id: string;
          verification_records: Json;
        };
        Insert: {
          cloudflare_hostname_id?: string | null;
          created_at?: string;
          hostname: string;
          id?: string;
          last_checked_at?: string | null;
          last_error?: string | null;
          ssl_status?: string;
          status?: string;
          updated_at?: string;
          user_id: string;
          verification_records?: Json;
        };
        Update: {
          cloudflare_hostname_id?: string | null;
          created_at?: string;
          hostname?: string;
          id?: string;
          last_checked_at?: string | null;
          last_error?: string | null;
          ssl_status?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
          verification_records?: Json;
        };
        Relationships: [];
      };
      pages: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          position: number;
          slug: string;
          updated_at: string;
          url: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          position?: number;
          slug: string;
          updated_at?: string;
          url?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          position?: number;
          slug?: string;
          updated_at?: string;
          url?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          checkout_session_id: string | null;
          created_at: string;
          currency: string;
          id: string;
          occurred_at: string | null;
          payment_id: string;
          payment_method: string | null;
          product_id: string | null;
          refund_status: string | null;
          settlement_amount: number | null;
          settlement_currency: string | null;
          status: string;
          subscription_id: string | null;
          tax: number | null;
          total_amount: number;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          checkout_session_id?: string | null;
          created_at?: string;
          currency: string;
          id?: string;
          occurred_at?: string | null;
          payment_id: string;
          payment_method?: string | null;
          product_id?: string | null;
          refund_status?: string | null;
          settlement_amount?: number | null;
          settlement_currency?: string | null;
          status: string;
          subscription_id?: string | null;
          tax?: number | null;
          total_amount?: number;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          checkout_session_id?: string | null;
          created_at?: string;
          currency?: string;
          id?: string;
          occurred_at?: string | null;
          payment_id?: string;
          payment_method?: string | null;
          product_id?: string | null;
          refund_status?: string | null;
          settlement_amount?: number | null;
          settlement_currency?: string | null;
          status?: string;
          subscription_id?: string | null;
          tax?: number | null;
          total_amount?: number;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      profile_views: {
        Row: {
          browser: string | null;
          city: string | null;
          country: string | null;
          created_at: string;
          device: string | null;
          event_id: string | null;
          id: string;
          referrer: string | null;
          source: string | null;
          user_agent: string | null;
          user_id: string;
          visitor_hash: string | null;
        };
        Insert: {
          browser?: string | null;
          city?: string | null;
          country?: string | null;
          created_at?: string;
          device?: string | null;
          event_id?: string | null;
          id?: string;
          referrer?: string | null;
          source?: string | null;
          user_agent?: string | null;
          user_id: string;
          visitor_hash?: string | null;
        };
        Update: {
          browser?: string | null;
          city?: string | null;
          country?: string | null;
          created_at?: string;
          device?: string | null;
          event_id?: string | null;
          id?: string;
          referrer?: string | null;
          source?: string | null;
          user_agent?: string | null;
          user_id?: string;
          visitor_hash?: string | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          accent_color: string;
          account_timezone: string | null;
          analytics_timezone: string | null;
          avatar_url: string | null;
          badge_hidden: boolean;
          bio: string;
          booking_onboarded_at: string | null;
          calendar_page_enabled: boolean;
          calendar_page_name: string;
          social_insights_enabled: boolean;
          social_insights_period_days: number;
          store_page_enabled: boolean;
          cover_url: string | null;
          created_at: string;
          display_name: string;
          explore_category: string;
          explore_opted_in_at: string | null;
          explore_review_status: string;
          explore_reviewed_at: string | null;
          explore_reviewed_by: string | null;
          font: string;
          header_mode: string;
          id: string;
          is_pro: boolean;
          meta_description: string | null;
          meta_title: string | null;
          noindex: boolean;
          onboarded: boolean;
          plan_id: string;
          pattern: string;
          pattern_settings: Json;
          primary_font: string | null;
          secondary_font: string | null;
          show_in_explore: boolean;
          theme: Database["public"]["Enums"]["theme_mode"];
          updated_at: string;
          username: string;
          username_changed_at: string | null;
        };
        Insert: {
          accent_color?: string;
          account_timezone?: string | null;
          analytics_timezone?: string | null;
          avatar_url?: string | null;
          badge_hidden?: boolean;
          bio?: string;
          booking_onboarded_at?: string | null;
          calendar_page_enabled?: boolean;
          calendar_page_name?: string;
          social_insights_enabled?: boolean;
          social_insights_period_days?: number;
          store_page_enabled?: boolean;
          cover_url?: string | null;
          created_at?: string;
          display_name?: string;
          explore_category?: string;
          explore_opted_in_at?: string | null;
          explore_review_status?: string;
          explore_reviewed_at?: string | null;
          explore_reviewed_by?: string | null;
          font?: string;
          header_mode?: string;
          id: string;
          is_pro?: boolean;
          meta_description?: string | null;
          meta_title?: string | null;
          noindex?: boolean;
          onboarded?: boolean;
          plan_id?: string;
          pattern?: string;
          pattern_settings?: Json;
          primary_font?: string | null;
          secondary_font?: string | null;
          show_in_explore?: boolean;
          theme?: Database["public"]["Enums"]["theme_mode"];
          updated_at?: string;
          username: string;
          username_changed_at?: string | null;
        };
        Update: {
          accent_color?: string;
          account_timezone?: string | null;
          analytics_timezone?: string | null;
          avatar_url?: string | null;
          badge_hidden?: boolean;
          bio?: string;
          booking_onboarded_at?: string | null;
          calendar_page_enabled?: boolean;
          calendar_page_name?: string;
          social_insights_enabled?: boolean;
          social_insights_period_days?: number;
          store_page_enabled?: boolean;
          cover_url?: string | null;
          created_at?: string;
          display_name?: string;
          explore_category?: string;
          explore_opted_in_at?: string | null;
          explore_review_status?: string;
          explore_reviewed_at?: string | null;
          explore_reviewed_by?: string | null;
          font?: string;
          header_mode?: string;
          id?: string;
          is_pro?: boolean;
          meta_description?: string | null;
          meta_title?: string | null;
          noindex?: boolean;
          onboarded?: boolean;
          plan_id?: string;
          pattern?: string;
          pattern_settings?: Json;
          primary_font?: string | null;
          secondary_font?: string | null;
          show_in_explore?: boolean;
          theme?: Database["public"]["Enums"]["theme_mode"];
          updated_at?: string;
          username?: string;
          username_changed_at?: string | null;
        };
        Relationships: [];
      };
      refunds: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          id: string;
          occurred_at: string | null;
          payment_id: string;
          reason: string | null;
          refund_id: string;
          status: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          amount?: number;
          created_at?: string;
          currency: string;
          id?: string;
          occurred_at?: string | null;
          payment_id: string;
          reason?: string | null;
          refund_id: string;
          status: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          id?: string;
          occurred_at?: string | null;
          payment_id?: string;
          reason?: string | null;
          refund_id?: string;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      social_connections: {
        Row: {
          access_token: string;
          connection_health: string;
          created_at: string;
          id: string;
          last_error: string | null;
          last_health_check_at: string | null;
          last_refreshed_at: string | null;
          last_verified_at: string | null;
          last_webhook_at: string | null;
          metadata: Json;
          provider: string;
          provider_avatar_url: string | null;
          provider_display_name: string | null;
          provider_error_code: string | null;
          provider_handle: string;
          provider_user_id: string;
          reauth_required: boolean;
          refresh_token: string | null;
          scopes: string[];
          status: string;
          token_expires_at: string | null;
          updated_at: string;
          user_id: string;
          webhook_fields: string[];
        };
        Insert: {
          access_token: string;
          connection_health?: string;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          last_health_check_at?: string | null;
          last_refreshed_at?: string | null;
          last_verified_at?: string | null;
          last_webhook_at?: string | null;
          metadata?: Json;
          provider: string;
          provider_avatar_url?: string | null;
          provider_display_name?: string | null;
          provider_error_code?: string | null;
          provider_handle: string;
          provider_user_id: string;
          reauth_required?: boolean;
          refresh_token?: string | null;
          scopes?: string[];
          status?: string;
          token_expires_at?: string | null;
          updated_at?: string;
          user_id: string;
          webhook_fields?: string[];
        };
        Update: {
          access_token?: string;
          connection_health?: string;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          last_health_check_at?: string | null;
          last_refreshed_at?: string | null;
          last_verified_at?: string | null;
          last_webhook_at?: string | null;
          metadata?: Json;
          provider?: string;
          provider_avatar_url?: string | null;
          provider_display_name?: string | null;
          provider_error_code?: string | null;
          provider_handle?: string;
          provider_user_id?: string;
          reauth_required?: boolean;
          refresh_token?: string | null;
          scopes?: string[];
          status?: string;
          token_expires_at?: string | null;
          updated_at?: string;
          user_id?: string;
          webhook_fields?: string[];
        };
        Relationships: [];
      };
      social_oauth_states: {
        Row: {
          code_verifier: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          metadata: Json;
          provider: string;
          redirect_uri: string | null;
          user_id: string;
        };
        Insert: {
          code_verifier?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          metadata?: Json;
          provider: string;
          redirect_uri?: string | null;
          user_id: string;
        };
        Update: {
          code_verifier?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          metadata?: Json;
          provider?: string;
          redirect_uri?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      social_preview_attempts: {
        Row: {
          attempt_number: number;
          browser_ms: number | null;
          created_at: string;
          duration_ms: number;
          id: number;
          outcome: string;
          platform: string;
          source: string;
          used_bright: boolean;
        };
        Insert: {
          attempt_number: number;
          browser_ms?: number | null;
          created_at?: string;
          duration_ms: number;
          id?: number;
          outcome: string;
          platform: string;
          source: string;
          used_bright?: boolean;
        };
        Update: {
          attempt_number?: number;
          browser_ms?: number | null;
          created_at?: string;
          duration_ms?: number;
          id?: number;
          outcome?: string;
          platform?: string;
          source?: string;
          used_bright?: boolean;
        };
        Relationships: [];
      };
      social_preview_budgets: {
        Row: {
          period_start: string;
          provider: string;
          updated_at: string;
          used: number;
        };
        Insert: {
          period_start: string;
          provider: string;
          updated_at?: string;
          used?: number;
        };
        Update: {
          period_start?: string;
          provider?: string;
          updated_at?: string;
          used?: number;
        };
        Relationships: [];
      };
      social_preview_cache: {
        Row: {
          cache_key: string;
          expires_at: string;
          fetched_at: string;
          handle: string;
          platform: string;
          preview: Json;
          stale_until: string;
        };
        Insert: {
          cache_key: string;
          expires_at: string;
          fetched_at?: string;
          handle: string;
          platform: string;
          preview: Json;
          stale_until: string;
        };
        Update: {
          cache_key?: string;
          expires_at?: string;
          fetched_at?: string;
          handle?: string;
          platform?: string;
          preview?: Json;
          stale_until?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          amount: number | null;
          billing_interval: string | null;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          contact_tier_contacts: number;
          created_at: string;
          currency: string | null;
          current_period_end: string | null;
          customer_id: string | null;
          dodo_subscription_id: string | null;
          id: string;
          plan_id: string;
          pending_plan_effective_at: string | null;
          pending_plan_id: string | null;
          retention_offer_expires_at: string | null;
          retention_offer_reason: string | null;
          retention_offer_redeemed_at: string | null;
          price_id: string | null;
          product_id: string | null;
          status: Database["public"]["Enums"]["subscription_status"];
          storage_addon_units: number;
          stripe_subscription_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount?: number | null;
          billing_interval?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          contact_tier_contacts?: number;
          created_at?: string;
          currency?: string | null;
          current_period_end?: string | null;
          customer_id?: string | null;
          dodo_subscription_id?: string | null;
          id?: string;
          plan_id?: string;
          pending_plan_effective_at?: string | null;
          pending_plan_id?: string | null;
          retention_offer_expires_at?: string | null;
          retention_offer_reason?: string | null;
          retention_offer_redeemed_at?: string | null;
          price_id?: string | null;
          product_id?: string | null;
          status: Database["public"]["Enums"]["subscription_status"];
          storage_addon_units?: number;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number | null;
          billing_interval?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          contact_tier_contacts?: number;
          created_at?: string;
          currency?: string | null;
          current_period_end?: string | null;
          customer_id?: string | null;
          dodo_subscription_id?: string | null;
          id?: string;
          plan_id?: string;
          pending_plan_effective_at?: string | null;
          pending_plan_id?: string | null;
          retention_offer_expires_at?: string | null;
          retention_offer_reason?: string | null;
          retention_offer_redeemed_at?: string | null;
          price_id?: string | null;
          product_id?: string | null;
          status?: Database["public"]["Enums"]["subscription_status"];
          storage_addon_units?: number;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      sitemap_products: {
        Row: {
          creator_id: string;
          creator_is_pro: boolean;
          creator_noindex: boolean;
          creator_onboarded: boolean;
          creator_plan_id: string;
          creator_username: string;
          description: string;
          id: string;
          kind: Database["public"]["Enums"]["commerce_product_kind"];
          noindex: boolean;
          public_slug: string;
          status: Database["public"]["Enums"]["commerce_product_status"];
          title: string;
          updated_at: string;
        };
        Relationships: [];
      };
      sitemap_profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          display_name: string;
          has_public_content: boolean;
          id: string;
          is_pro: boolean;
          meta_description: string | null;
          noindex: boolean;
          onboarded: boolean;
          plan_id: string;
          updated_at: string;
          username: string;
        };
        Relationships: [];
      };
    };
    Functions: {
      archive_newsletter_publication: {
        Args: {
          p_confirmation: string;
          p_creator_id: string;
          p_publication_id: string;
        };
        Returns: Database["public"]["Tables"]["newsletter_publications"]["Row"];
      };
      adjust_social_preview_budget: {
        Args: {
          p_delta: number;
          p_period_start: string;
          p_provider: string;
        };
        Returns: undefined;
      };
      claim_social_preview_budget: {
        Args: {
          p_limit: number;
          p_period_start: string;
          p_provider: string;
          p_units: number;
        };
        Returns: boolean;
      };
      set_default_newsletter_publication: {
        Args: { p_creator_id: string; p_publication_id: string };
        Returns: Database["public"]["Tables"]["newsletter_publications"]["Row"];
      };
      set_creator_account_timezone: {
        Args: {
          p_detected_timezone: string;
          p_manual_timezone: string | null;
        };
        Returns: string;
      };
      get_explore_profiles: {
        Args: {
          p_category?: string | null;
          p_limit?: number;
          p_offset?: number;
          p_query?: string;
        };
        Returns: {
          avatar_url: string | null;
          bio: string;
          display_name: string;
          explore_category: string;
          total_count: number;
          updated_at: string;
          username: string;
          visit_count: number;
        }[];
      };
      get_founder_explore_reviews: {
        Args: {
          p_limit?: number;
          p_offset?: number;
          p_queue: string;
        };
        Returns: {
          avatar_url: string | null;
          bio: string;
          display_name: string;
          email: string;
          explore_category: string;
          explore_opted_in_at: string | null;
          explore_review_status: string;
          explore_reviewed_at: string | null;
          updated_at: string | null;
          card_count: number;
          noindex: boolean;
          onboarded: boolean;
          pending_count: number;
          show_in_explore: boolean;
          total_count: number;
          user_id: string;
          username: string;
        }[];
      };
      get_founder_complimentary_plan_grants: {
        Args: Record<PropertyKey, never>;
        Returns: {
          display_name: string;
          email: string;
          expires_at: string;
          granted_at: string;
          granted_by_email: string;
          id: string;
          last_sign_in_at: string;
          plan_id: string;
          revoked_at: string;
          status: string;
          user_created_at: string;
          user_id: string;
          username: string;
        }[];
      };
      grant_complimentary_plan: {
        Args: {
          p_duration_days?: number;
          p_email: string;
          p_granted_by: string;
          p_plan_id: string;
        };
        Returns: undefined;
      };
      expire_complimentary_plan_grant: {
        Args: { p_grant_id: string };
        Returns: undefined;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      track_event: {
        Args: {
          _block_id?: string;
          _kind: string;
          _referrer?: string;
          _user_id: string;
          _visitor_hash?: string;
        };
        Returns: undefined;
      };
      revoke_complimentary_plan: {
        Args: { p_grant_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      app_role: "user" | "admin";
      block_type:
        | "social_link"
        | "generic_link"
        | "image"
        | "image_gallery"
        | "video"
        | "spotify"
        | "link_preview"
        | "map"
        | "heading"
        | "note"
        | "quote"
        | "email_capture"
        | "booking"
        | "tip_jar"
        | "contact"
        | "audio"
        | "file_download"
        | "divider"
        | "section_title"
        | "experience"
        | "commerce";
      commerce_access_status: "active" | "revoked" | "expired";
      commerce_order_status:
        "pending" | "paid" | "failed" | "refunded" | "partially_refunded" | "disputed" | "canceled";
      commerce_pricing_type: "free" | "one_time" | "subscription";
      commerce_product_kind:
        | "digital_product"
        | "coaching_call"
        | "course"
        | "webinar"
        | "paid_community"
        | "membership"
        | "custom_product"
        | "priority_dm"
        | "bundle"
        | "lead_form"
        | "bento_affiliate"
        | "newsletter";
      commerce_product_status: "draft" | "published" | "archived";
      subscription_status: "active" | "trialing" | "past_due" | "canceled" | "incomplete";
      theme_mode: "light" | "dark" | "system";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["user", "admin"],
      block_type: [
        "social_link",
        "generic_link",
        "image",
        "image_gallery",
        "video",
        "spotify",
        "link_preview",
        "map",
        "heading",
        "note",
        "quote",
        "email_capture",
        "booking",
        "tip_jar",
        "contact",
        "audio",
        "file_download",
        "divider",
        "section_title",
        "experience",
        "commerce",
      ],
      commerce_access_status: ["active", "revoked", "expired"],
      commerce_order_status: [
        "pending",
        "paid",
        "failed",
        "refunded",
        "partially_refunded",
        "disputed",
        "canceled",
      ],
      commerce_pricing_type: ["free", "one_time", "subscription"],
      commerce_product_kind: [
        "digital_product",
        "coaching_call",
        "course",
        "webinar",
        "paid_community",
        "membership",
        "custom_product",
        "priority_dm",
        "bundle",
        "lead_form",
        "bento_affiliate",
        "newsletter",
      ],
      commerce_product_status: ["draft", "published", "archived"],
      subscription_status: ["active", "trialing", "past_due", "canceled", "incomplete"],
      theme_mode: ["light", "dark", "system"],
    },
  },
} as const;
