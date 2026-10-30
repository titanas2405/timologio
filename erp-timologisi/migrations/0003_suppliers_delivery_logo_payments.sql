-- Προμηθευτές, δελτία αποστολής, λογότυπο/έδρα, κρυπτογραφημένες συνδέσεις (ΑΑΔΕ, Viva), πληρωμές κάρτας.
-- Μόνο νέοι πίνακες και νέες προαιρετικές στήλες: καμία απώλεια δεδομένων.
CREATE TABLE `card_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`terminal_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`message` text,
	`transaction_id` text,
	`authorization_id` text,
	`card_type` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `card_payments_invoice_idx` ON `card_payments` (`invoice_id`);
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`config_encrypted` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `integrations_org_kind` ON `integrations` (`org_id`,`kind`);
CREATE TABLE `invoice_links` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`delivery_note_id` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivery_note_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `invoice_links_note_unique` ON `invoice_links` (`delivery_note_id`);
CREATE INDEX `invoice_links_invoice_idx` ON `invoice_links` (`invoice_id`);
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`vat_number` text,
	`country` text DEFAULT 'GR' NOT NULL,
	`address` text,
	`city` text,
	`postal_code` text,
	`email` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `suppliers_org_idx` ON `suppliers` (`org_id`);
ALTER TABLE `invoice_lines` ADD `source_line_id` text;
ALTER TABLE `invoices` ADD `move_purpose` integer;
ALTER TABLE `invoices` ADD `other_move_purpose_title` text;
ALTER TABLE `invoices` ADD `dispatch_date` text;
ALTER TABLE `invoices` ADD `dispatch_time` text;
ALTER TABLE `invoices` ADD `vehicle_number` text;
ALTER TABLE `invoices` ADD `loading_address` text;
ALTER TABLE `invoices` ADD `delivery_address` text;
ALTER TABLE `organizations` ADD `address` text;
ALTER TABLE `organizations` ADD `logo` text;
ALTER TABLE `stock_movements` ADD `supplier_id` text REFERENCES `suppliers`(`id`);
