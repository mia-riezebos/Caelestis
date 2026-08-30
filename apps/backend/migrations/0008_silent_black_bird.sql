CREATE TABLE `template_alarm_tile_statuses` (
	`template_id` text NOT NULL,
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`correct` integer NOT NULL,
	`wrong` integer NOT NULL,
	`blank` integer NOT NULL,
	`colours_json` text NOT NULL,
	`observed_at_ms` integer NOT NULL,
	PRIMARY KEY(`template_id`, `version_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "template_alarm_tile_statuses_coordinate_check" CHECK(typeof("template_alarm_tile_statuses"."tile_x") = 'integer' AND typeof("template_alarm_tile_statuses"."tile_y") = 'integer'
        AND "template_alarm_tile_statuses"."tile_x" BETWEEN 0 AND 2047
        AND "template_alarm_tile_statuses"."tile_y" BETWEEN 0 AND 2047),
	CONSTRAINT "template_alarm_tile_statuses_counter_check" CHECK(typeof("template_alarm_tile_statuses"."correct") = 'integer' AND typeof("template_alarm_tile_statuses"."wrong") = 'integer'
        AND typeof("template_alarm_tile_statuses"."blank") = 'integer'
        AND "template_alarm_tile_statuses"."correct" >= 0 AND "template_alarm_tile_statuses"."wrong" >= 0 AND "template_alarm_tile_statuses"."blank" >= 0)
);
--> statement-breakpoint
CREATE INDEX `template_alarm_tile_statuses_version_idx` ON `template_alarm_tile_statuses` (`version_id`);--> statement-breakpoint
ALTER TABLE `canvas_tiles` ADD `server_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `template_alarm_states` ADD `evaluated_at_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `template_tile_statuses` ADD `server_owned` integer DEFAULT false NOT NULL;