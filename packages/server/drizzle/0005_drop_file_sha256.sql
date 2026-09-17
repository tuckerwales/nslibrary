-- files.sha256 was never written: verify hashes each NCA against the content metadata, not the
-- container as a whole.
ALTER TABLE `files` DROP COLUMN `sha256`;
