CREATE TABLE `canvas_tiles` (
	`season` integer NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`sha256` text NOT NULL,
	`observed_at_ms` integer NOT NULL,
	PRIMARY KEY(`season`, `tile_x`, `tile_y`),
	CONSTRAINT "canvas_tiles_season_check" CHECK(typeof("canvas_tiles"."season") = 'integer' AND "canvas_tiles"."season" >= 0),
	CONSTRAINT "canvas_tiles_coordinate_check" CHECK(typeof("canvas_tiles"."tile_x") = 'integer' AND typeof("canvas_tiles"."tile_y") = 'integer'
        AND "canvas_tiles"."tile_x" BETWEEN 0 AND 2047
        AND "canvas_tiles"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "canvas_tiles_sha256_check" CHECK(typeof("canvas_tiles"."sha256") = 'text' AND length("canvas_tiles"."sha256") = 64
        AND "canvas_tiles"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `template_tile_statuses` (
	`template_id` text NOT NULL,
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`correct` integer NOT NULL,
	`wrong` integer NOT NULL,
	`blank` integer NOT NULL,
	`observed_at_ms` integer NOT NULL,
	PRIMARY KEY(`template_id`, `version_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "template_tile_statuses_coordinate_check" CHECK(typeof("template_tile_statuses"."tile_x") = 'integer' AND typeof("template_tile_statuses"."tile_y") = 'integer'
        AND "template_tile_statuses"."tile_x" BETWEEN 0 AND 2047
        AND "template_tile_statuses"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "template_tile_statuses_counter_check" CHECK(typeof("template_tile_statuses"."correct") = 'integer' AND typeof("template_tile_statuses"."wrong") = 'integer'
        AND typeof("template_tile_statuses"."blank") = 'integer'
        AND "template_tile_statuses"."correct" >= 0 AND "template_tile_statuses"."wrong" >= 0 AND "template_tile_statuses"."blank" >= 0)
);
--> statement-breakpoint
CREATE INDEX `template_tile_statuses_version_idx` ON `template_tile_statuses` (`version_id`);
