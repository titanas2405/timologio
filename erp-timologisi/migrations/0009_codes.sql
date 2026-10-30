-- Κωδικοποίηση πελατών, προμηθευτών και ειδών (+ barcode ειδών). Νέες στήλες χωρίς τιμή, νέος πίνακας· χωρίς απώλειες.
-- Οι υπάρχουσες εγγραφές μένουν χωρίς κωδικό μέχρι «Απόδοση κωδικών» στις Ρυθμίσεις → Κωδικοποίηση.
CREATE TABLE `code_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`entity` text NOT NULL,
	`mode` text DEFAULT 'AUTO' NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`digits` integer DEFAULT 4 NOT NULL,
	`next_number` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `code_sequences_org_entity` ON `code_sequences` (`org_id`,`entity`);
ALTER TABLE `customers` ADD `code` text;
CREATE UNIQUE INDEX `customers_org_code` ON `customers` (`org_id`,`code`);
ALTER TABLE `suppliers` ADD `code` text;
CREATE UNIQUE INDEX `suppliers_org_code` ON `suppliers` (`org_id`,`code`);
ALTER TABLE `items` ADD `code` text;
ALTER TABLE `items` ADD `barcode` text;
CREATE UNIQUE INDEX `items_org_code` ON `items` (`org_id`,`code`);
ALTER TABLE `invoices` ADD `customer_code` text;
ALTER TABLE `invoice_lines` ADD `item_code` text;
