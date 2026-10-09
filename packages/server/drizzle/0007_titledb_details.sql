-- Details for sorting and filtering the library. Filled in by the next titledb refresh.
ALTER TABLE `titledb_titles` ADD `release_date` integer;
--> statement-breakpoint
ALTER TABLE `titledb_titles` ADD `languages` text;
--> statement-breakpoint
ALTER TABLE `titledb_titles` ADD `regions` text;
--> statement-breakpoint
ALTER TABLE `titledb_titles` ADD `rating` integer;
--> statement-breakpoint
ALTER TABLE `titledb_titles` ADD `number_of_players` integer;
--> statement-breakpoint
ALTER TABLE `titledb_versions` ADD `release_date` integer;
