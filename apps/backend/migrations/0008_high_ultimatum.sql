ALTER TABLE `canvas_tiles` ADD `server_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `template_alarm_states` ADD `evaluated_at_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `template_tile_statuses` ADD `server_owned` integer DEFAULT false NOT NULL;