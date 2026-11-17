ALTER TABLE `devices` ADD `linked_to_device_id` text REFERENCES devices(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `devices_linked_to_idx` ON `devices` (`linked_to_device_id`);
