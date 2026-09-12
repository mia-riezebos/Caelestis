-- PostgreSQL baseline equivalent to the SQLite schema through 0020.
-- Native bigint/text types enforce the storage-class checks used by SQLite.

CREATE TABLE "access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"created_with_token" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "access_tokens_scope_check" CHECK("access_tokens"."scope" IN ('read', 'report', 'admin'))
);

CREATE TABLE "applied_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"wplace_user_id" bigint NOT NULL,
	"seen_at_ms" bigint NOT NULL, "accounting_json" text,
	CONSTRAINT "applied_events_user_check" CHECK(("applied_events"."wplace_user_id" IS NOT NULL) AND "applied_events"."wplace_user_id" >= 0)
);

CREATE TABLE "canvas_tiles" (
	"season" bigint NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"sha256" text NOT NULL,
	"observed_at_ms" bigint NOT NULL, "server_owned" bigint DEFAULT 0 NOT NULL, "commit_order" bigint DEFAULT 0 NOT NULL,
	PRIMARY KEY("season", "tile_x", "tile_y"),
	CONSTRAINT "canvas_tiles_season_check" CHECK(("canvas_tiles"."season" IS NOT NULL) AND "canvas_tiles"."season" >= 0),
	CONSTRAINT "canvas_tiles_coordinate_check" CHECK(("canvas_tiles"."tile_x" IS NOT NULL) AND ("canvas_tiles"."tile_y" IS NOT NULL)
        AND "canvas_tiles"."tile_x" BETWEEN 0 AND 2047
        AND "canvas_tiles"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "canvas_tiles_sha256_check" CHECK(("canvas_tiles"."sha256" IS NOT NULL) AND length("canvas_tiles"."sha256") = 64
        AND "canvas_tiles"."sha256" !~ '[^0-9a-f]')
);

CREATE TABLE "contributions" (
	"wplace_user_id" bigint NOT NULL,
	"template_id" text NOT NULL,
	"day_s" bigint NOT NULL,
	"reported_with_token" text NOT NULL,
	"reported_by_user_id" bigint NOT NULL,
	"placed" bigint NOT NULL,
	"correct" bigint NOT NULL,
	"repairs" bigint NOT NULL,
	PRIMARY KEY("wplace_user_id", "template_id", "day_s", "reported_by_user_id"),
	CONSTRAINT "contributions_reported_with_token_check" CHECK(("contributions"."reported_with_token" IS NOT NULL) AND length("contributions"."reported_with_token") = 64
        AND "contributions"."reported_with_token" !~ '[^0-9a-f]'),
	CONSTRAINT "contributions_counter_check" CHECK(("contributions"."wplace_user_id" IS NOT NULL) AND "contributions"."wplace_user_id" >= 0
        AND ("contributions"."reported_by_user_id" IS NOT NULL) AND "contributions"."reported_by_user_id" >= 0
        AND ("contributions"."day_s" IS NOT NULL) AND "contributions"."day_s" >= 0
        AND "contributions"."day_s" % 86400 = 0
        AND ("contributions"."placed" IS NOT NULL) AND ("contributions"."correct" IS NOT NULL)
        AND ("contributions"."repairs" IS NOT NULL)
        AND "contributions"."repairs" >= 0
        AND "contributions"."repairs" <= "contributions"."correct" AND "contributions"."correct" <= "contributions"."placed")
);

CREATE TABLE "node_tags" (
	"tag_id" text NOT NULL,
	"node_id" text NOT NULL,
	PRIMARY KEY("tag_id", "node_id")
);

CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"season" bigint NOT NULL,
	"surface_kind" text DEFAULT 'world' NOT NULL,
	"alliance_id" bigint,
	"parent_id" text,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"delete_token" text,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "nodes_surface_check" CHECK(("nodes"."surface_kind" = 'world' AND "nodes"."alliance_id" IS NULL)
        OR ("nodes"."surface_kind" IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND ("nodes"."alliance_id" IS NOT NULL) AND "nodes"."alliance_id" > 0)),
	CONSTRAINT "nodes_path_check" CHECK("nodes"."path" ~ '^/' AND "nodes"."path" !~ '[%_]'
        AND "nodes"."path" !~ '/$' AND "nodes"."path" !~ '//'
        AND length("nodes"."path") BETWEEN 2 AND 256),
	CONSTRAINT "nodes_parent_not_self_check" CHECK("nodes"."parent_id" IS NULL OR "nodes"."parent_id" <> "nodes"."id")
);

CREATE TABLE "painter_bucket_collection" (
	"id" bigint PRIMARY KEY NOT NULL,
	"since_s" bigint NOT NULL,
	CONSTRAINT "painter_bucket_collection_single_row_check" CHECK("painter_bucket_collection"."id" = 1)
);

CREATE TABLE "painter_telemetry_buckets" (
	"template_id" text NOT NULL,
	"wplace_user_id" bigint NOT NULL,
	"resolution" bigint NOT NULL,
	"bucket_start_s" bigint NOT NULL,
	"placed" bigint NOT NULL,
	"correct" bigint NOT NULL,
	"repairs" bigint NOT NULL,
	PRIMARY KEY("template_id", "resolution", "bucket_start_s", "wplace_user_id"),
	CONSTRAINT "painter_telemetry_buckets_resolution_check" CHECK("painter_telemetry_buckets"."resolution" IN (60, 300, 900, 3600, 21600)),
	CONSTRAINT "painter_telemetry_buckets_alignment_check" CHECK(("painter_telemetry_buckets"."bucket_start_s" IS NOT NULL) AND "painter_telemetry_buckets"."bucket_start_s" >= 0
        AND "painter_telemetry_buckets"."bucket_start_s" % "painter_telemetry_buckets"."resolution" = 0),
	CONSTRAINT "painter_telemetry_buckets_counter_check" CHECK(("painter_telemetry_buckets"."wplace_user_id" IS NOT NULL) AND "painter_telemetry_buckets"."wplace_user_id" >= 0
        AND ("painter_telemetry_buckets"."placed" IS NOT NULL) AND ("painter_telemetry_buckets"."correct" IS NOT NULL)
        AND ("painter_telemetry_buckets"."repairs" IS NOT NULL)
        AND "painter_telemetry_buckets"."repairs" >= 0
        AND "painter_telemetry_buckets"."repairs" <= "painter_telemetry_buckets"."correct" AND "painter_telemetry_buckets"."correct" <= "painter_telemetry_buckets"."placed")
);

CREATE TABLE "painters" (
	"wplace_user_id" bigint PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"seen_at_ms" bigint NOT NULL
);

CREATE TABLE "server_settings" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	CONSTRAINT "server_settings_single_row_check" CHECK("server_settings"."id" = 1)
);

CREATE TABLE "status_read_model_revisions" (
	"season" bigint PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"public_fingerprint" text NOT NULL,
	"admin_fingerprint" text NOT NULL,
	"fingerprints_dirty" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "status_read_model_revisions_values_check" CHECK(("status_read_model_revisions"."season" IS NOT NULL) AND "status_read_model_revisions"."season" >= 0
        AND ("status_read_model_revisions"."revision" IS NOT NULL) AND "status_read_model_revisions"."revision" > 0
        AND length("status_read_model_revisions"."public_fingerprint") = 64
        AND "status_read_model_revisions"."public_fingerprint" !~ '[^0-9a-f]'
        AND length("status_read_model_revisions"."admin_fingerprint") = 64
        AND "status_read_model_revisions"."admin_fingerprint" !~ '[^0-9a-f]'
        AND ("status_read_model_revisions"."fingerprints_dirty" IS NOT NULL)
        AND "status_read_model_revisions"."fingerprints_dirty" IN (0, 1))
);

CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL
);

CREATE TABLE "telemetry_buckets" (
	"template_id" text NOT NULL,
	"resolution" bigint NOT NULL,
	"bucket_start_s" bigint NOT NULL,
	"placed" bigint NOT NULL,
	"correct" bigint NOT NULL,
	"repairs" bigint NOT NULL,
	PRIMARY KEY("template_id", "resolution", "bucket_start_s"),
	CONSTRAINT "telemetry_buckets_resolution_check" CHECK("telemetry_buckets"."resolution" IN (60, 300, 900, 3600, 21600)),
	CONSTRAINT "telemetry_buckets_alignment_check" CHECK(("telemetry_buckets"."bucket_start_s" IS NOT NULL) AND "telemetry_buckets"."bucket_start_s" >= 0
        AND "telemetry_buckets"."bucket_start_s" % "telemetry_buckets"."resolution" = 0),
	CONSTRAINT "telemetry_buckets_counter_check" CHECK(("telemetry_buckets"."placed" IS NOT NULL) AND ("telemetry_buckets"."correct" IS NOT NULL)
        AND ("telemetry_buckets"."repairs" IS NOT NULL)
        AND "telemetry_buckets"."repairs" >= 0
        AND "telemetry_buckets"."repairs" <= "telemetry_buckets"."correct" AND "telemetry_buckets"."correct" <= "telemetry_buckets"."placed")
);

CREATE TABLE "template_alarm_states" (
	"template_id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"total" bigint NOT NULL,
	"peak_correct" bigint NOT NULL,
	"alarm_id" text,
	"kind" text,
	"pixels_lost" bigint,
	"first_seen_ms" bigint,
	"last_seen_ms" bigint,
	"probe_due_at_ms" bigint,
	"probe_pixels_lost" bigint,
	"evaluated_at_ms" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL, observation_revision bigint NOT NULL DEFAULT 0,
	CONSTRAINT "template_alarm_states_counter_check" CHECK(("template_alarm_states"."total" IS NOT NULL) AND "template_alarm_states"."total" >= 0
        AND ("template_alarm_states"."peak_correct" IS NOT NULL)
        AND "template_alarm_states"."peak_correct" BETWEEN 0 AND "template_alarm_states"."total"),
	CONSTRAINT "template_alarm_states_episode_check" CHECK(("template_alarm_states"."alarm_id" IS NULL AND "template_alarm_states"."kind" IS NULL AND "template_alarm_states"."pixels_lost" IS NULL
          AND "template_alarm_states"."first_seen_ms" IS NULL AND "template_alarm_states"."last_seen_ms" IS NULL
          AND "template_alarm_states"."probe_due_at_ms" IS NULL AND "template_alarm_states"."probe_pixels_lost" IS NULL)
        OR ("template_alarm_states"."alarm_id" IS NOT NULL
          AND "template_alarm_states"."kind" IN ('regression', 'sustained-griefing')
          AND ("template_alarm_states"."pixels_lost" IS NOT NULL) AND "template_alarm_states"."pixels_lost" > 0
          AND ("template_alarm_states"."first_seen_ms" IS NOT NULL)
          AND ("template_alarm_states"."last_seen_ms" IS NOT NULL)
          AND "template_alarm_states"."first_seen_ms" <= "template_alarm_states"."last_seen_ms"
          AND (("template_alarm_states"."probe_due_at_ms" IS NULL AND "template_alarm_states"."probe_pixels_lost" IS NULL)
            OR (("template_alarm_states"."probe_due_at_ms" IS NOT NULL)
              AND ("template_alarm_states"."probe_pixels_lost" IS NOT NULL)
              AND "template_alarm_states"."probe_pixels_lost" > 0))))
);

CREATE TABLE "template_alarm_tile_statuses" (
	"template_id" text NOT NULL,
	"version_id" text NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"correct" bigint NOT NULL,
	"wrong" bigint NOT NULL,
	"blank" bigint NOT NULL,
	"colours_json" text NOT NULL,
	"observed_at_ms" bigint NOT NULL,
	PRIMARY KEY("template_id", "version_id", "tile_x", "tile_y"),
	CONSTRAINT "template_alarm_tile_statuses_coordinate_check" CHECK(("template_alarm_tile_statuses"."tile_x" IS NOT NULL) AND ("template_alarm_tile_statuses"."tile_y" IS NOT NULL)
        AND "template_alarm_tile_statuses"."tile_x" BETWEEN 0 AND 2047
        AND "template_alarm_tile_statuses"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "template_alarm_tile_statuses_counter_check" CHECK(("template_alarm_tile_statuses"."correct" IS NOT NULL) AND ("template_alarm_tile_statuses"."wrong" IS NOT NULL)
        AND ("template_alarm_tile_statuses"."blank" IS NOT NULL)
        AND "template_alarm_tile_statuses"."correct" >= 0 AND "template_alarm_tile_statuses"."wrong" >= 0 AND "template_alarm_tile_statuses"."blank" >= 0)
);

CREATE TABLE "template_tags" (
	"tag_id" text NOT NULL,
	"template_id" text NOT NULL,
	PRIMARY KEY("tag_id", "template_id")
);

CREATE TABLE "template_tile_measurements" (
	"version_id" text NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"sha256" text NOT NULL,
	"correct" bigint NOT NULL,
	"wrong" bigint NOT NULL,
	"blank" bigint NOT NULL,
	PRIMARY KEY("version_id", "tile_x", "tile_y", "sha256"),
	CONSTRAINT "template_tile_measurements_counts_check" CHECK("template_tile_measurements"."correct" >= 0 AND "template_tile_measurements"."wrong" >= 0 AND "template_tile_measurements"."blank" >= 0)
);

CREATE TABLE "template_tile_statuses" (
	"template_id" text NOT NULL,
	"version_id" text NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"correct" bigint NOT NULL,
	"wrong" bigint NOT NULL,
	"blank" bigint NOT NULL,
	"colours_json" text NOT NULL,
	"observed_at_ms" bigint NOT NULL, "server_owned" bigint DEFAULT 0 NOT NULL,
	PRIMARY KEY("template_id", "version_id", "tile_x", "tile_y"),
	CONSTRAINT "template_tile_statuses_coordinate_check" CHECK(("template_tile_statuses"."tile_x" IS NOT NULL) AND ("template_tile_statuses"."tile_y" IS NOT NULL)
        AND "template_tile_statuses"."tile_x" BETWEEN 0 AND 2047
        AND "template_tile_statuses"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "template_tile_statuses_counter_check" CHECK(("template_tile_statuses"."correct" IS NOT NULL) AND ("template_tile_statuses"."wrong" IS NOT NULL)
        AND ("template_tile_statuses"."blank" IS NOT NULL)
        AND "template_tile_statuses"."correct" >= 0 AND "template_tile_statuses"."wrong" >= 0 AND "template_tile_statuses"."blank" >= 0)
);

CREATE TABLE "template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"created_with_token" text NOT NULL,
	"created_by_user_id" bigint,
	"min_x" bigint NOT NULL,
	"min_y" bigint NOT NULL,
	"max_x" bigint NOT NULL,
	"max_y" bigint NOT NULL,
	"total_pixels" bigint NOT NULL,
	"colour_totals_json" text,
	"bounds_north" double precision,
	"bounds_south" double precision,
	"bounds_west" double precision,
	"bounds_east" double precision,
	CONSTRAINT "template_versions_created_with_token_check" CHECK(("template_versions"."created_with_token" IS NOT NULL) AND length("template_versions"."created_with_token") = 64
        AND "template_versions"."created_with_token" !~ '[^0-9a-f]'
        AND ("template_versions"."created_by_user_id" IS NULL
          OR (("template_versions"."created_by_user_id" IS NOT NULL) AND "template_versions"."created_by_user_id" >= 0))),
	CONSTRAINT "template_versions_bounds_all_or_none_check" CHECK(("template_versions"."bounds_north" IS NULL AND "template_versions"."bounds_south" IS NULL AND "template_versions"."bounds_west" IS NULL AND "template_versions"."bounds_east" IS NULL) OR ("template_versions"."bounds_north" IS NOT NULL AND "template_versions"."bounds_south" IS NOT NULL AND "template_versions"."bounds_west" IS NOT NULL AND "template_versions"."bounds_east" IS NOT NULL)),
	CONSTRAINT "template_versions_pixel_bounds_check" CHECK(("template_versions"."min_x" IS NOT NULL) AND ("template_versions"."min_y" IS NOT NULL)
        AND ("template_versions"."max_x" IS NOT NULL) AND ("template_versions"."max_y" IS NOT NULL)
        AND ("template_versions"."total_pixels" IS NOT NULL)
        AND "template_versions"."min_x" BETWEEN -1000 AND 2047999
        AND "template_versions"."min_y" BETWEEN -1000 AND 2047999
        AND "template_versions"."max_x" BETWEEN -999 AND 2048000
        AND "template_versions"."max_y" BETWEEN -999 AND 2048000
        AND "template_versions"."min_x" <> "template_versions"."max_x"
        AND "template_versions"."min_y" < "template_versions"."max_y"
        AND "template_versions"."total_pixels" >= 0),
	CONSTRAINT "template_versions_bounds_range_check" CHECK("template_versions"."bounds_north" IS NULL OR ("template_versions"."bounds_north" BETWEEN -90 AND 90 AND "template_versions"."bounds_south" BETWEEN -90 AND 90 AND "template_versions"."bounds_west" BETWEEN -180 AND 180 AND "template_versions"."bounds_east" BETWEEN -180 AND 180 AND "template_versions"."bounds_north" > "template_versions"."bounds_south"))
);

CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"season" bigint NOT NULL,
	"surface_kind" text DEFAULT 'world' NOT NULL,
	"alliance_id" bigint,
	"node_id" text,
	"name" text NOT NULL,
	"current_version_id" text,
	"published_at" bigint,
	"timelapse_frozen_at_ms" bigint,
	"finished_at_ms" bigint,
	"created_with_token" text NOT NULL,
	"created_by_user_id" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	CONSTRAINT "templates_surface_check" CHECK(("templates"."surface_kind" = 'world' AND "templates"."alliance_id" IS NULL)
        OR ("templates"."surface_kind" IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND ("templates"."alliance_id" IS NOT NULL) AND "templates"."alliance_id" > 0)),
	CONSTRAINT "templates_created_with_token_check" CHECK(("templates"."created_with_token" IS NOT NULL) AND length("templates"."created_with_token") = 64
        AND "templates"."created_with_token" !~ '[^0-9a-f]'
        AND ("templates"."created_by_user_id" IS NULL
          OR (("templates"."created_by_user_id" IS NOT NULL) AND "templates"."created_by_user_id" >= 0)))
);

CREATE TABLE "tile_blob_gc_state" (
	"id" bigint PRIMARY KEY NOT NULL,
	"cursor" text,
	"completed_sweeps" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tile_blob_gc_state_single_row_check" CHECK("tile_blob_gc_state"."id" = 1),
	CONSTRAINT "tile_blob_gc_state_sweeps_check" CHECK(("tile_blob_gc_state"."completed_sweeps" IS NOT NULL) AND "tile_blob_gc_state"."completed_sweeps" >= 0)
);

CREATE TABLE "tile_blob_objects" (
	"blob_key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"state" text NOT NULL,
	"discovered_at_ms" bigint NOT NULL,
	"delete_started_at_ms" bigint,
	"delete_attempts" bigint DEFAULT 0 NOT NULL,
	"reclaimed_at_ms" bigint,
	CONSTRAINT "tile_blob_objects_sha256_check" CHECK(("tile_blob_objects"."sha256" IS NOT NULL) AND length("tile_blob_objects"."sha256") = 64
        AND "tile_blob_objects"."sha256" !~ '[^0-9a-f]'),
	CONSTRAINT "tile_blob_objects_key_check" CHECK("tile_blob_objects"."blob_key" = "tile_blob_objects"."sha256" OR substr("tile_blob_objects"."blob_key", 1, length("tile_blob_objects"."sha256") + 1) = "tile_blob_objects"."sha256" || '/'),
	CONSTRAINT "tile_blob_objects_state_check" CHECK("tile_blob_objects"."state" IN ('uploading', 'active', 'candidate', 'deleting', 'deleted')),
	CONSTRAINT "tile_blob_objects_attempts_check" CHECK(("tile_blob_objects"."delete_attempts" IS NOT NULL) AND "tile_blob_objects"."delete_attempts" >= 0)
);

CREATE TABLE "tile_blob_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"blob_key" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	CONSTRAINT "tile_blob_reservations_sha256_check" CHECK(("tile_blob_reservations"."sha256" IS NOT NULL) AND length("tile_blob_reservations"."sha256") = 64
        AND "tile_blob_reservations"."sha256" !~ '[^0-9a-f]')
);

CREATE TABLE "tile_history" (
	"season" bigint NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"resolution_s" bigint NOT NULL,
	"bucket_start_s" bigint NOT NULL,
	"sha256" text NOT NULL,
	"reported_with_token" text NOT NULL,
	"reported_by_user_id" bigint NOT NULL,
	PRIMARY KEY("season", "tile_x", "tile_y", "resolution_s", "bucket_start_s", "sha256", "reported_by_user_id"),
	CONSTRAINT "tile_history_resolution_s_check" CHECK("tile_history"."resolution_s" IN (0, 3600, 21600, 86400)),
	CONSTRAINT "tile_history_season_check" CHECK(("tile_history"."season" IS NOT NULL) AND "tile_history"."season" >= 0),
	CONSTRAINT "tile_history_sha256_check" CHECK(("tile_history"."sha256" IS NOT NULL) AND length("tile_history"."sha256") = 64
        AND "tile_history"."sha256" !~ '[^0-9a-f]'),
	CONSTRAINT "tile_history_reported_with_token_check" CHECK(("tile_history"."reported_with_token" IS NOT NULL) AND length("tile_history"."reported_with_token") = 64
        AND "tile_history"."reported_with_token" !~ '[^0-9a-f]'),
	CONSTRAINT "tile_history_reported_by_user_id_check" CHECK(("tile_history"."reported_by_user_id" IS NOT NULL) AND "tile_history"."reported_by_user_id" >= 0),
	CONSTRAINT "tile_history_bucket_start_s_check" CHECK(("tile_history"."bucket_start_s" IS NOT NULL) AND "tile_history"."bucket_start_s" >= 0
        AND ("tile_history"."resolution_s" = 0 OR "tile_history"."bucket_start_s" % "tile_history"."resolution_s" = 0)),
	CONSTRAINT "tile_history_coordinate_check" CHECK(("tile_history"."tile_x" IS NOT NULL) AND ("tile_history"."tile_y" IS NOT NULL)
        AND "tile_history"."tile_x" BETWEEN 0 AND 2047
        AND "tile_history"."tile_y" BETWEEN 0 AND 2047)
);

CREATE TABLE "version_tiles" (
	"version_id" text NOT NULL,
	"tile_x" bigint NOT NULL,
	"tile_y" bigint NOT NULL,
	"hash" text NOT NULL,
	PRIMARY KEY("version_id", "tile_x", "tile_y"),
	CONSTRAINT "version_tiles_hash_check" CHECK(("version_tiles"."hash" IS NOT NULL) AND length("version_tiles"."hash") = 64
        AND "version_tiles"."hash" !~ '[^0-9a-f]'),
	CONSTRAINT "version_tiles_coordinate_check" CHECK(("version_tiles"."tile_x" IS NOT NULL) AND ("version_tiles"."tile_y" IS NOT NULL)
        AND "version_tiles"."tile_x" BETWEEN -1 AND 2047
        AND "version_tiles"."tile_y" BETWEEN -1 AND 2047)
);

CREATE TABLE "work_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "work_activity_data_check" CHECK(("work_activity"."data"::jsonb IS NOT NULL))
);

CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"season" bigint NOT NULL,
	"surface_kind" text NOT NULL,
	"alliance_id" bigint,
	"revision" bigint NOT NULL,
	"mutation_id" text NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "work_items_revision_check" CHECK("work_items"."revision" > 0),
	CONSTRAINT "work_items_data_check" CHECK(("work_items"."data"::jsonb IS NOT NULL))
);

CREATE INDEX "applied_events_seen_at_idx" ON "applied_events" ("seen_at_ms");

CREATE INDEX "canvas_tiles_sha256_idx" ON "canvas_tiles" ("sha256");

CREATE INDEX "node_tags_node_idx" ON "node_tags" ("node_id");

CREATE UNIQUE INDEX "nodes_alliance_surface_path_idx" ON "nodes" ("season","surface_kind","alliance_id",lower("path")) WHERE "nodes"."surface_kind" <> 'world';

CREATE UNIQUE INDEX "nodes_world_path_idx" ON "nodes" ("season",lower("path")) WHERE "nodes"."surface_kind" = 'world';

CREATE UNIQUE INDEX "tags_name_key_unique" ON "tags" ("name_key");

CREATE INDEX "template_alarm_states_probe_due_idx" ON "template_alarm_states" ("probe_due_at_ms");

CREATE INDEX "template_alarm_tile_statuses_version_idx" ON "template_alarm_tile_statuses" ("version_id");

CREATE INDEX "template_tags_template_idx" ON "template_tags" ("template_id");

CREATE INDEX "template_tile_measurements_hash_idx" ON "template_tile_measurements" ("sha256");

CREATE INDEX "template_tile_statuses_version_idx" ON "template_tile_statuses" ("version_id");

CREATE UNIQUE INDEX "template_versions_id_template_idx" ON "template_versions" ("id","template_id");

CREATE INDEX "templates_surface_idx" ON "templates" ("season","surface_kind","alliance_id");

CREATE INDEX "tile_blob_objects_hash_state_idx" ON "tile_blob_objects" ("sha256","state");

CREATE INDEX "tile_blob_reservations_hash_expiry_idx" ON "tile_blob_reservations" ("sha256","expires_at_ms");

CREATE INDEX "tile_history_sha256_idx" ON "tile_history" ("sha256");

CREATE INDEX "version_tiles_tile_idx" ON "version_tiles" ("tile_x","tile_y");

CREATE UNIQUE INDEX "work_activity_revision_idx" ON "work_activity" ("item_id","revision");

CREATE INDEX "work_items_scope_idx" ON "work_items" ("season","surface_kind","alliance_id");

INSERT INTO painter_bucket_collection (id, since_s) VALUES (1, floor(extract(epoch FROM current_timestamp))::bigint);

ALTER TABLE "contributions" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "node_tags" ADD FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "node_tags" ADD FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "nodes" ADD FOREIGN KEY ("parent_id") REFERENCES "nodes"("id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "template_alarm_states" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_alarm_tile_statuses" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_alarm_tile_statuses" ADD FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_tags" ADD FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_tags" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_tile_measurements" ADD FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_tile_statuses" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_tile_statuses" ADD FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "template_versions" ADD FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "templates" ADD FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "templates" ADD FOREIGN KEY ("current_version_id","id") REFERENCES "template_versions"("id","template_id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "tile_blob_reservations" ADD FOREIGN KEY ("blob_key") REFERENCES "tile_blob_objects"("blob_key") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "version_tiles" ADD FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON UPDATE no action ON DELETE no action;
ALTER TABLE "work_activity" ADD FOREIGN KEY ("item_id") REFERENCES "work_items"("id") ON UPDATE no action ON DELETE no action;
