CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`brand` text NOT NULL,
	`caption` text NOT NULL,
	`media_type` text DEFAULT 'Imagen' NOT NULL,
	`media_url` text DEFAULT '' NOT NULL,
	`scheduled_at` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL
);
