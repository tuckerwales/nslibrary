CREATE TABLE `save_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`app_name` text,
	`save_type` text NOT NULL,
	`user_id` text,
	`user_name` text,
	`device_id` integer,
	`device_name` text NOT NULL,
	`origin` text NOT NULL,
	`size` integer NOT NULL,
	`data_size` integer NOT NULL,
	`file_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `save_backups_save_idx` ON `save_backups` (`application_id`,`save_type`,`user_id`,`device_id`,`created_at`);
