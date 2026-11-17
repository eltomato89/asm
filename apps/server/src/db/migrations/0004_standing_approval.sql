CREATE TABLE `standing_approval_secrets` (
	`device_id` text NOT NULL,
	`secret_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `secret_id`),
	FOREIGN KEY (`device_id`) REFERENCES `standing_approvals`(`device_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `standing_approval_secrets_secret_idx` ON `standing_approval_secrets` (`secret_id`);--> statement-breakpoint
CREATE TABLE `standing_approval_vaults` (
	`device_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `vault_id`),
	FOREIGN KEY (`device_id`) REFERENCES `standing_approvals`(`device_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `standing_approval_vaults_vault_idx` ON `standing_approval_vaults` (`vault_id`);--> statement-breakpoint
CREATE TABLE `standing_approvals` (
	`device_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`until` integer NOT NULL,
	`granted_at` integer NOT NULL,
	`scope` text NOT NULL,
	`include_created` integer DEFAULT false NOT NULL,
	`allow_updates` integer DEFAULT false NOT NULL,
	`after_expiry` text DEFAULT 'ask' NOT NULL,
	`renew_days` integer DEFAULT 7 NOT NULL,
	`expiry_audited` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `standing_approvals_user_idx` ON `standing_approvals` (`user_id`);--> statement-breakpoint
ALTER TABLE `access_requests` ADD `auto_source` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `standing_renewal` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `default_vault_id` text REFERENCES vaults(id) ON DELETE set null;--> statement-breakpoint
UPDATE `access_requests` SET `auto_source` = 'automode' WHERE `auto` = 1;
