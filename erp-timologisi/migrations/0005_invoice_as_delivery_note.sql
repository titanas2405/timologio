-- Τιμολόγιο που είναι και δελτίο αποστολής (myDATA isDeliveryNote). Νέα στήλη με προεπιλογή false, χωρίς απώλειες.
-- (Για στήλες NOT NULL με προεπιλογή το drizzle-kit push έχει προτείνει στο παρελθόν διαγραφή γραμμών· γι' αυτό με το χέρι.)
ALTER TABLE `invoices` ADD `acts_as_delivery_note` integer DEFAULT false NOT NULL;
