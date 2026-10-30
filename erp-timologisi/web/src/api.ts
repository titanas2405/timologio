// Πελάτης του API. Μέχρι να γίνει σύνδεση χρηστών, ο οργανισμός κρατιέται στο localStorage
// και στέλνεται στην κεφαλίδα x-org-id.
const ORG_KEY = "orgId";

export function getOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function setOrgId(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    // χωρίς localStorage η επιλογή χάνεται στην ανανέωση, αλλά η εφαρμογή δουλεύει
  }
  window.dispatchEvent(new Event("org-changed"));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: string;
  details?: { path: (string | number)[]; message: string }[];
}

function errorMessage(body: ErrorBody | null, status: number): string {
  if (!body?.error) return `Σφάλμα διακομιστή (${status})`;
  if (!body.details?.length) return body.error;
  return `${body.error}: ${body.details.map((d) => d.message).join(", ")}`;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const orgId = getOrgId();
  if (orgId) headers["x-org-id"] = orgId;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && orgId) setOrgId(null);
    throw new ApiError(res.status, errorMessage(data, res.status));
  }
  return data as T;
}

// --- Τύποι όπως τους επιστρέφει το API ---

export interface Organization {
  id: string;
  name: string;
  vatNumber: string;
  address: string | null;
  logo: string | null; // data URL
  cashLimitMode: "WARN" | "CONFIRM" | "BLOCK"; // μετρητά πάνω από το όριο
  suggestLastPrice: boolean; // πρόταση τελευταίας τιμής πελάτη στο τιμολόγιο
  defaultPricesIncludeVat: boolean; // προεπιλογή για νέα παραστατικά: τιμές με ΦΠΑ
}

export interface PastSale {
  invoiceId: string;
  seriesCode: string;
  number: number | null;
  issueDate: string | null;
  customerId: string;
  customerName: string;
  quantity: number;
  unitPriceCents: number; // χωρίς ΦΠΑ
  unitPriceGrossCents: number | null; // όπως γράφτηκε, αν το παραστατικό είχε τιμές με ΦΠΑ
  vatCategory: number;
}

export interface PriceHistory {
  item: { id: string; code: string | null; name: string; unit: string; unitPriceCents: number; retailPriceCents: number | null; vatCategory: number };
  lastCost: { unitCostCents: number; date: string; supplierName: string | null } | null;
  avgCostCents: number | null;
  purchases: { date: string; quantity: number; unitCostCents: number; supplierName: string | null }[];
  customerSales: PastSale[];
  recentSales: PastSale[];
}

// Τελευταία τιμή ανά είδος σε έναν πελάτη (κλειδί: itemId)
export type LastPrices = Record<
  string,
  { unitPriceCents: number; unitPriceGrossCents: number | null; vatCategory: number; date: string | null; invoiceId: string; seriesCode: string; number: number | null }
>;

export interface CodeSettings {
  entity: "customers" | "suppliers" | "items";
  label: string;
  mode: "AUTO" | "MANUAL";
  prefix: string;
  digits: number;
  nextNumber: number;
  nextCode: string; // ο κωδικός της επόμενης νέας εγγραφής
  missing: number; // εγγραφές χωρίς κωδικό
}

export interface Supplier {
  id: string;
  code: string | null;
  name: string;
  vatNumber: string | null;
  country: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
  receipts: number;
  lastReceipt: string | null;
  items: number; // είδη με αυτόν τον προμηθευτή
}

// Αποτέλεσμα «Αναζήτηση ΑΦΜ»
export interface RegistryResult {
  afm: string;
  name: string;
  commercialTitle?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  doy?: string;
  active?: boolean;
  activity?: string;
  source: "aade" | "vies";
}

export type CardPaymentStatus = "PENDING" | "SUCCESS" | "FAILED" | "ABORTED";

export interface CardPayment {
  id: string;
  invoiceId: string;
  sessionId: string;
  terminalId: string;
  amountCents: number;
  status: CardPaymentStatus;
  message: string | null;
  transactionId: string | null;
  authorizationId: string | null;
  cardType: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CardPaymentSummary {
  payments: CardPayment[];
  paidCents: number;
  remainingCents: number;
  configured: boolean;
}

export interface LinkedDoc {
  id: string;
  seriesCode: string;
  number: number | null;
  status: InvoiceStatus;
  issueDate: string | null;
  mark: string | null;
}

export interface Customer {
  id: string;
  code: string | null;
  name: string;
  vatNumber: string | null;
  country: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
}

export interface Item {
  id: string;
  code: string | null;
  barcode: string | null;
  name: string;
  retailPriceCents: number | null; // τιμή λιανικής, με ΦΠΑ (η unitPriceCents είναι η χονδρική, χωρίς ΦΠΑ)
  supplierId: string | null; // ο προμηθευτής του είδους
  supplierItemCode: string | null; // κωδικός του είδους στον προμηθευτή
  supplierName?: string | null;
  lastCostCents?: number | null; // τελευταία τιμή αγοράς (από παραλαβές)
  lastCostDate?: string | null;
  unitPriceCents: number;
  vatCategory: number;
  trackStock: boolean;
  unit: string;
  incomeClassCategory: string | null; // τι είναι: εμπόρευμα / προϊόν / υπηρεσία
}

export interface PaymentMethod {
  id: string;
  name: string;
  mydataType: string;
  details: string | null;
  isDefault: boolean;
  settlesOnIssue: boolean; // το τιμολόγιο εξοφλείται με την έκδοση (π.χ. μετρητά)
  active: boolean;
  invoices: number; // σε πόσα παραστατικά έχει χρησιμοποιηθεί
}

export interface StockRow {
  itemId: string;
  supplierId: string | null; // προτείνεται στην παραλαβή
  name: string;
  unit: string;
  unitPriceCents: number;
  quantity: number;
  lastMovement: string | null;
  movements: number;
}

export type MovementType = "IN" | "OUT" | "ADJUST" | "SALE" | "CREDIT" | "DISPATCH";

export interface Movement {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  date: string;
  type: MovementType;
  quantity: number;
  unitCostCents: number | null;
  note: string | null;
  invoiceId: string | null;
  invoiceSeries: string | null;
  invoiceNumber: number | null;
  supplierId: string | null;
  supplierName: string | null;
  balance: number | null;
}

export interface Series {
  id: string;
  code: string;
  docType: string;
  nextNumber: number;
}

export type InvoiceStatus = "DRAFT" | "ISSUED";
export type MydataStatus = "NOT_SENT" | "PENDING" | "SENT" | "FAILED";

export interface InvoiceSummary {
  id: string;
  docType: string;
  status: InvoiceStatus;
  seriesCode: string;
  number: number | null;
  issueDate: string | null;
  customerName: string;
  netCents: number;
  vatCents: number;
  grossCents: number;
  mydataStatus: MydataStatus;
  mark: string | null;
  customerId: string;
  movePurpose: number | null;
  invoicedById: string | null; // για δελτία αποστολής
  correlatedInvoiceId: string | null; // δελτίο που εκδόθηκε για τιμολόγιο
  paidCents: number; // πόσα έχουν εισπραχθεί
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  sourceLineId: string | null;
  incomeClassCategory: string | null; // χαρακτηρισμός εσόδου (κενό στο πρόχειρο = αυτόματα)
  incomeClassType: string | null;
  itemCode: string | null; // κωδικός είδους (στα εκδομένα: όπως ήταν στην έκδοση)
  shippedQuantity?: number; // τιμολόγιο: πόσα έχουν σταλεί με εκδομένα δελτία
  shippable?: boolean; // τιμολόγιο: αγαθό (όχι υπηρεσία)
  description: string;
  quantity: number;
  unitPriceCents: number;
  unitPriceGrossCents: number | null; // τιμή μονάδας με ΦΠΑ, όταν το παραστατικό έχει τιμές με ΦΠΑ
  discountPercent: number; // έκπτωση γραμμής %
  discountCents: number; // πόσο μείωσε η έκπτωση την καθαρή αξία
  vatCategory: number;
  netCents: number;
  vatCents: number;
}

export interface Invoice {
  id: string;
  customerId: string;
  seriesId: string;
  seriesCode: string;
  docType: string;
  status: InvoiceStatus;
  number: number | null;
  issueDate: string | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
  paymentMethod: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  paymentMethodDetails: string | null;
  mydataStatus: MydataStatus;
  mark: string | null;
  createdAt: string;
  customer: Customer;
  lines: InvoiceLine[];
  // Δελτίο αποστολής
  movePurpose: number | null;
  otherMovePurposeTitle: string | null;
  dispatchDate: string | null;
  dispatchTime: string | null;
  vehicleNumber: string | null;
  loadingAddress: string | null;
  deliveryAddress: string | null;
  deliveryNotes: LinkedDoc[]; // δελτία που τιμολογεί
  invoicedBy: LinkedDoc | null; // τιμολόγιο που τιμολόγησε το δελτίο
  actsAsDeliveryNote: boolean; // τιμολόγιο που είναι και δελτίο αποστολής
  pricesIncludeVat: boolean; // οι τιμές μονάδας γράφτηκαν με ΦΠΑ
  correlatedInvoiceId: string | null;
  correlatedInvoice: LinkedDoc | null; // δελτίο: το αρχικό τιμολόγιο
  shippedBy: LinkedDoc[]; // τιμολόγιο: τα δελτία που εκδόθηκαν γι' αυτό
  canShip?: boolean; // τιμολόγιο: υπάρχουν αγαθά χωρίς δελτίο
  paidCents?: number; // εξόφληση από εισπράξεις
  receipts?: InvoiceReceipt[];
}

export interface InvoiceReceipt {
  entryId: string;
  date: string;
  amountCents: number; // ποσό που εξόφλησε αυτό το τιμολόγιο
  paymentMethodName: string | null;
  reference: string | null;
  card: boolean;
}

export type CashKind = "RECEIPT" | "PAYMENT";

export interface CashAllocation {
  invoiceId: string;
  amountCents: number;
  seriesCode: string;
  number: number | null;
  issueDate: string | null;
  grossCents: number;
}

export interface CashEntry {
  id: string;
  kind: CashKind;
  date: string;
  customerId: string | null;
  supplierId: string | null;
  payee: string | null;
  party: string;
  amountCents: number;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  reference: string | null;
  notes: string | null;
  cardPaymentId: string | null;
  allocations: CashAllocation[];
  onAccountCents: number; // έναντι (χωρίς τιμολόγιο)
}

export interface OpenInvoice {
  id: string;
  docType: string;
  seriesCode: string;
  number: number | null;
  issueDate: string | null;
  grossCents: number;
  paidCents: number;
  openCents: number;
}

export interface CustomerBalance {
  id: string;
  code: string | null;
  name: string;
  vatNumber: string | null;
  invoicedCents: number;
  receivedCents: number;
  balanceCents: number;
  openInvoices: number;
  oldestOpenDate: string | null;
  lastReceipt: string | null;
}

export interface StatementRow {
  kind: "INVOICE" | "CREDIT" | "RECEIPT";
  id: string;
  date: string;
  label: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

export interface Statement {
  customer: { id: string; code: string | null; name: string; vatNumber: string | null };
  from: string | null;
  to: string | null;
  openingCents: number;
  closingCents: number;
  rows: StatementRow[];
}
