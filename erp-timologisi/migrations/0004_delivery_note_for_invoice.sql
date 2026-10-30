-- Δελτίο αποστολής για ήδη εκδομένο τιμολόγιο: αναφορά στο αρχικό τιμολόγιο. Νέα προαιρετική στήλη, χωρίς απώλειες.
ALTER TABLE `invoices` ADD `correlated_invoice_id` text REFERENCES `invoices`(`id`);
