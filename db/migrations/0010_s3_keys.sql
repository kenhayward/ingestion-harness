-- Read-only S3 keys for the publish bucket (ADR 0008). Each consumer is one SeaweedFS IAM user
-- (`lake-<id>`); SeaweedFS holds the secrets, so only metadata is stored here.
CREATE TABLE s3_consumers (
  id         uuid PRIMARY KEY,
  label      text        NOT NULL,
  user_name  text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE s3_access_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id   uuid        NOT NULL REFERENCES s3_consumers (id) ON DELETE CASCADE,
  access_key_id text        NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  rotated_from  uuid REFERENCES s3_access_keys (id) ON DELETE SET NULL
);
CREATE INDEX s3_access_keys_consumer_idx ON s3_access_keys (consumer_id);
