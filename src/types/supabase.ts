// Types générés manuellement à partir du schéma DB réel (2026-04-25)
// À remplacer par `supabase gen types typescript` une fois le CLI authentifié.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      user_profile: {
        Row: {
          user_id: string;
          display_name: string | null;
          base: string;
          fonction: Database['public']['Enums']['fonction_enum'];
          regime: Database['public']['Enums']['regime_enum'];
          qualifs_avion: string[];
          instructeur: boolean;
          is_admin: boolean;
          is_scraper: boolean;
          tri_niveau: number | null;
          prime_330_count: number | null;
          valeur_jour: number;
          tmi: number;
          classe: number | null;
          categorie: string | null;
          echelon: number | null;
          bonus_atpl: boolean;
          transport: string | null;
          aircraft_principal: string | null;
          cng_pv: number | null;
          cng_hs: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['user_profile']['Row']> & {
          user_id: string;
          fonction: Database['public']['Enums']['fonction_enum'];
          regime: Database['public']['Enums']['regime_enum'];
        };
        Update: Partial<Database['public']['Tables']['user_profile']['Row']>;
        Relationships: [];
      };
      annexe_table: {
        Row: {
          slug: string;
          name: string;
          description: string | null;
          data: import('@/types/supabase').Json;
          updated_at: string;
        };
        Insert: { slug: string; name: string; description?: string | null; data: import('@/types/supabase').Json };
        Update: Partial<Database['public']['Tables']['annexe_table']['Row']>;
        Relationships: [];
      };
      planning_draft: {
        Row: {
          id: string;
          user_id: string;
          target_month: string;
          name: string;
          is_primary: boolean;
          note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['planning_draft']['Row']> & {
          user_id: string;
          target_month: string;
        };
        Update: Partial<Database['public']['Tables']['planning_draft']['Row']>;
        Relationships: [];
      };
      planning_item: {
        Row: {
          id: string;
          draft_id: string;
          kind: Database['public']['Enums']['activity_kind'];
          bid_category: Database['public']['Enums']['bid_category'] | null;
          pairing_instance_id: string | null;
          start_date: string;
          end_date: string;
          meta: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['planning_item']['Row']> & {
          draft_id: string;
          kind: Database['public']['Enums']['activity_kind'];
          start_date: string;
          end_date: string;
        };
        Update: Partial<Database['public']['Tables']['planning_item']['Row']>;
        Relationships: [];
      };
      pairing_signature: {
        Row: {
          id: string;
          snapshot_id: string;
          dead_head: boolean;
          legs_number: number;
          station_code: string;
          stopovers: string;
          layovers: number;
          first_layover: string | null;
          first_flight_number: string | null;
          aircraft_code: string;
          heure_debut: string;
          heure_fin: string;
          nb_on_days: number;
          tdv_total: number;
          hc: number;
          hcr_crew: number;
          hdv: number;
          rotation_code: string | null;
          zone: string | null;
          temps_sej: number | null;
          h2hc: number | null;
          pv_base: number | null;
          prime: number | null;
          a81: boolean | null;
          rest_before_h: number | null;
          rest_after_h: number | null;
          tsv_nuit: number | null;
          raw_detail: Json | null;
          mep_flight: string | null;
          peq: number | null;
          activity_number: string | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['pairing_signature']['Row']> & {
          snapshot_id: string;
          dead_head: boolean;
          legs_number: number;
          station_code: string;
          stopovers: string;
          layovers: number;
          aircraft_code: string;
          heure_debut: string;
          heure_fin: string;
          nb_on_days: number;
          tdv_total: number;
          hc: number;
          hcr_crew: number;
          hdv: number;
        };
        Update: Partial<Database['public']['Tables']['pairing_signature']['Row']>;
        Relationships: [];
      };
      pairing_instance: {
        Row: {
          id: string;
          signature_id: string;
          activity_id: string;
          depart_date: string;
          depart_at: string;
          arrivee_at: string;
        };
        Insert: Partial<Database['public']['Tables']['pairing_instance']['Row']> & {
          signature_id: string;
          activity_id: string;
          depart_date: string;
          depart_at: string;
          arrivee_at: string;
        };
        Update: Partial<Database['public']['Tables']['pairing_instance']['Row']>;
        Relationships: [];
      };
      scrape_snapshot: {
        Row: {
          id: string;
          scraped_by: string | null;
          target_month: string;
          started_at: string;
          finished_at: string | null;
          status: Database['public']['Enums']['snapshot_status'];
          flights_found: number | null;
          unique_signatures: number | null;
          http_requests: number | null;
          error_message: string | null;
        };
        Insert: Partial<Database['public']['Tables']['scrape_snapshot']['Row']> & {
          target_month: string;
        };
        Update: Partial<Database['public']['Tables']['scrape_snapshot']['Row']>;
        Relationships: [];
      };
      taux_app: {
        Row: {
          id: number;
          rot_code: string;
          duree_min_h: number;
          duree_max_h: number;
          taux: number;
          valid_from: string;
          valid_to: string | null;
        };
        Insert: Partial<Database['public']['Tables']['taux_app']['Row']> & {
          rot_code: string;
          duree_min_h: number;
          duree_max_h: number;
          taux: number;
        };
        Update: Partial<Database['public']['Tables']['taux_app']['Row']>;
        Relationships: [];
      };
      prorata_dda_off: {
        Row: {
          id: number;
          total_off_days: number;
          dda_off_max_days: number;
          note: string | null;
        };
        Insert: Partial<Database['public']['Tables']['prorata_dda_off']['Row']> & {
          total_off_days: number;
          dda_off_max_days: number;
        };
        Update: Partial<Database['public']['Tables']['prorata_dda_off']['Row']>;
        Relationships: [];
      };
      user_af_session: {
        Row: {
          user_id: string;
          cookie_encrypted: string;
          sn_token: string | null;
          af_user_id: string | null;
          last_refreshed_at: string;
          expires_hint: string | null;
        };
        Insert: Database['public']['Tables']['user_af_session']['Row'];
        Update: Partial<Database['public']['Tables']['user_af_session']['Row']>;
        Relationships: [];
      };
      allowed_email: {
        Row: {
          email: string;
          added_by: string | null;
          added_at: string;
          note: string | null;
        };
        Insert: { email: string; added_by?: string | null; note?: string | null };
        Update: Partial<Database['public']['Tables']['allowed_email']['Row']>;
        Relationships: [];
      };
      auth_log: {
        Row: {
          id: string;
          user_id: string | null;
          email: string;
          kind: 'signin_denied' | 'signin_requested' | 'signin_success' | 'signout' | 'db_download' | 'release_published' | 'release_downloaded';
          meta: Json | null;
          created_at: string;
        };
        Insert: {
          email: string;
          kind: 'signin_denied' | 'signin_requested' | 'signin_success' | 'signout' | 'db_download' | 'release_published' | 'release_downloaded';
          user_id?: string | null;
          meta?: Json | null;
        };
        Update: Partial<Database['public']['Tables']['auth_log']['Row']>;
        Relationships: [];
      };
      monthly_release: {
        Row: {
          id: string;
          target_month: string;
          snapshot_id: string;
          version: number;
          released_at: string;
          released_by: string | null;
          notes: string | null;
        };
        Insert: {
          target_month: string;
          snapshot_id: string;
          version: number;
          released_by?: string | null;
          notes?: string | null;
        };
        Update: Partial<Database['public']['Tables']['monthly_release']['Row']>;
        Relationships: [];
      };
      push_subscription: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
          last_seen: string;
        };
        Insert: {
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          last_seen?: string;
        };
        Update: Partial<Database['public']['Tables']['push_subscription']['Row']>;
        Relationships: [];
      };
      release_download: {
        Row: {
          id: string;
          release_id: string;
          user_id: string;
          watermark: string;
          downloaded_at: string;
          expires_at: string;
          user_agent: string | null;
        };
        Insert: {
          release_id: string;
          user_id: string;
          watermark: string;
          expires_at: string;
          user_agent?: string | null;
        };
        Update: Partial<Database['public']['Tables']['release_download']['Row']>;
        Relationships: [];
      };
    };
    Enums: {
      activity_kind: 'flight' | 'conge' | 'off' | 'sol' | 'taf' | 'medical' | 'instr';
      bid_category: 'dda_vol' | 'vol_p' | 'dda_off';
      fonction_enum: 'CDB' | 'OPL' | 'INSTR' | 'TRI_CDB' | 'TRI_OPL';
      regime_enum:
        | 'TP'
        | 'TAF7_10_12'
        | 'TAF7_12_12'
        | 'TAF10_10_12'
        | 'TAF10_12_12'
        | 'TTA92'
        | 'TTA83'
        | 'TTA75';
      snapshot_status: 'running' | 'success' | 'error';
    };
    Views: Record<string, never>;
    Functions: {
      is_email_allowed: {
        Args: { check_email: string };
        Returns: boolean;
      };
      next_release_version: {
        Args: { month: string };
        Returns: number;
      };
    };
    CompositeTypes: Record<string, never>;
  };
};

// Convenience aliases
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T];
