CREATE TABLE `access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`secret_id` text NOT NULL,
	`device_id` text NOT NULL,
	`user_id` text,
	`project` text NOT NULL,
	`reason` text NOT NULL,
	`delivery` text,
	`proposed_meta` text,
	`proposed_value_sealed` text,
	`status` text NOT NULL,
	`decided_by` text,
	`auto` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_requests_status_idx` ON `access_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ts` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`event` text NOT NULL,
	`secret_id` text,
	`vault_id` text,
	`device_id` text,
	`project` text,
	`reason` text,
	`ip` text,
	`meta` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_id_unique` ON `audit_log` (`id`);--> statement-breakpoint
CREATE TABLE `auto_mode` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled_until` integer,
	`default_duration_min` integer DEFAULT 30 NOT NULL,
	`vault_ids` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `device_codes` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`device_id` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`hostname` text,
	`status` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`secret_id` text NOT NULL,
	`uses_left` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `access_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`device_id` text NOT NULL,
	`user_id` text,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `project_usage` (
	`project_id` text NOT NULL,
	`secret_id` text NOT NULL,
	`device_id` text NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `secret_id`, `device_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`merged_into` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `secret_versions` (
	`secret_id` text NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`tag` blob NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`dek_iv` blob NOT NULL,
	`dek_tag` blob NOT NULL,
	`meta_snapshot` text NOT NULL,
	`changed_by_type` text NOT NULL,
	`changed_by_id` text NOT NULL,
	`project` text,
	`reason` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`secret_id`, `version`),
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text NOT NULL,
	`env_name` text,
	`allow_plaintext_to_agent` integer DEFAULT false NOT NULL,
	`current_version` integer NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`archived_at` integer,
	`archived_by_type` text,
	`archived_by_id` text,
	`archive_reason` text,
	`archive_project` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `secrets_vault_idx` ON `secrets` (`vault_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_auth_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_hash_unique` ON `tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `vault_members` (
	`vault_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`vault_id`, `user_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`personal_of_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`personal_of_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE VIRTUAL TABLE `secrets_fts` USING fts5(title, description, tags, content='secrets', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_ai` AFTER INSERT ON `secrets` BEGIN
  INSERT INTO `secrets_fts`(rowid, title, description, tags) VALUES (new.rowid, new.title, new.description, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_ad` AFTER DELETE ON `secrets` BEGIN
  INSERT INTO `secrets_fts`(`secrets_fts`, rowid, title, description, tags) VALUES ('delete', old.rowid, old.title, old.description, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `secrets_fts_au` AFTER UPDATE OF title, description, tags ON `secrets` BEGIN
  INSERT INTO `secrets_fts`(`secrets_fts`, rowid, title, description, tags) VALUES ('delete', old.rowid, old.title, old.description, old.tags);
  INSERT INTO `secrets_fts`(rowid, title, description, tags) VALUES (new.rowid, new.title, new.description, new.tags);
END;
