PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_status_read_model_revisions` (
	`season` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`public_fingerprint` text NOT NULL,
	`admin_fingerprint` text NOT NULL,
	`fingerprints_dirty` integer DEFAULT false NOT NULL,
	CONSTRAINT "status_read_model_revisions_values_check" CHECK(typeof("__new_status_read_model_revisions"."season") = 'integer' AND "__new_status_read_model_revisions"."season" >= 0
        AND typeof("__new_status_read_model_revisions"."revision") = 'integer' AND "__new_status_read_model_revisions"."revision" > 0
        AND length("__new_status_read_model_revisions"."public_fingerprint") = 64
        AND "__new_status_read_model_revisions"."public_fingerprint" NOT GLOB '*[^0-9a-f]*'
        AND length("__new_status_read_model_revisions"."admin_fingerprint") = 64
        AND "__new_status_read_model_revisions"."admin_fingerprint" NOT GLOB '*[^0-9a-f]*'
        AND typeof("__new_status_read_model_revisions"."fingerprints_dirty") = 'integer'
        AND "__new_status_read_model_revisions"."fingerprints_dirty" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_status_read_model_revisions`("season", "revision", "public_fingerprint", "admin_fingerprint", "fingerprints_dirty") SELECT "season", "revision", "public_fingerprint", "admin_fingerprint", false FROM `status_read_model_revisions`;--> statement-breakpoint
DROP TABLE `status_read_model_revisions`;--> statement-breakpoint
ALTER TABLE `__new_status_read_model_revisions` RENAME TO `status_read_model_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
