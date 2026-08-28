PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tile_blob_deletion_locks` (
	`sha256` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	CONSTRAINT "tile_blob_deletion_locks_sha256_check" CHECK(typeof("__new_tile_blob_deletion_locks"."sha256") = 'text' AND length("__new_tile_blob_deletion_locks"."sha256") = 64
        AND "__new_tile_blob_deletion_locks"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_tile_blob_deletion_locks`("sha256", "owner_id") SELECT "sha256", CAST("expires_at_ms" AS text) FROM `tile_blob_deletion_locks`;--> statement-breakpoint
DROP TABLE `tile_blob_deletion_locks`;--> statement-breakpoint
ALTER TABLE `__new_tile_blob_deletion_locks` RENAME TO `tile_blob_deletion_locks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
