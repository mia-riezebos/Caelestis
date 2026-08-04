CREATE TABLE telemetry_buckets (
  template_id TEXT NOT NULL,
  resolution INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  placed INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  repairs INTEGER NOT NULL,
  PRIMARY KEY (template_id, resolution, bucket_start)
);
