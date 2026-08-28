CREATE TABLE `tile_blob_deletion_locks` (
	`sha256` text PRIMARY KEY NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT "tile_blob_deletion_locks_sha256_check" CHECK(typeof("tile_blob_deletion_locks"."sha256") = 'text' AND length("tile_blob_deletion_locks"."sha256") = 64
        AND "tile_blob_deletion_locks"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `tile_blob_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT "tile_blob_reservations_sha256_check" CHECK(typeof("tile_blob_reservations"."sha256") = 'text' AND length("tile_blob_reservations"."sha256") = 64
        AND "tile_blob_reservations"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `tile_blob_reservations_sha256_idx` ON `tile_blob_reservations` (`sha256`);