CREATE TABLE `access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`revoked_at_ms` integer
);
--> statement-breakpoint
CREATE TABLE `contributions` (
	`wplace_user_id` integer NOT NULL,
	`template_id` text NOT NULL,
	`day_s` integer NOT NULL,
	`placed` integer NOT NULL,
	`correct` integer NOT NULL,
	`repairs` integer NOT NULL,
	PRIMARY KEY(`wplace_user_id`, `template_id`, `day_s`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `nodes_path_idx` ON `nodes` (`path`);--> statement-breakpoint
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
	PRIMARY KEY(`template_id`, `resolution`, `bucket_start_s`)
);
--> statement-breakpoint
CREATE TABLE `template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text NOT NULL,
	`min_x` integer NOT NULL,
	`min_y` integer NOT NULL,
	`max_x` integer NOT NULL,
	`max_y` integer NOT NULL,
	`total_pixels` integer NOT NULL,
	`bounds_north` real,
	`bounds_south` real,
	`bounds_west` real,
	`bounds_east` real,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`name` text NOT NULL,
	`season` integer NOT NULL,
	`current_version_id` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tile_history` (
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`resolution_s` integer NOT NULL,
	`bucket_start_s` integer NOT NULL,
	`sha256` text NOT NULL,
	`reporters` integer NOT NULL,
	PRIMARY KEY(`tile_x`, `tile_y`, `resolution_s`, `bucket_start_s`)
);
--> statement-breakpoint
CREATE TABLE `version_tiles` (
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`version_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `version_tiles_tile_idx` ON `version_tiles` (`tile_x`,`tile_y`);