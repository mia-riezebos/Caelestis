CREATE TABLE `painter_telemetry_buckets` (
	`template_id` text NOT NULL,
	`wplace_user_id` integer NOT NULL,
	`resolution` integer NOT NULL,
	`bucket_start_s` integer NOT NULL,
	`placed` integer NOT NULL,
	`correct` integer NOT NULL,
	`repairs` integer NOT NULL,
	PRIMARY KEY(`template_id`, `wplace_user_id`, `resolution`, `bucket_start_s`),
	CONSTRAINT "painter_telemetry_buckets_resolution_check" CHECK("painter_telemetry_buckets"."resolution" IN (60, 300, 900, 3600, 21600)),
	CONSTRAINT "painter_telemetry_buckets_alignment_check" CHECK(typeof("painter_telemetry_buckets"."bucket_start_s") = 'integer' AND "painter_telemetry_buckets"."bucket_start_s" >= 0
        AND "painter_telemetry_buckets"."bucket_start_s" % "painter_telemetry_buckets"."resolution" = 0),
	CONSTRAINT "painter_telemetry_buckets_counter_check" CHECK(typeof("painter_telemetry_buckets"."wplace_user_id") = 'integer' AND "painter_telemetry_buckets"."wplace_user_id" >= 0
        AND typeof("painter_telemetry_buckets"."placed") = 'integer' AND typeof("painter_telemetry_buckets"."correct") = 'integer'
        AND typeof("painter_telemetry_buckets"."repairs") = 'integer'
        AND "painter_telemetry_buckets"."repairs" >= 0
        AND "painter_telemetry_buckets"."repairs" <= "painter_telemetry_buckets"."correct" AND "painter_telemetry_buckets"."correct" <= "painter_telemetry_buckets"."placed")
);
