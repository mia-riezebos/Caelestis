CREATE TABLE `status_read_model_revisions` (
	`season` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`public_fingerprint` text NOT NULL,
	`admin_fingerprint` text NOT NULL,
	CONSTRAINT "status_read_model_revisions_values_check" CHECK(typeof("status_read_model_revisions"."season") = 'integer' AND "status_read_model_revisions"."season" >= 0
        AND typeof("status_read_model_revisions"."revision") = 'integer' AND "status_read_model_revisions"."revision" > 0
        AND length("status_read_model_revisions"."public_fingerprint") = 64
        AND "status_read_model_revisions"."public_fingerprint" NOT GLOB '*[^0-9a-f]*'
        AND length("status_read_model_revisions"."admin_fingerprint") = 64
        AND "status_read_model_revisions"."admin_fingerprint" NOT GLOB '*[^0-9a-f]*')
);
