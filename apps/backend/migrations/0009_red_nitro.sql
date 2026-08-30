CREATE TABLE `status_projection_revisions` (
	`season` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "status_projection_revisions_season_check" CHECK(typeof("status_projection_revisions"."season") = 'integer' AND "status_projection_revisions"."season" >= 0),
	CONSTRAINT "status_projection_revisions_revision_check" CHECK(typeof("status_projection_revisions"."revision") = 'integer' AND "status_projection_revisions"."revision" >= 0)
);
