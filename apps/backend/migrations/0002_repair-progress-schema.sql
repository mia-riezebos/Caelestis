ALTER TABLE `template_versions` ADD `colour_totals_json` text;
--> statement-breakpoint
CREATE TABLE `__new_tile_history` (
	`season` integer NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`resolution_s` integer NOT NULL,
	`bucket_start_s` integer NOT NULL,
	`sha256` text NOT NULL,
	`reported_with_token` text NOT NULL,
	`reported_by_user_id` integer NOT NULL,
	PRIMARY KEY(`season`, `tile_x`, `tile_y`, `resolution_s`, `bucket_start_s`, `sha256`, `reported_by_user_id`),
	CONSTRAINT "tile_history_resolution_s_check" CHECK("__new_tile_history"."resolution_s" IN (0, 3600, 21600, 86400)),
	CONSTRAINT "tile_history_season_check" CHECK(typeof("__new_tile_history"."season") = 'integer' AND "__new_tile_history"."season" >= 0),
	CONSTRAINT "tile_history_sha256_check" CHECK(typeof("__new_tile_history"."sha256") = 'text' AND length("__new_tile_history"."sha256") = 64
        AND "__new_tile_history"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "tile_history_reported_with_token_check" CHECK(typeof("__new_tile_history"."reported_with_token") = 'text' AND length("__new_tile_history"."reported_with_token") = 64
        AND "__new_tile_history"."reported_with_token" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "tile_history_reported_by_user_id_check" CHECK(typeof("__new_tile_history"."reported_by_user_id") = 'integer' AND "__new_tile_history"."reported_by_user_id" >= 0),
	CONSTRAINT "tile_history_bucket_start_s_check" CHECK(typeof("__new_tile_history"."bucket_start_s") = 'integer' AND "__new_tile_history"."bucket_start_s" >= 0
        AND ("__new_tile_history"."resolution_s" = 0 OR "__new_tile_history"."bucket_start_s" % "__new_tile_history"."resolution_s" = 0)),
	CONSTRAINT "tile_history_coordinate_check" CHECK(typeof("__new_tile_history"."tile_x") = 'integer' AND typeof("__new_tile_history"."tile_y") = 'integer'
        AND "__new_tile_history"."tile_x" BETWEEN 0 AND 2047
        AND "__new_tile_history"."tile_y" BETWEEN 0 AND 2047)
);
--> statement-breakpoint
INSERT INTO `__new_tile_history` (
	`season`,
	`tile_x`,
	`tile_y`,
	`resolution_s`,
	`bucket_start_s`,
	`sha256`,
	`reported_with_token`,
	`reported_by_user_id`
)
SELECT
	0,
	`tile_x`,
	`tile_y`,
	`resolution_s`,
	`bucket_start_s`,
	`sha256`,
	`reported_with_token`,
	`reported_by_user_id`
FROM `tile_history`;
--> statement-breakpoint
DROP TABLE `tile_history`;
--> statement-breakpoint
ALTER TABLE `__new_tile_history` RENAME TO `tile_history`;
