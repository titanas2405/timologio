-- Τρόποι πληρωμής ανά οργανισμό. Εφαρμόζεται σε υπάρχουσα βάση χωρίς απώλεια δεδομένων.
CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`mydata_type` text NOT NULL,
	`details` text,
	`is_default` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `payment_methods_org_idx` ON `payment_methods` (`org_id`);
ALTER TABLE `invoices` ADD `payment_method_id` text REFERENCES `payment_methods`(`id`) ON DELETE set null;
ALTER TABLE `invoices` ADD `payment_method_name` text;
ALTER TABLE `invoices` ADD `payment_method_details` text;

-- Οι ίδιοι προεπιλεγμένοι τρόποι που παίρνει κάθε νέος οργανισμός (src/domain/payment-methods.ts)
INSERT INTO `payment_methods` (`id`, `org_id`, `name`, `mydata_type`, `created_at`)
SELECT lower(hex(randomblob(16))), o.id, d.name, d.type, d.created_at
FROM `organizations` o,
  (SELECT 'Μετρητά' AS name, '3' AS type, '2000-01-01T00:00:00.001Z' AS created_at
   UNION ALL SELECT 'Κατάθεση σε τράπεζα', '1', '2000-01-01T00:00:00.002Z'
   UNION ALL SELECT 'Κάρτα (POS)', '7', '2000-01-01T00:00:00.003Z'
   UNION ALL SELECT 'Επί πιστώσει', '5', '2000-01-01T00:00:00.004Z') d;
