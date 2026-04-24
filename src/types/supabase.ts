// Placeholder généré manuellement — à remplacer par `supabase gen types typescript`
// une fois le projet Supabase distant lié. Correspond au schéma 0001_init.sql.

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
          is_scraper: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['user_profile']['Row'],
          'created_at' | 'updated_at' | 'display_name' | 'qualifs_avion' | 'instructeur' | 'is_scraper' | 'base'
        > &
          Partial<Pick<Database['public']['Tables']['user_profile']['Row'], 'display_name' | 'qualifs_avion' | 'instructeur' | 'is_scraper' | 'base'>>;
        Update: Partial<Database['public']['Tables']['user_profile']['Row']>;
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
        Insert: Omit<
          Database['public']['Tables']['planning_draft']['Row'],
          'id' | 'created_at' | 'updated_at' | 'name' | 'is_primary' | 'note'
        > &
          Partial<Pick<Database['public']['Tables']['planning_draft']['Row'], 'id' | 'name' | 'is_primary' | 'note'>>;
        Update: Partial<Database['public']['Tables']['planning_draft']['Row']>;
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
        Insert: Omit<
          Database['public']['Tables']['planning_item']['Row'],
          'id' | 'created_at' | 'updated_at' | 'bid_category' | 'pairing_instance_id' | 'meta'
        > &
          Partial<
            Pick<
              Database['public']['Tables']['planning_item']['Row'],
              'id' | 'bid_category' | 'pairing_instance_id' | 'meta'
            >
          >;
        Update: Partial<Database['public']['Tables']['planning_item']['Row']>;
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
          raw_detail: Json | null;
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
        Insert: Omit<Database['public']['Tables']['taux_app']['Row'], 'id' | 'valid_from' | 'valid_to'> &
          Partial<Pick<Database['public']['Tables']['taux_app']['Row'], 'id' | 'valid_from' | 'valid_to'>>;
        Update: Partial<Database['public']['Tables']['taux_app']['Row']>;
      };
      prorata_dda_off: {
        Row: {
          id: number;
          total_off_days: number;
          dda_off_max_days: number;
          note: string | null;
        };
        Insert: Omit<Database['public']['Tables']['prorata_dda_off']['Row'], 'id' | 'note'> &
          Partial<Pick<Database['public']['Tables']['prorata_dda_off']['Row'], 'id' | 'note'>>;
        Update: Partial<Database['public']['Tables']['prorata_dda_off']['Row']>;
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
      };
    };
    Enums: {
      activity_kind: 'flight' | 'conge' | 'off' | 'sol' | 'taf' | 'medical' | 'instr';
      bid_category: 'dda_vol' | 'vol_p' | 'dda_off';
      fonction_enum: 'CDB' | 'OPL' | 'INSTR';
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
    Functions: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
