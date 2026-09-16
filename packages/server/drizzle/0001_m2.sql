CREATE TABLE `content_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meta_id` integer NOT NULL,
	`nca_id` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`compressed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`meta_id`) REFERENCES `content_metas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_records_meta_idx` ON `content_records` (`meta_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_records_meta_nca_idx` ON `content_records` (`meta_id`,`nca_id`);--> statement-breakpoint
CREATE TABLE `titledb_titles` (
	`title_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`publisher` text,
	`description` text,
	`icon_url` text,
	`latest_version` integer,
	`application_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `titledb_versions` (
	`title_id` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`title_id`) REFERENCES `titledb_titles`(`title_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `titledb_versions_idx` ON `titledb_versions` (`title_id`,`version`);
