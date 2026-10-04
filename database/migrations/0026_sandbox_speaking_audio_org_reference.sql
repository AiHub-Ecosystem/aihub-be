-- Sandbox Audio rows live outside the control plane database, so their
-- Organization IDs intentionally have no local organizations row to reference.
ALTER TABLE speaking_audio_upload_intents
  DROP CONSTRAINT IF EXISTS speaking_audio_upload_intents_organization_id_fkey;

ALTER TABLE speaking_audio_assets
  DROP CONSTRAINT IF EXISTS speaking_audio_assets_organization_id_fkey;
