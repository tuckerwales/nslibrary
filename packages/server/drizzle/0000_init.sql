CREATE TABLE `admin` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`application_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`name_source` text,
	`publisher` text,
	`description` text,
	`icon_key` text,
	`latest_known_version` integer,
	`latest_version_source` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `container_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`entry_offset` integer NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `container_entries_file_idx` ON `container_entries` (`file_id`);--> statement-breakpoint
CREATE TABLE `content_metas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`title_id` text NOT NULL,
	`version` integer,
	`type` text NOT NULL,
	`application_id` text NOT NULL,
	`application_id_source` text NOT NULL,
	`display_name` text NOT NULL,
	`key_generation` integer,
	`rights_id` text,
	`required_system_version` integer,
	`install_size` integer,
	`source` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_metas_file_title_idx` ON `content_metas` (`file_id`,`title_id`);--> statement-breakpoint
CREATE INDEX `content_metas_application_idx` ON `content_metas` (`application_id`);--> statement-breakpoint
CREATE INDEX `content_metas_title_idx` ON `content_metas` (`title_id`,`version`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`root_id` integer NOT NULL,
	`rel_path` text NOT NULL,
	`format` text NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`parse_error` text,
	`parser_version` integer DEFAULT 0 NOT NULL,
	`metadata_source` text,
	`sha256` text,
	`verify_status` text DEFAULT 'unverified' NOT NULL,
	`verified_at` integer,
	`first_seen_at` integer NOT NULL,
	`missing_since` integer,
	FOREIGN KEY (`root_id`) REFERENCES `library_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_root_path_idx` ON `files` (`root_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `files_missing_idx` ON `files` (`missing_since`);--> statement-breakpoint
CREATE TABLE `homebrew` (
	`file_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`publisher` text,
	`version` text,
	`icon_key` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `library_roots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`enabled` integer DEFAULT true NOT NULL,
	`use_polling` integer DEFAULT false NOT NULL,
	`last_scan_at` integer,
	`last_scan_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_roots_path_unique` ON `library_roots` (`path`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
