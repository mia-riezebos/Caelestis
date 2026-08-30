PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`surface_kind` text DEFAULT 'world' NOT NULL,
	`alliance_id` integer,
	`node_id` text,
	`name` text NOT NULL,
	`current_version_id` text,
	`published_at` integer,
	`timelapse_frozen_at_ms` integer,
	`finished_at_ms` integer,
	`created_with_token` text NOT NULL,
	`created_by_user_id` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`,`id`) REFERENCES `template_versions`(`id`,`template_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "templates_surface_check" CHECK(("__new_templates"."surface_kind" = 'world' AND "__new_templates"."alliance_id" IS NULL)
        OR ("__new_templates"."surface_kind" IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND typeof("__new_templates"."alliance_id") = 'integer' AND "__new_templates"."alliance_id" > 0)),
	CONSTRAINT "templates_created_with_token_check" CHECK(typeof("__new_templates"."created_with_token") = 'text' AND length("__new_templates"."created_with_token") = 64
        AND "__new_templates"."created_with_token" NOT GLOB '*[^0-9a-f]*'
        AND ("__new_templates"."created_by_user_id" IS NULL
          OR (typeof("__new_templates"."created_by_user_id") = 'integer' AND "__new_templates"."created_by_user_id" >= 0)))
);
--> statement-breakpoint
INSERT INTO `__new_templates`("id", "season", "surface_kind", "alliance_id", "node_id", "name", "current_version_id", "published_at", "timelapse_frozen_at_ms", "finished_at_ms", "created_with_token", "created_by_user_id", "created_at_ms", "updated_at_ms") SELECT "id", "season", 'world', NULL, "node_id", "name", "current_version_id", "published_at", "timelapse_frozen_at_ms", "finished_at_ms", "created_with_token", "created_by_user_id", "created_at_ms", "updated_at_ms" FROM `templates`;--> statement-breakpoint
DROP TABLE `templates`;--> statement-breakpoint
ALTER TABLE `__new_templates` RENAME TO `templates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `templates_surface_idx` ON `templates` (`season`,`surface_kind`,`alliance_id`);
