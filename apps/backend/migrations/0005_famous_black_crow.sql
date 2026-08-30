CREATE TABLE `tile_blob_gc_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`completed_sweeps` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tile_blob_gc_state_single_row_check" CHECK("tile_blob_gc_state"."id" = 1),
	CONSTRAINT "tile_blob_gc_state_sweeps_check" CHECK(typeof("tile_blob_gc_state"."completed_sweeps") = 'integer' AND "tile_blob_gc_state"."completed_sweeps" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tile_blob_objects` (
	`blob_key` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`state` text NOT NULL,
	`discovered_at_ms` integer NOT NULL,
	`delete_started_at_ms` integer,
	`delete_attempts` integer DEFAULT 0 NOT NULL,
	`reclaimed_at_ms` integer,
	CONSTRAINT "tile_blob_objects_sha256_check" CHECK(typeof("tile_blob_objects"."sha256") = 'text' AND length("tile_blob_objects"."sha256") = 64
        AND "tile_blob_objects"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "tile_blob_objects_key_check" CHECK("tile_blob_objects"."blob_key" = "tile_blob_objects"."sha256" OR "tile_blob_objects"."blob_key" GLOB ("tile_blob_objects"."sha256" || '/*')),
	CONSTRAINT "tile_blob_objects_state_check" CHECK("tile_blob_objects"."state" IN ('uploading', 'active', 'candidate', 'deleting', 'deleted')),
	CONSTRAINT "tile_blob_objects_attempts_check" CHECK(typeof("tile_blob_objects"."delete_attempts") = 'integer' AND "tile_blob_objects"."delete_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `tile_blob_objects_hash_state_idx` ON `tile_blob_objects` (`sha256`,`state`);--> statement-breakpoint
CREATE TABLE `tile_blob_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`blob_key` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	FOREIGN KEY (`blob_key`) REFERENCES `tile_blob_objects`(`blob_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tile_blob_reservations_sha256_check" CHECK(typeof("tile_blob_reservations"."sha256") = 'text' AND length("tile_blob_reservations"."sha256") = 64
        AND "tile_blob_reservations"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `tile_blob_reservations_hash_expiry_idx` ON `tile_blob_reservations` (`sha256`,`expires_at_ms`);