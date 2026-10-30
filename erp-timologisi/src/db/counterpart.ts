import type { customers, invoices } from "./schema.js";

type Customer = typeof customers.$inferSelect;
type Invoice = typeof invoices.$inferSelect;

// Ο πελάτης όπως πρέπει να εμφανίζεται/διαβιβάζεται για ένα παραστατικό:
// το αντίγραφο της έκδοσης αν υπάρχει, αλλιώς (πρόχειρο) η τρέχουσα καρτέλα.
export function counterpartOf(inv: Invoice, live: Customer): Customer {
  if (inv.customerName === null) return live;
  return {
    ...live,
    code: inv.customerCode,
    name: inv.customerName,
    vatNumber: inv.customerVatNumber,
    country: inv.customerCountry ?? live.country,
    address: inv.customerAddress,
    city: inv.customerCity,
    postalCode: inv.customerPostalCode,
  };
}

export function snapshotOf(c: Customer) {
  return {
    customerCode: c.code,
    customerName: c.name,
    customerVatNumber: c.vatNumber,
    customerCountry: c.country,
    customerAddress: c.address,
    customerCity: c.city,
    customerPostalCode: c.postalCode,
  };
}
