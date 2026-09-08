CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_key_unique` ON `tags` (`name_key`);--> statement-breakpoint
CREATE TABLE `template_tags` (
	`tag_id` text NOT NULL,
	`template_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `template_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_tags_template_idx` ON `template_tags` (`template_id`);