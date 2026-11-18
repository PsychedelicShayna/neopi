-- Preserve spec_yaml byte-for-byte as read-only import provenance.
ALTER TABLE routines ADD COLUMN spec_toml TEXT;
