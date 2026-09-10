CREATE TABLE `template_tile_measurements` (
	`version_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`sha256` text NOT NULL,
	`correct` integer NOT NULL,
	`wrong` integer NOT NULL,
	`blank` integer NOT NULL,
	PRIMARY KEY(`version_id`, `tile_x`, `tile_y`, `sha256`),
	FOREIGN KEY (`version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "template_tile_measurements_counts_check" CHECK("template_tile_measurements"."correct" >= 0 AND "template_tile_measurements"."wrong" >= 0 AND "template_tile_measurements"."blank" >= 0)
);
