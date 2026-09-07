CREATE TABLE `node_tags` (
	`tag_id` text NOT NULL,
	`node_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `node_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `node_tags_node_idx` ON `node_tags` (`node_id`);