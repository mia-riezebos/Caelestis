PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`surface_kind` text DEFAULT 'world' NOT NULL,
	`alliance_id` integer,
	`parent_id` text,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`delete_token` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nodes_surface_check" CHECK(("__new_nodes"."surface_kind" = 'world' AND "__new_nodes"."alliance_id" IS NULL)
        OR ("__new_nodes"."surface_kind" IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND typeof("__new_nodes"."alliance_id") = 'integer' AND "__new_nodes"."alliance_id" > 0)),
	CONSTRAINT "nodes_path_check" CHECK("__new_nodes"."path" GLOB '/*' AND "__new_nodes"."path" NOT GLOB '*[%_]*'
        AND "__new_nodes"."path" NOT GLOB '*/' AND "__new_nodes"."path" NOT GLOB '*//*'
        AND length("__new_nodes"."path") BETWEEN 2 AND 256),
	CONSTRAINT "nodes_parent_not_self_check" CHECK("__new_nodes"."parent_id" IS NULL OR "__new_nodes"."parent_id" <> "__new_nodes"."id")
);
--> statement-breakpoint
INSERT INTO `__new_nodes`("id", "season", "surface_kind", "alliance_id", "parent_id", "path", "name", "description", "delete_token", "created_at_ms") SELECT "id", "season", 'world', NULL, "parent_id", "path", "name", "description", "delete_token", "created_at_ms" FROM `nodes`;--> statement-breakpoint
DROP TABLE `nodes`;--> statement-breakpoint
ALTER TABLE `__new_nodes` RENAME TO `nodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_world_path_idx` ON `nodes` (`season`,lower("path")) WHERE "nodes"."surface_kind" = 'world';--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_alliance_surface_path_idx` ON `nodes` (`season`,`surface_kind`,`alliance_id`,lower("path")) WHERE "nodes"."surface_kind" <> 'world';
