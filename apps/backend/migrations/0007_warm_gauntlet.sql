PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_with_token` text NOT NULL,
	`created_by_user_id` integer,
	`min_x` integer NOT NULL,
	`min_y` integer NOT NULL,
	`max_x` integer NOT NULL,
	`max_y` integer NOT NULL,
	`total_pixels` integer NOT NULL,
	`colour_totals_json` text,
	`bounds_north` real,
	`bounds_south` real,
	`bounds_west` real,
	`bounds_east` real,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "template_versions_created_with_token_check" CHECK(typeof("__new_template_versions"."created_with_token") = 'text' AND length("__new_template_versions"."created_with_token") = 64
        AND "__new_template_versions"."created_with_token" NOT GLOB '*[^0-9a-f]*'
        AND ("__new_template_versions"."created_by_user_id" IS NULL
          OR (typeof("__new_template_versions"."created_by_user_id") = 'integer' AND "__new_template_versions"."created_by_user_id" >= 0))),
	CONSTRAINT "template_versions_bounds_all_or_none_check" CHECK(("__new_template_versions"."bounds_north" IS NULL AND "__new_template_versions"."bounds_south" IS NULL AND "__new_template_versions"."bounds_west" IS NULL AND "__new_template_versions"."bounds_east" IS NULL) OR ("__new_template_versions"."bounds_north" IS NOT NULL AND "__new_template_versions"."bounds_south" IS NOT NULL AND "__new_template_versions"."bounds_west" IS NOT NULL AND "__new_template_versions"."bounds_east" IS NOT NULL)),
	CONSTRAINT "template_versions_pixel_bounds_check" CHECK(typeof("__new_template_versions"."min_x") = 'integer' AND typeof("__new_template_versions"."min_y") = 'integer'
        AND typeof("__new_template_versions"."max_x") = 'integer' AND typeof("__new_template_versions"."max_y") = 'integer'
        AND typeof("__new_template_versions"."total_pixels") = 'integer'
        AND "__new_template_versions"."min_x" BETWEEN -1000 AND 2047999
        AND "__new_template_versions"."min_y" BETWEEN -1000 AND 2047999
        AND "__new_template_versions"."max_x" BETWEEN -999 AND 2048000
        AND "__new_template_versions"."max_y" BETWEEN -999 AND 2048000
        AND "__new_template_versions"."min_x" <> "__new_template_versions"."max_x"
        AND "__new_template_versions"."min_y" < "__new_template_versions"."max_y"
        AND "__new_template_versions"."total_pixels" >= 0),
	CONSTRAINT "template_versions_bounds_range_check" CHECK("__new_template_versions"."bounds_north" IS NULL OR ("__new_template_versions"."bounds_north" BETWEEN -90 AND 90 AND "__new_template_versions"."bounds_south" BETWEEN -90 AND 90 AND "__new_template_versions"."bounds_west" BETWEEN -180 AND 180 AND "__new_template_versions"."bounds_east" BETWEEN -180 AND 180 AND "__new_template_versions"."bounds_north" > "__new_template_versions"."bounds_south"))
);
--> statement-breakpoint
INSERT INTO `__new_template_versions`("id", "template_id", "created_at_ms", "created_with_token", "created_by_user_id", "min_x", "min_y", "max_x", "max_y", "total_pixels", "colour_totals_json", "bounds_north", "bounds_south", "bounds_west", "bounds_east") SELECT "id", "template_id", "created_at_ms", "created_with_token", "created_by_user_id", "min_x", "min_y", "max_x", "max_y", "total_pixels", "colour_totals_json", "bounds_north", "bounds_south", "bounds_west", "bounds_east" FROM `template_versions`;--> statement-breakpoint
DROP TABLE `template_versions`;--> statement-breakpoint
ALTER TABLE `__new_template_versions` RENAME TO `template_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_id_template_idx` ON `template_versions` (`id`,`template_id`);--> statement-breakpoint
CREATE TABLE `__new_version_tiles` (
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`version_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "version_tiles_hash_check" CHECK(typeof("__new_version_tiles"."hash") = 'text' AND length("__new_version_tiles"."hash") = 64
        AND "__new_version_tiles"."hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "version_tiles_coordinate_check" CHECK(typeof("__new_version_tiles"."tile_x") = 'integer' AND typeof("__new_version_tiles"."tile_y") = 'integer'
        AND "__new_version_tiles"."tile_x" BETWEEN -1 AND 2047
        AND "__new_version_tiles"."tile_y" BETWEEN -1 AND 2047)
);
--> statement-breakpoint
INSERT INTO `__new_version_tiles`("version_id", "tile_x", "tile_y", "hash") SELECT "version_id", "tile_x", "tile_y", "hash" FROM `version_tiles`;--> statement-breakpoint
DROP TABLE `version_tiles`;--> statement-breakpoint
ALTER TABLE `__new_version_tiles` RENAME TO `version_tiles`;--> statement-breakpoint
CREATE INDEX `version_tiles_tile_idx` ON `version_tiles` (`tile_x`,`tile_y`);