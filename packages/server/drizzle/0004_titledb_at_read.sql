-- titledb names and versions are now joined in when reading, so the enabled switch and refreshes
-- take effect immediately. Drop the copies earlier versions wrote into applications.
UPDATE `applications` SET `name` = NULL, `name_source` = NULL, `publisher` = NULL, `description` = NULL WHERE `name_source` = 'titledb';
--> statement-breakpoint
UPDATE `applications` SET `latest_known_version` = NULL, `latest_version_source` = NULL WHERE `latest_version_source` = 'titledb';
