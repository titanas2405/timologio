// Σχήμα βάσης (Drizzle, SQLite). Για παραγωγή με PostgreSQL ξαναγράφεται με drizzle-orm/pg-core
// (ίδιες στήλες και ονόματα). Τα ποσά αποθηκεύονται ΠΑΝΤΑ σε λεπτά (integer).
import { sqliteTable, text, integer, real, uniqueIndex, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const createdAt = () =>
  text("created_at").notNull().$defaultFn(() => new Date().toISOString());

// Κάθε εγγραφή ανήκει σε έναν οργανισμό (tenant). Όλα τα queries φιλτράρονται με org_id.
export const organizations = sqliteTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  vatNumber: text("vat_number").notNull(), // ΑΦΜ εκδότη
  address: text("address"), // έδρα· προτείνεται ως τόπος φόρτωσης στα δελτία αποστολής
  logo: text("logo"), // data URL (png/jpeg/webp), εμφανίζεται στα παραστατικά
  // Μετρητά πάνω από το όριο: WARN (μόνο μήνυμα) | CONFIRM (ερώτηση πριν την έκδοση) | BLOCK (απαγόρευση)
  cashLimitMode: text("cash_limit_mode").notNull().default("CONFIRM"),
  // Στο τιμολόγιο: όταν διαλέγεται είδος, προτείνεται η τελευταία τιμή που δόθηκε στον ίδιο πελάτη
  suggestLastPrice: integer("suggest_last_price", { mode: "boolean" }).notNull().default(true),
  // Προεπιλογή για νέα παραστατικά: οι τιμές γράφονται με ΦΠΑ (αλλάζει σε κάθε παραστατικό)
  defaultPricesIncludeVat: integer("default_prices_include_vat", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

// Συνδέσεις με εξωτερικές υπηρεσίες ανά οργανισμό (ΑΑΔΕ μητρώο, Viva κ.λπ.).
// Το config περιέχει κωδικούς και αποθηκεύεται ΜΟΝΟ κρυπτογραφημένο (src/crypto.ts).
export const integrations = sqliteTable(
  "integrations",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    kind: text("kind").notNull(), // aade_registry | viva
    configEncrypted: text("config_encrypted").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("integrations_org_kind").on(t.orgId, t.kind)],
);

// Κωδικοποίηση πελατών / προμηθευτών / ειδών: αυτόματα (πρόθεμα + αύξων αριθμός) ή χειροκίνητα.
// Μία γραμμή ανά (οργανισμό, κατηγορία)· αν λείπει, ισχύουν οι προεπιλογές του src/domain/codes.ts.
export const codeSequences = sqliteTable(
  "code_sequences",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    entity: text("entity").notNull(), // customers | suppliers | items
    mode: text("mode").notNull().default("AUTO"), // AUTO | MANUAL
    prefix: text("prefix").notNull().default(""),
    digits: integer("digits").notNull().default(4),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [uniqueIndex("code_sequences_org_entity").on(t.orgId, t.entity)],
);

export const customers = sqliteTable(
  "customers",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    code: text("code"), // μοναδικός ανά οργανισμό (βλ. code_sequences)
    name: text("name").notNull(),
    vatNumber: text("vat_number"), // προαιρετικό για ιδιώτες
    country: text("country").notNull().default("GR"),
    address: text("address"),
    city: text("city"),
    postalCode: text("postal_code"),
    email: text("email"),
    createdAt: createdAt(),
  },
  (t) => [index("customers_org_idx").on(t.orgId), uniqueIndex("customers_org_code").on(t.orgId, t.code)],
);

export const suppliers = sqliteTable(
  "suppliers",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    code: text("code"),
    name: text("name").notNull(),
    vatNumber: text("vat_number"),
    country: text("country").notNull().default("GR"),
    address: text("address"),
    city: text("city"),
    postalCode: text("postal_code"),
    email: text("email"),
    createdAt: createdAt(),
  },
  (t) => [index("suppliers_org_idx").on(t.orgId), uniqueIndex("suppliers_org_code").on(t.orgId, t.code)],
);

export const items = sqliteTable(
  "items",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    code: text("code"),
    barcode: text("barcode"), // EAN / barcode για σκάνερ
    name: text("name").notNull(),
    // Ο (ένας) προμηθευτής του είδους και ο κωδικός του είδους στον προμηθευτή.
    // Προτείνεται αυτόματα στις παραλαβές· η τελευταία τιμή αγοράς βγαίνει από τις παραλαβές.
    supplierId: text("supplier_id").references(() => suppliers.id),
    supplierItemCode: text("supplier_item_code"),
    unitPriceCents: integer("unit_price_cents").notNull(), // τιμή χονδρικής, χωρίς ΦΠΑ
    retailPriceCents: integer("retail_price_cents"), // τιμή λιανικής, ΜΕ ΦΠΑ (προαιρετική)
    vatCategory: integer("vat_category").notNull().default(1), // βλ. src/domain/vat.ts
    // Χαρακτηρισμός εσόδου myDATA, συμπληρώνεται σύμφωνα με τους πίνακες της ΑΑΔΕ
    incomeClassCategory: text("income_class_category"),
    incomeClassType: text("income_class_type"),
    // Αν true, το είδος έχει απόθεμα (κινήσεις αποθήκης). Οι υπηρεσίες συνήθως όχι.
    trackStock: integer("track_stock", { mode: "boolean" }).notNull().default(false),
    unit: text("unit").notNull().default("τεμ."),
    createdAt: createdAt(),
  },
  (t) => [index("items_org_idx").on(t.orgId), uniqueIndex("items_org_code").on(t.orgId, t.code)],
);

// Σειρά παραστατικών: συνεχής αρίθμηση ανά (org, code, docType)
export const invoiceSeries = sqliteTable(
  "invoice_series",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    code: text("code").notNull(), // π.χ. "Α"
    docType: text("doc_type").notNull(), // τύπος myDATA, π.χ. "1.1"
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [uniqueIndex("series_unique").on(t.orgId, t.code, t.docType)],
);

// Τρόποι πληρωμής του οργανισμού. Ο χρήστης τους ονομάζει όπως θέλει (π.χ. «Πειραιώς – κατάθεση»),
// αλλά καθένας αντιστοιχεί υποχρεωτικά σε κωδικό myDATA (src/domain/payment-methods.ts).
export const paymentMethods = sqliteTable(
  "payment_methods",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    mydataType: text("mydata_type").notNull(),
    details: text("details"), // π.χ. IBAN, τυπώνεται στο παραστατικό
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    // Το τιμολόγιο θεωρείται εξοφλημένο τη στιγμή της έκδοσης (π.χ. μετρητά): γράφεται αυτόματα είσπραξη
    settlesOnIssue: integer("settles_on_issue", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("payment_methods_org_idx").on(t.orgId)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    customerId: text("customer_id").notNull().references(() => customers.id),
    seriesId: text("series_id").notNull().references(() => invoiceSeries.id),
    docType: text("doc_type").notNull(),
    status: text("status").notNull().default("DRAFT"), // DRAFT | ISSUED
    number: integer("number"), // ορίζεται μόνο κατά την έκδοση
    issueDate: text("issue_date"),
    currency: text("currency").notNull().default("EUR"),
    netCents: integer("net_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    grossCents: integer("gross_cents").notNull(),
    paymentMethod: text("payment_method"), // κωδικός myDATA
    // Ο τρόπος πληρωμής του οργανισμού και αντίγραφο ονόματος/στοιχείων (ανανεώνεται στην έκδοση,
    // ώστε μια μεταγενέστερη αλλαγή του τρόπου πληρωμής να μην αλλάζει εκδομένα παραστατικά)
    paymentMethodId: text("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
    paymentMethodName: text("payment_method_name"),
    paymentMethodDetails: text("payment_method_details"),
    // Στοιχεία πελάτη όπως ήταν τη στιγμή της έκδοσης. Αν αλλάξει αργότερα η καρτέλα του πελάτη,
    // το εκδομένο παραστατικό δεν αλλάζει. Κενά (null) σε πρόχειρα.
    customerCode: text("customer_code"),
    customerName: text("customer_name"),
    customerVatNumber: text("customer_vat_number"),
    customerCountry: text("customer_country"),
    customerAddress: text("customer_address"),
    customerCity: text("customer_city"),
    customerPostalCode: text("customer_postal_code"),
    // Τιμολόγιο που είναι ταυτόχρονα και δελτίο αποστολής (myDATA isDeliveryNote): έχει στοιχεία διακίνησης
    actsAsDeliveryNote: integer("acts_as_delivery_note", { mode: "boolean" }).notNull().default(false),
    // Οι τιμές μονάδας γράφτηκαν με ΦΠΑ (βλ. src/domain/totals.ts)
    pricesIncludeVat: integer("prices_include_vat", { mode: "boolean" }).notNull().default(false),
    // Στοιχεία διακίνησης (δελτίο αποστολής 9.3, ή τιμολόγιο-δελτίο)
    movePurpose: integer("move_purpose"), // κωδικός σκοπού διακίνησης myDATA (src/domain/movement.ts)
    otherMovePurposeTitle: text("other_move_purpose_title"), // για σκοπό 19 «Λοιπές διακινήσεις»
    dispatchDate: text("dispatch_date"),
    dispatchTime: text("dispatch_time"), // HH:MM
    vehicleNumber: text("vehicle_number"),
    loadingAddress: text("loading_address"),
    deliveryAddress: text("delivery_address"),
    // Δελτίο που εκδόθηκε για ήδη εκδομένο τιμολόγιο (πρώτα τιμολόγιο, μετά αποστολή).
    // Οι γραμμές του δείχνουν (sourceLineId) τις γραμμές του τιμολογίου και δεν κινούν ξανά αποθήκη.
    correlatedInvoiceId: text("correlated_invoice_id").references((): AnySQLiteColumn => invoices.id),
    // Πεδία myDATA, συμπληρώνονται μετά τη διαβίβαση
    mydataStatus: text("mydata_status").notNull().default("NOT_SENT"), // NOT_SENT | PENDING | SENT | FAILED
    mark: text("mark"), // Μοναδικός Αριθμός Καταχώρησης (ΜΑΡΚ)
    uid: text("uid"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoice_number_unique").on(t.seriesId, t.number),
    index("invoices_org_idx").on(t.orgId),
  ],
);

export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    quantity: real("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(), // χωρίς ΦΠΑ
    unitPriceGrossCents: integer("unit_price_gross_cents"), // όπως γράφτηκε, όταν οι τιμές είναι με ΦΠΑ
    discountPercent: real("discount_percent").notNull().default(0), // έκπτωση γραμμής %
    discountCents: integer("discount_cents").notNull().default(0), // πόσο μείωσε η έκπτωση την καθαρή αξία
    vatCategory: integer("vat_category").notNull(),
    netCents: integer("net_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    incomeClassCategory: text("income_class_category"),
    incomeClassType: text("income_class_type"),
    itemCode: text("item_code"), // κωδικός είδους όπως ήταν στην έκδοση
    // Το είδος από το οποίο προήλθε η γραμμή (προαιρετικό). Χρειάζεται για την κίνηση αποθήκης στην έκδοση.
    itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
    // Γραμμή δελτίου αποστολής από την οποία προήλθε (τιμολόγηση δελτίων). Τέτοιες γραμμές
    // δεν κινούν ξανά την αποθήκη: η κίνηση έγινε ήδη με το δελτίο.
    sourceLineId: text("source_line_id"),
  },
  (t) => [index("lines_invoice_idx").on(t.invoiceId)],
);

// Τιμολόγιο <-> δελτία αποστολής που τιμολογεί. Κάθε δελτίο τιμολογείται μία φορά.
export const invoiceLinks = sqliteTable(
  "invoice_links",
  {
    id: id(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    deliveryNoteId: text("delivery_note_id").notNull().references(() => invoices.id),
  },
  (t) => [uniqueIndex("invoice_links_note_unique").on(t.deliveryNoteId), index("invoice_links_invoice_idx").on(t.invoiceId)],
);

// Πληρωμές με κάρτα μέσω τερματικού (π.χ. Viva SoftPOS). Μία εγγραφή ανά προσπάθεια χρέωσης.
export const cardPayments = sqliteTable(
  "card_payments",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    provider: text("provider").notNull(), // viva
    sessionId: text("session_id").notNull(),
    terminalId: text("terminal_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | SUCCESS | FAILED | ABORTED
    message: text("message"),
    transactionId: text("transaction_id"),
    authorizationId: text("authorization_id"),
    cardType: text("card_type"),
    createdAt: createdAt(),
    completedAt: text("completed_at"),
  },
  (t) => [index("card_payments_invoice_idx").on(t.invoiceId)],
);

// Εισπράξεις από πελάτες (RECEIPT) και πληρωμές σε προμηθευτές ή τρίτους (PAYMENT).
// Δεν είναι παραστατικά myDATA: καταγράφουν την κίνηση χρημάτων. Μια είσπραξη εξοφλεί ένα ή περισσότερα
// τιμολόγια (cash_allocations)· ό,τι δεν κατανεμηθεί μένει «έναντι» στον πελάτη.
export const cashEntries = sqliteTable(
  "cash_entries",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    kind: text("kind").notNull(), // RECEIPT | PAYMENT
    date: text("date").notNull(), // YYYY-MM-DD
    customerId: text("customer_id").references(() => customers.id), // εισπράξεις
    supplierId: text("supplier_id").references(() => suppliers.id), // πληρωμές σε προμηθευτή
    payee: text("payee"), // πληρωμές σε τρίτους χωρίς καρτέλα (π.χ. ΔΕΗ, ενοίκιο)
    amountCents: integer("amount_cents").notNull(), // πάντα θετικό
    paymentMethodId: text("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
    paymentMethodName: text("payment_method_name"), // αντίγραφο, για να μην αλλάζει αν μετονομαστεί ο τρόπος
    reference: text("reference"), // π.χ. αριθμός επιταγής ή συναλλαγής
    notes: text("notes"),
    // Είσπραξη που δημιουργήθηκε αυτόματα από εγκεκριμένη χρέωση κάρτας (δεν αλλάζει με το χέρι)
    cardPaymentId: text("card_payment_id").references(() => cardPayments.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("cash_org_date_idx").on(t.orgId, t.date),
    index("cash_customer_idx").on(t.customerId),
    uniqueIndex("cash_card_payment_unique").on(t.cardPaymentId),
  ],
);

export const cashAllocations = sqliteTable(
  "cash_allocations",
  {
    id: id(),
    entryId: text("entry_id").notNull().references(() => cashEntries.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [uniqueIndex("cash_alloc_unique").on(t.entryId, t.invoiceId), index("cash_alloc_invoice_idx").on(t.invoiceId)],
);

// Κινήσεις αποθήκης. Το απόθεμα ΔΕΝ αποθηκεύεται πουθενά: είναι πάντα το άθροισμα των κινήσεων.
// quantity με πρόσημο: + είσοδος, - έξοδος.
// type: IN (παραλαβή) | OUT (εξαγωγή/φθορά) | ADJUST (απογραφή) | SALE (από τιμολόγιο) | CREDIT (από πιστωτικό)
export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    itemId: text("item_id").notNull().references(() => items.id),
    date: text("date").notNull(), // YYYY-MM-DD
    type: text("type").notNull(),
    quantity: real("quantity").notNull(),
    unitCostCents: integer("unit_cost_cents"), // κόστος μονάδας σε παραλαβές
    supplierId: text("supplier_id").references(() => suppliers.id), // σε παραλαβές
    note: text("note"),
    invoiceId: text("invoice_id").references(() => invoices.id),
    createdAt: createdAt(),
  },
  (t) => [index("stock_org_item_idx").on(t.orgId, t.itemId), index("stock_invoice_idx").on(t.invoiceId)],
);

// Outbox: ό,τι πρέπει να σταλεί στο myDATA. Το στέλνει ξεχωριστός worker, όχι το αίτημα του χρήστη.
export const mydataSubmissions = sqliteTable(
  "mydata_submissions",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    status: text("status").notNull().default("PENDING"), // PENDING | SENT | FAILED
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: text("sent_at"),
  },
  (t) => [index("submissions_status_idx").on(t.status)],
);
