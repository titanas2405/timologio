-- Ρύθμιση για μετρητά πάνω από το όριο (WARN | CONFIRM | BLOCK). Νέα στήλη με προεπιλογή, χωρίς απώλειες.
ALTER TABLE `organizations` ADD `cash_limit_mode` text DEFAULT 'CONFIRM' NOT NULL;
