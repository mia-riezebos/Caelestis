PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`surface_kind` text NOT NULL,
	`alliance_id` integer,
	`template_id` text,
	`claimant_user_id` integer NOT NULL,
	`claimant_name` text NOT NULL,
	`shape` text,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_work_regions`("id", "season", "surface_kind", "alliance_id", "template_id", "claimant_user_id", "claimant_name", "shape", "x", "y", "w", "h", "label", "created_at") SELECT "id", "season", "surface_kind", "alliance_id", "template_id", "claimant_user_id", "claimant_name", "shape", "x", "y", "w", "h", "label", "created_at" FROM `work_regions`;--> statement-breakpoint
DROP TABLE `work_regions`;--> statement-breakpoint
ALTER TABLE `__new_work_regions` RENAME TO `work_regions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `work_regions_scope_idx` ON `work_regions` (`season`,`surface_kind`,`alliance_id`,`template_id`);