CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`fw` text,
	`ams` text,
	`app_version` text,
	`last_seen` integer,
	`transport` text,
	`sd_free` integer,
	`sd_total` integer,
	`nand_free` integer,
	`nand_total` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_uuid_idx` ON `devices` (`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_idx` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_titles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`storage` text NOT NULL,
	`title_id` text NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`application_id` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_titles_unique_idx` ON `device_titles` (`device_id`,`title_id`,`storage`);--> statement-breakpoint
CREATE INDEX `device_titles_device_idx` ON `device_titles` (`device_id`);--> statement-breakpoint
CREATE TABLE `install_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`content_meta_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`title_id` text NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`format` text NOT NULL,
	`target` text NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`phase` text,
	`item` text,
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`bps` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `install_jobs_device_idx` ON `install_jobs` (`device_id`,`status`);--> statement-breakpoint
CREATE INDEX `install_jobs_position_idx` ON `install_jobs` (`device_id`,`position`);
