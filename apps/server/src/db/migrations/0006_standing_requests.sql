CREATE TABLE `standing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`scope` text NOT NULL,
	`vault_ids` text DEFAULT '[]' NOT NULL,
	`secret_ids` text DEFAULT '[]' NOT NULL,
	`days` integer NOT NULL,
	`after_expiry` text DEFAULT 'ask' NOT NULL,
	`renew_days` integer,
	`project` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision` text,
	`cause` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `standing_requests_one_pending` ON `standing_requests` (`device_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `standing_requests_status_idx` ON `standing_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `standing_requests_user_idx` ON `standing_requests` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `standing_requests_device_idx` ON `standing_requests` (`device_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `standing_approve_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`standing_request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`standing_request_id`) REFERENCES `standing_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `standing_approve_tokens_request_idx` ON `standing_approve_tokens` (`standing_request_id`);