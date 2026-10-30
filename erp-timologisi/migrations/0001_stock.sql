-- Αποθήκη: εφαρμόζεται σε υπάρχουσα βάση χωρίς απώλεια δεδομένων.
-- (Το `drizzle-kit push` εδώ προτείνει "delete from items", γι' αυτό η αλλαγή γίνεται με το χέρι.)
ALTER TABLE `items` ADD `track_stock` integer DEFAULT false NOT NULL;
ALTER TABLE `items` ADD `unit` text DEFAULT 'τεμ.' NOT NULL;
ALTER TABLE `invoice_lines` ADD `item_id` text REFERENCES `items`(`id`) ON DELETE set null;
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`item_id` text NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_cost_cents` integer,
	`note` text,
	`invoice_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `stock_org_item_idx` ON `stock_movements` (`org_id`,`item_id`);
CREATE INDEX `stock_invoice_idx` ON `stock_movements` (`invoice_id`);
