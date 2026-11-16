CREATE TABLE `approve_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `access_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approve_tokens_request_idx` ON `approve_tokens` (`request_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `vapid_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`tag` blob NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`dek_iv` blob NOT NULL,
	`dek_tag` blob NOT NULL,
	`created_at` integer NOT NULL
);
