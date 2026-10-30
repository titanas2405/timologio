-- Εισπράξεις & πληρωμές. Δύο νέοι πίνακες· καμία αλλαγή σε υπάρχοντες.
-- Οι ήδη εγκεκριμένες χρεώσεις κάρτας γίνονται εισπράξεις που εξοφλούν το παραστατικό τους.
CREATE TABLE `cash_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`customer_id` text,
	`supplier_id` text,
	`payee` text,
	`amount_cents` integer NOT NULL,
	`payment_method_id` text,
	`payment_method_name` text,
	`reference` text,
	`notes` text,
	`card_payment_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`card_payment_id`) REFERENCES `card_payments`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `cash_org_date_idx` ON `cash_entries` (`org_id`,`date`);
CREATE INDEX `cash_customer_idx` ON `cash_entries` (`customer_id`);
CREATE UNIQUE INDEX `cash_card_payment_unique` ON `cash_entries` (`card_payment_id`);
CREATE TABLE `cash_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `cash_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `cash_alloc_unique` ON `cash_allocations` (`entry_id`,`invoice_id`);
CREATE INDEX `cash_alloc_invoice_idx` ON `cash_allocations` (`invoice_id`);

INSERT INTO `cash_entries` (`id`, `org_id`, `kind`, `date`, `customer_id`, `amount_cents`, `payment_method_id`, `payment_method_name`, `reference`, `card_payment_id`, `created_at`)
SELECT lower(hex(randomblob(16))), cp.org_id, 'RECEIPT', substr(coalesce(cp.completed_at, cp.created_at), 1, 10), i.customer_id, cp.amount_cents,
  (SELECT pm.id FROM payment_methods pm WHERE pm.org_id = cp.org_id AND pm.mydata_type = '7' AND pm.active = 1 ORDER BY pm.is_default DESC, pm.created_at LIMIT 1),
  coalesce((SELECT pm.name FROM payment_methods pm WHERE pm.org_id = cp.org_id AND pm.mydata_type = '7' AND pm.active = 1 ORDER BY pm.is_default DESC, pm.created_at LIMIT 1), 'Κάρτα (Viva)'),
  cp.transaction_id, cp.id, coalesce(cp.completed_at, cp.created_at)
FROM card_payments cp JOIN invoices i ON i.id = cp.invoice_id
WHERE cp.status = 'SUCCESS';

INSERT INTO `cash_allocations` (`id`, `entry_id`, `invoice_id`, `amount_cents`)
SELECT lower(hex(randomblob(16))), ce.id, cp.invoice_id, ce.amount_cents
FROM cash_entries ce JOIN card_payments cp ON cp.id = ce.card_payment_id;
