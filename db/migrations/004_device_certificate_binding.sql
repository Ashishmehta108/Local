ALTER TABLE devices ADD COLUMN certificate_fingerprint text;
CREATE UNIQUE INDEX devices_org_certificate_fingerprint_idx
  ON devices (organisation_id, certificate_fingerprint)
  WHERE certificate_fingerprint IS NOT NULL;

