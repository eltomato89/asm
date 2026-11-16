-- Custom SQL migration: add env_name to the secrets full-text index and backfill existing rows.
DROP TRIGGER IF EXISTS `secrets_fts_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `secrets_fts_ad`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `secrets_fts_au`;
--> statement-breakpoint
DROP TABLE IF EXISTS `secrets_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `secrets_fts` USING fts5(secret_id UNINDEXED, title, description, tags, env_name);
--> statement-breakpoint
INSERT INTO `secrets_fts`(secret_id, title, description, tags, env_name)
  SELECT id, title, description, tags, coalesce(env_name, '') FROM `secrets`;
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_ai` AFTER INSERT ON `secrets` BEGIN
  INSERT INTO `secrets_fts`(secret_id, title, description, tags, env_name) VALUES (new.id, new.title, new.description, new.tags, coalesce(new.env_name, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_ad` AFTER DELETE ON `secrets` BEGIN
  DELETE FROM `secrets_fts` WHERE secret_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_au` AFTER UPDATE OF title, description, tags, env_name ON `secrets` BEGIN
  DELETE FROM `secrets_fts` WHERE secret_id = old.id;
  INSERT INTO `secrets_fts`(secret_id, title, description, tags, env_name) VALUES (new.id, new.title, new.description, new.tags, coalesce(new.env_name, ''));
END;
