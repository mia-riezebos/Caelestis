CREATE TABLE `access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "access_tokens_scope_check" CHECK("access_tokens"."scope" IN ('read', 'report', 'admin'))
);
--> statement-breakpoint
CREATE TABLE `applied_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`wplace_user_id` integer NOT NULL,
	`seen_at_ms` integer NOT NULL,
	CONSTRAINT "applied_events_user_check" CHECK(typeof("applied_events"."wplace_user_id") = 'integer' AND "applied_events"."wplace_user_id" >= 0)
);
--> statement-breakpoint
CREATE INDEX `applied_events_seen_at_idx` ON `applied_events` (`seen_at_ms`);--> statement-breakpoint
CREATE TABLE `contributions` (
	`wplace_user_id` integer NOT NULL,
	`template_id` text NOT NULL,
	`day_s` integer NOT NULL,
	`reported_by` text NOT NULL,
	`reported_by_user_id` integer NOT NULL,
	`placed` integer NOT NULL,
	`correct` integer NOT NULL,
	`repairs` integer NOT NULL,
	PRIMARY KEY(`wplace_user_id`, `template_id`, `day_s`, `reported_by_user_id`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "contributions_reported_by_check" CHECK(typeof("contributions"."reported_by") = 'text' AND length("contributions"."reported_by") = 64
        AND "contributions"."reported_by" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "contributions_counter_check" CHECK(typeof("contributions"."wplace_user_id") = 'integer' AND "contributions"."wplace_user_id" >= 0
        AND typeof("contributions"."reported_by_user_id") = 'integer' AND "contributions"."reported_by_user_id" >= 0
        AND typeof("contributions"."day_s") = 'integer' AND "contributions"."day_s" >= 0
        AND "contributions"."day_s" % 86400 = 0
        AND typeof("contributions"."placed") = 'integer' AND typeof("contributions"."correct") = 'integer'
        AND typeof("contributions"."repairs") = 'integer'
        AND "contributions"."repairs" >= 0
        AND "contributions"."repairs" <= "contributions"."correct" AND "contributions"."correct" <= "contributions"."placed")
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nodes_path_check" CHECK("nodes"."path" GLOB '/*' AND "nodes"."path" NOT GLOB '*[%_]*'
        AND "nodes"."path" NOT GLOB '*/' AND "nodes"."path" NOT GLOB '*//*'
        AND length("nodes"."path") BETWEEN 2 AND 256),
	CONSTRAINT "nodes_parent_not_self_check" CHECK("nodes"."parent_id" IS NULL OR "nodes"."parent_id" <> "nodes"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_path_idx` ON `nodes` (lower("path"));--> statement-breakpoint
CREATE TABLE `painters` (
	`wplace_user_id` integer PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`seen_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telemetry_buckets` (
	`template_id` text NOT NULL,
	`resolution` integer NOT NULL,
	`bucket_start_s` integer NOT NULL,
	`placed` integer NOT NULL,
	`correct` integer NOT NULL,
	`repairs` integer NOT NULL,
	PRIMARY KEY(`template_id`, `resolution`, `bucket_start_s`),
	CONSTRAINT "telemetry_buckets_resolution_check" CHECK("telemetry_buckets"."resolution" IN (60, 300, 900, 3600, 21600)),
	CONSTRAINT "telemetry_buckets_alignment_check" CHECK(typeof("telemetry_buckets"."bucket_start_s") = 'integer' AND "telemetry_buckets"."bucket_start_s" >= 0
        AND "telemetry_buckets"."bucket_start_s" % "telemetry_buckets"."resolution" = 0),
	CONSTRAINT "telemetry_buckets_counter_check" CHECK(typeof("telemetry_buckets"."placed") = 'integer' AND typeof("telemetry_buckets"."correct") = 'integer'
        AND typeof("telemetry_buckets"."repairs") = 'integer'
        AND "telemetry_buckets"."repairs" >= 0
        AND "telemetry_buckets"."repairs" <= "telemetry_buckets"."correct" AND "telemetry_buckets"."correct" <= "telemetry_buckets"."placed")
);
--> statement-breakpoint
CREATE TABLE `template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_by_user_id` integer,
	`min_x` integer NOT NULL,
	`min_y` integer NOT NULL,
	`max_x` integer NOT NULL,
	`max_y` integer NOT NULL,
	`total_pixels` integer NOT NULL,
	`bounds_north` real,
	`bounds_south` real,
	`bounds_west` real,
	`bounds_east` real,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "template_versions_created_by_check" CHECK(typeof("template_versions"."created_by") = 'text' AND length("template_versions"."created_by") = 64
        AND "template_versions"."created_by" NOT GLOB '*[^0-9a-f]*'
        AND ("template_versions"."created_by_user_id" IS NULL
          OR (typeof("template_versions"."created_by_user_id") = 'integer' AND "template_versions"."created_by_user_id" >= 0))),
	CONSTRAINT "template_versions_bounds_all_or_none_check" CHECK(("template_versions"."bounds_north" IS NULL AND "template_versions"."bounds_south" IS NULL AND "template_versions"."bounds_west" IS NULL AND "template_versions"."bounds_east" IS NULL) OR ("template_versions"."bounds_north" IS NOT NULL AND "template_versions"."bounds_south" IS NOT NULL AND "template_versions"."bounds_west" IS NOT NULL AND "template_versions"."bounds_east" IS NOT NULL)),
	CONSTRAINT "template_versions_pixel_bounds_check" CHECK(typeof("template_versions"."min_x") = 'integer' AND typeof("template_versions"."min_y") = 'integer'
        AND typeof("template_versions"."max_x") = 'integer' AND typeof("template_versions"."max_y") = 'integer'
        AND typeof("template_versions"."total_pixels") = 'integer'
        AND "template_versions"."min_x" BETWEEN 0 AND 2047999
        AND "template_versions"."min_y" BETWEEN 0 AND 2047999
        AND "template_versions"."max_x" BETWEEN 1 AND 2048000
        AND "template_versions"."max_y" BETWEEN 1 AND 2048000
        AND "template_versions"."min_x" <> "template_versions"."max_x"
        AND "template_versions"."min_y" < "template_versions"."max_y"
        AND "template_versions"."total_pixels" >= 0),
	CONSTRAINT "template_versions_bounds_range_check" CHECK("template_versions"."bounds_north" IS NULL OR ("template_versions"."bounds_north" BETWEEN -90 AND 90 AND "template_versions"."bounds_south" BETWEEN -90 AND 90 AND "template_versions"."bounds_west" BETWEEN -180 AND 180 AND "template_versions"."bounds_east" BETWEEN -180 AND 180 AND "template_versions"."bounds_north" > "template_versions"."bounds_south"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_id_template_idx` ON `template_versions` (`id`,`template_id`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`name` text NOT NULL,
	`season` integer NOT NULL,
	`current_version_id` text,
	`created_by` text NOT NULL,
	`created_by_user_id` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`,`id`) REFERENCES `template_versions`(`id`,`template_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "templates_created_by_check" CHECK(typeof("templates"."created_by") = 'text' AND length("templates"."created_by") = 64
        AND "templates"."created_by" NOT GLOB '*[^0-9a-f]*'
        AND ("templates"."created_by_user_id" IS NULL
          OR (typeof("templates"."created_by_user_id") = 'integer' AND "templates"."created_by_user_id" >= 0)))
);
--> statement-breakpoint
CREATE TABLE `tile_history` (
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`resolution_s` integer NOT NULL,
	`bucket_start_s` integer NOT NULL,
	`sha256` text NOT NULL,
	`reported_by` text NOT NULL,
	`reported_by_user_id` integer NOT NULL,
	PRIMARY KEY(`tile_x`, `tile_y`, `resolution_s`, `bucket_start_s`, `sha256`, `reported_by_user_id`),
	CONSTRAINT "tile_history_resolution_s_check" CHECK("tile_history"."resolution_s" IN (0, 3600, 21600, 86400)),
	CONSTRAINT "tile_history_sha256_check" CHECK(typeof("tile_history"."sha256") = 'text' AND length("tile_history"."sha256") = 64
        AND "tile_history"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "tile_history_reported_by_check" CHECK(typeof("tile_history"."reported_by") = 'text' AND length("tile_history"."reported_by") = 64
        AND "tile_history"."reported_by" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "tile_history_reported_by_user_id_check" CHECK(typeof("tile_history"."reported_by_user_id") = 'integer' AND "tile_history"."reported_by_user_id" >= 0),
	CONSTRAINT "tile_history_bucket_start_s_check" CHECK(typeof("tile_history"."bucket_start_s") = 'integer' AND "tile_history"."bucket_start_s" >= 0
        AND ("tile_history"."resolution_s" = 0 OR "tile_history"."bucket_start_s" % "tile_history"."resolution_s" = 0)),
	CONSTRAINT "tile_history_coordinate_check" CHECK(typeof("tile_history"."tile_x") = 'integer' AND typeof("tile_history"."tile_y") = 'integer'
        AND "tile_history"."tile_x" BETWEEN 0 AND 2047
        AND "tile_history"."tile_y" BETWEEN 0 AND 2047)
);
--> statement-breakpoint
CREATE TABLE `version_tiles` (
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`version_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "version_tiles_hash_check" CHECK(typeof("version_tiles"."hash") = 'text' AND length("version_tiles"."hash") = 64
        AND "version_tiles"."hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "version_tiles_coordinate_check" CHECK(typeof("version_tiles"."tile_x") = 'integer' AND typeof("version_tiles"."tile_y") = 'integer'
        AND "version_tiles"."tile_x" BETWEEN 0 AND 2047
        AND "version_tiles"."tile_y" BETWEEN 0 AND 2047)
);
--> statement-breakpoint
CREATE INDEX `version_tiles_tile_idx` ON `version_tiles` (`tile_x`,`tile_y`);