-- Έκπτωση ανά γραμμή παραστατικού. Νέες στήλες με προεπιλογή 0, χωρίς απώλειες.
ALTER TABLE `invoice_lines` ADD `discount_percent` real DEFAULT 0 NOT NULL;
ALTER TABLE `invoice_lines` ADD `discount_cents` integer DEFAULT 0 NOT NULL;
