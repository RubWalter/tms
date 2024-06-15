ALTER TABLE `accounts` ADD `provider` varchar(8) NOT NULL DEFAULT 'ptc';
DROP INDEX username ON accounts;
ALTER TABLE `accounts` ADD INDEX `username` (`username`) USING BTREE;
ALTER TABLE `accounts` ADD UNIQUE `username_provider`(`username`, `provider`); 
UPDATE `migrations` SET `migration_index` = 1 WHERE 1;