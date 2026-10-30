-- Τιμή λιανικής (με ΦΠΑ) στα είδη, και τιμές με ΦΠΑ στα παραστατικά. Νέες στήλες, χωρίς απώλειες.
-- Η υπάρχουσα τιμή του είδους γίνεται «τιμή χονδρικής» (χωρίς ΦΠΑ), όπως ήταν.
ALTER TABLE `items` ADD `retail_price_cents` integer;
ALTER TABLE `organizations` ADD `default_prices_include_vat` integer DEFAULT false NOT NULL;
ALTER TABLE `invoices` ADD `prices_include_vat` integer DEFAULT false NOT NULL;
ALTER TABLE `invoice_lines` ADD `unit_price_gross_cents` integer;
