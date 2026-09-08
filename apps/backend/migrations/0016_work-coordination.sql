CREATE TABLE `work_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision` integer NOT NULL,
	`token_hash` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_activity_data_check" CHECK(json_valid("work_activity"."data"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_activity_revision_idx` ON `work_activity` (`item_id`,`revision`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`surface_kind` text NOT NULL,
	`alliance_id` integer,
	`revision` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "work_items_revision_check" CHECK("work_items"."revision" > 0),
	CONSTRAINT "work_items_data_check" CHECK(json_valid("work_items"."data"))
);
--> statement-breakpoint
CREATE INDEX `work_items_scope_idx` ON `work_items` (`season`,`surface_kind`,`alliance_id`);