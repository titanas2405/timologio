-- Ρύθμιση «Πρόταση τελευταίας τιμής πελάτη» στο τιμολόγιο. Νέα στήλη με προεπιλογή (ενεργή), χωρίς απώλειες.
ALTER TABLE `organizations` ADD `suggest_last_price` integer DEFAULT true NOT NULL;
