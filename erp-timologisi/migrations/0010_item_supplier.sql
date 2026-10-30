-- Ένας προμηθευτής ανά είδος (+ κωδικός του είδους στον προμηθευτή). Νέες στήλες χωρίς τιμή, χωρίς απώλειες.
-- Τα είδη που έχουν ήδη παραλαβές με προμηθευτή παίρνουν τον προμηθευτή της πιο πρόσφατης.
ALTER TABLE `items` ADD `supplier_id` text REFERENCES `suppliers`(`id`);
ALTER TABLE `items` ADD `supplier_item_code` text;
UPDATE `items` SET `supplier_id` = (
  SELECT sm.supplier_id FROM stock_movements sm
  WHERE sm.item_id = items.id AND sm.type = 'IN' AND sm.supplier_id IS NOT NULL
  ORDER BY sm.date DESC, sm.created_at DESC LIMIT 1
) WHERE `supplier_id` IS NULL;
