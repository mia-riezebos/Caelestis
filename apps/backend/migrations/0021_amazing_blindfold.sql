CREATE TABLE `work_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`surface_kind` text NOT NULL,
	`alliance_id` integer,
	`template_id` text NOT NULL,
	`claimant_user_id` integer NOT NULL,
	`claimant_name` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_regions_scope_idx` ON `work_regions` (`season`,`surface_kind`,`alliance_id`,`template_id`);