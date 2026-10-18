// Explicit columns for the user-scoped tables that caused the October egress spike.
// select("*") on social_content_insights also pulls media_sources jsonb.

export const BRAIN_ITEM_COLUMNS =
  "id,user_id,kind,title,content,provenance,source_url,source_ref,status,locked,tags,created_at,updated_at";

export const CONTENT_PROFILE_COLUMNS =
  "user_id,goal,niche_keywords,language,region,timezone,platform_frequencies,discover_use_brain,created_at,updated_at";

export const SOCIAL_INSIGHT_COLUMNS =
  "id,connection_id,user_id,provider,remote_post_id,remote_post_url,content_type,caption,thumbnail_url,published_at,impressions,reach,engagements,likes,comments,shares,saves,views,fetched_at";

export const CONTENT_MEDIA_IMPORT_COLUMNS =
  "id,user_id,connection_id,asset_id,provider,media_type,remote_url,attempts,import_origin";

export const SOCIAL_CONNECTION_COLUMNS =
  "id,user_id,provider,provider_user_id,provider_handle,provider_display_name,provider_avatar_url,access_token,refresh_token,token_expires_at,status,scopes,connection_health,webhook_fields,last_verified_at,last_health_check_at,last_error,reauth_required,provider_error_code,metadata,created_at,updated_at,token_refresh_lease_id,last_refreshed_at,last_webhook_at";

// ponytail: one creator does not connect more than 100 accounts. Raise with the product cap.
export const SOCIAL_CONNECTION_LIST_LIMIT = 100;
