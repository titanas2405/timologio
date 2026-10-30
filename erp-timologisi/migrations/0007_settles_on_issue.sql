-- Τρόποι πληρωμής που εξοφλούν το τιμολόγιο με την έκδοση. Νέα στήλη με προεπιλογή false, χωρίς απώλειες.
-- Οι υπάρχοντες τρόποι «Μετρητά» (κωδικός myDATA 3) ενεργοποιούνται. Τα ήδη εκδομένα τιμολόγια δεν αλλάζουν.
ALTER TABLE `payment_methods` ADD `settles_on_issue` integer DEFAULT false NOT NULL;
UPDATE `payment_methods` SET `settles_on_issue` = 1 WHERE `mydata_type` = '3';
