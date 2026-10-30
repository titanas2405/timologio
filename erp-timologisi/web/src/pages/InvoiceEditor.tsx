import { useEffect, useMemo, useState } from "react";
import { api, type Customer, type Invoice, type Item, type LastPrices, type Organization, type PaymentMethod, type Series, type StockRow } from "../api";
import { PriceHistoryPanel } from "./PriceHistory";
import { CREDIT_DOC_TYPES, DOC_TYPES, INVOICING_TYPES, isDeliveryNote } from "../../../src/domain/doc-types";
import { CashLimitAlert, cashLimitState, confirmCashLimit } from "../cashLimit";
import { INVOICEABLE_PURPOSES, MOVE_PURPOSES, OTHER_MOVE_PURPOSE } from "../../../src/domain/movement";
import { todayInGreece } from "../../../src/domain/dates";
import { roundQty } from "../../../src/domain/stock";
import { INCOME_CATEGORIES, INCOME_TYPES, resolveClassification } from "../../../src/domain/classification";
import { computeTotals, grossToNet, netToGross, withVatMode, type LineInput } from "../../../src/domain/totals";
import { centsToInput, docNumber, formatCents, formatDate, formatQty, parseDecimal, parseMoneyToCents } from "../format";
import { useLoad } from "../hooks";
import { navigate } from "../router";
import { ErrorBox, Field, Loading, Modal, PageHeader } from "../ui";
import { CustomerForm } from "./Customers";
import { VatSelect, vatLabel } from "./Items";

// Γραμμή όπως την πληκτρολογεί ο χρήστης (κείμενο). Μετατρέπεται σε LineInput μόνο όταν είναι έγκυρη.
interface DraftLine {
  key: number;
  description: string;
  quantity: string;
  price: string;
  discount: string; // έκπτωση % (κενό = καμία)
  vatCategory: number;
  itemId?: string; // σύνδεση με είδος: χρειάζεται για την αποθήκη
  code?: string; // ό,τι γράφει ο χρήστης στη στήλη «Κωδικός»· απόν = ο κωδικός του συνδεδεμένου είδους
  priceFrom?: LastPrices[string]; // η τιμή προτάθηκε από την τελευταία πώληση στον ίδιο πελάτη
  sourceLineId?: string; // γραμμή δελτίου αποστολής που τιμολογείται
  // Χαρακτηρισμός εσόδου: κενό = αυτόματα (κατηγορία από το είδος, τύπος Ε3 από τον πελάτη)
  incomeClassCategory?: string;
  incomeClassType?: string;
}

type LinePayload = LineInput & { sourceLineId?: string };

let nextKey = 1;
const emptyLine = (): DraftLine => ({ key: nextKey++, description: "", quantity: "1", price: "", discount: "", vatCategory: 1 });

// Έκπτωση γραμμής: κενό = 0· αλλιώς αριθμός 0–100 (null = μη έγκυρη)
function parseDiscount(s: string): number | null {
  if (!s.trim()) return 0;
  const d = parseDecimal(s.replace("%", ""));
  return d === null || d < 0 || d > 100 ? null : d;
}

// Στο δελτίο αποστολής η τιμή είναι προαιρετική (κενή = 0)
function toInput(l: DraftLine, priceOptional: boolean): LinePayload | null {
  const quantity = parseDecimal(l.quantity);
  const unitPriceCents = priceOptional && !l.price.trim() ? 0 : parseMoneyToCents(l.price);
  const discountPercent = parseDiscount(l.discount);
  if (!l.description.trim() || quantity === null || quantity <= 0 || unitPriceCents === null || unitPriceCents < 0 || discountPercent === null) return null;
  return {
    description: l.description.trim(),
    quantity,
    unitPriceCents,
    discountPercent: discountPercent || undefined,
    vatCategory: l.vatCategory,
    itemId: l.itemId,
    sourceLineId: l.sourceLineId,
    incomeClassCategory: l.incomeClassCategory,
    incomeClassType: l.incomeClassType,
  };
}

// Τύποι που απευθύνονται σε επιχειρήσεις και θέλουν ΑΦΜ αντισυμβαλλόμενου.
const B2B_TYPES = new Set(["1.1", "2.1", "5.1"]);

const nowTime = () => new Intl.DateTimeFormat("el-GR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Athens" }).format(new Date());

const addressOf = (c: Customer) => [c.address, c.postalCode, c.city].filter(Boolean).join(", ");

interface Delivery {
  movePurpose: number;
  otherMovePurposeTitle: string;
  dispatchDate: string;
  dispatchTime: string;
  vehicleNumber: string;
  loadingAddress: string;
  deliveryAddress: string;
}

export function InvoiceEditor({ invoiceId, kind = "invoice" }: { invoiceId?: string; kind?: "invoice" | "delivery" }) {
  const series = useLoad(() => api<Series[]>("/series"));
  const customers = useLoad(() => api<Customer[]>("/customers"));
  const items = useLoad(() => api<Item[]>("/items"));
  const stock = useLoad(() => api<StockRow[]>("/stock"));
  const [historyFor, setHistoryFor] = useState<number | null>(null); // γραμμή με ανοιχτό ιστορικό τιμών
  const methods = useLoad(() => api<PaymentMethod[]>("/payment-methods"));
  const org = useLoad(() => api<Organization>("/organizations/current"));

  const [seriesId, setSeriesId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [draft, setDraft] = useState<Invoice | null>(null);
  // Δελτίο για εκδομένο τιμολόγιο: το αρχικό τιμολόγιο, για τις ποσότητες που απομένουν
  const [origin, setOrigin] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const [delivery, setDelivery] = useState<Delivery>(() => ({
    movePurpose: 1,
    otherMovePurposeTitle: "",
    dispatchDate: todayInGreece(),
    dispatchTime: nowTime(),
    vehicleNumber: "",
    loadingAddress: "",
    deliveryAddress: "",
  }));
  // Τιμολόγιο που είναι και δελτίο αποστολής
  const [actsAsNote, setActsAsNote] = useState(false);
  // Οι τιμές μονάδας γράφονται με ΦΠΑ (ο χρήστης το ορίζει· προεπιλογή από τις Ρυθμίσεις)
  const [includeVat, setIncludeVat] = useState(false);
  const [vatModeSet, setVatModeSet] = useState(false);
  // Ο τόπος παράδοσης ακολουθεί τη διεύθυνση του πελάτη, μέχρι να τον αλλάξει ο χρήστης
  const [deliveryTouched, setDeliveryTouched] = useState(false);
  const [loadedDraft, setLoadedDraft] = useState(!invoiceId);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  // Αν η έκδοση αποτύχει αφού σωθεί το πρόχειρο, η επόμενη προσπάθεια ενημερώνει το ίδιο πρόχειρο
  const [savedId, setSavedId] = useState(invoiceId);

  // Επεξεργασία πρόχειρου: φόρτωσε τα υπάρχοντα στοιχεία
  useEffect(() => {
    if (!invoiceId) return;
    api<Invoice>(`/invoices/${invoiceId}`)
      .then((inv) => {
        if (inv.status !== "DRAFT") {
          navigate(`/invoices/${inv.id}`);
          return;
        }
        setSeriesId(inv.seriesId);
        setCustomerId(inv.customerId);
        setDraft(inv);
        if (inv.correlatedInvoiceId) api<Invoice>(`/invoices/${inv.correlatedInvoiceId}`).then(setOrigin).catch(() => {});
        setPaymentMethodId(inv.paymentMethodId ?? "");
        setLines(
          inv.lines.map((l) => ({
            key: nextKey++,
            description: l.description,
            quantity: formatQty(l.quantity),
            price:
              inv.pricesIncludeVat && l.unitPriceGrossCents != null
                ? centsToInput(l.unitPriceGrossCents)
                : l.unitPriceCents || !isDeliveryNote(inv.docType)
                  ? centsToInput(l.unitPriceCents)
                  : "",
            discount: l.discountPercent ? formatQty(l.discountPercent) : "",
            vatCategory: l.vatCategory,
            itemId: l.itemId ?? undefined,
            sourceLineId: l.sourceLineId ?? undefined,
            incomeClassCategory: l.incomeClassCategory ?? undefined,
            incomeClassType: l.incomeClassType ?? undefined,
          })),
        );
        setActsAsNote(inv.actsAsDeliveryNote);
        setIncludeVat(inv.pricesIncludeVat);
        setVatModeSet(true);
        if (isDeliveryNote(inv.docType) || inv.actsAsDeliveryNote) {
          setDelivery((d) => ({
            movePurpose: inv.movePurpose ?? d.movePurpose,
            otherMovePurposeTitle: inv.otherMovePurposeTitle ?? "",
            dispatchDate: inv.dispatchDate ?? d.dispatchDate,
            dispatchTime: inv.dispatchTime ?? d.dispatchTime,
            vehicleNumber: inv.vehicleNumber ?? "",
            loadingAddress: inv.loadingAddress ?? "",
            deliveryAddress: inv.deliveryAddress ?? "",
          }));
          setDeliveryTouched(!!inv.deliveryAddress);
        }
        setLoadedDraft(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [invoiceId]);

  // Νέο παραστατικό: ο προεπιλεγμένος τρόπος πληρωμής.
  // Παλιό πρόχειρο με μόνο κωδικό myDATA: ο πρώτος ενεργός τρόπος με αυτόν τον κωδικό.
  useEffect(() => {
    if (!methods.data) return;
    if (!invoiceId) {
      const def = methods.data.find((m) => m.isDefault && m.active);
      if (def) setPaymentMethodId((cur) => cur || def.id);
    } else if (draft && !draft.paymentMethodId && draft.paymentMethod) {
      const match = methods.data.find((m) => m.active && m.mydataType === draft.paymentMethod);
      if (match) setPaymentMethodId((cur) => cur || match.id);
    }
  }, [methods.data, invoiceId, draft]);

  // Σειρές που ταιριάζουν: δελτίο με δελτίο, τιμολόγιο με τιμολόγιο. Τιμολόγηση δελτίων: μόνο τιμολόγιο πώλησης.
  const wantNote = draft ? isDeliveryNote(draft.docType) : kind === "delivery";
  const allowedSeries = (series.data ?? []).filter((s) =>
    draft?.deliveryNotes.length ? INVOICING_TYPES.has(s.docType) : isDeliveryNote(s.docType) === wantNote,
  );

  // Προεπιλογή της πρώτης κατάλληλης σειράς για νέο παραστατικό
  useEffect(() => {
    if (!seriesId && !invoiceId && allowedSeries.length) setSeriesId(allowedSeries[0].id);
  }, [allowedSeries.length, seriesId, invoiceId]);

  // Τόπος φόρτωσης: η έδρα της επιχείρησης, αν δεν έχει συμπληρωθεί
  useEffect(() => {
    if (org.data?.address) setDelivery((d) => (d.loadingAddress ? d : { ...d, loadingAddress: org.data!.address! }));
  }, [org.data]);

  const selectedSeries = series.data?.find((s) => s.id === seriesId);
  const isNote = selectedSeries ? isDeliveryNote(selectedSeries.docType) : wantNote;
  const isCredit = !!selectedSeries && CREDIT_DOC_TYPES.has(selectedSeries.docType);
  const selectedMethod = methods.data?.find((m) => m.id === paymentMethodId);
  // Τιμολόγιο-δελτίο: μόνο τιμολόγιο πώλησης που δεν τιμολογεί ήδη δελτία
  const canActAsNote = !!selectedSeries && INVOICING_TYPES.has(selectedSeries.docType) && !draft?.deliveryNotes.length;
  const acts = actsAsNote && canActAsNote;
  const showMovement = isNote || acts;
  const customer = customers.data?.find((c) => c.id === customerId);
  // Τελευταίες τιμές ανά είδος στον επιλεγμένο πελάτη (για την πρόταση τιμής και το ιστορικό)
  const lastPrices = useLoad(() => (customerId ? api<LastPrices>(`/customers/${customerId}/last-prices`) : Promise.resolve({} as LastPrices)), [customerId]);

  useEffect(() => {
    if (customer && !deliveryTouched) setDelivery((d) => ({ ...d, deliveryAddress: addressOf(customer) }));
  }, [customer, deliveryTouched]);

  // Νέο παραστατικό: η προεπιλογή του οργανισμού για τιμές με/χωρίς ΦΠΑ
  useEffect(() => {
    if (!vatModeSet && !invoiceId && org.data) setIncludeVat(org.data.defaultPricesIncludeVat);
  }, [org.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const vatIncl = includeVat && !isNote; // τα δελτία αποστολής δεν έχουν αυτή την επιλογή

  // Αλλαγή του διακόπτη: οι τιμές που έχουν ήδη γραφτεί μετατρέπονται, ώστε τα ποσά να μείνουν ίδια
  function switchVatMode(on: boolean) {
    if (on === includeVat) return;
    setIncludeVat(on);
    setVatModeSet(true);
    setLines((ls) =>
      ls.map((l) => {
        const c = parseMoneyToCents(l.price);
        if (!l.price.trim() || c === null) return l;
        return { ...l, price: centsToInput(on ? netToGross(c, l.vatCategory) : grossToNet(c, l.vatCategory)) };
      }),
    );
  }

  const inputs = lines.map((l) => toInput(l, isNote));
  const valid = inputs.filter((l): l is LinePayload => l !== null);
  const totals = useMemo(() => computeTotals(withVatMode(valid, vatIncl)), [JSON.stringify(valid), vatIncl]);

  const vatBreakdown = useMemo(() => {
    const map = new Map<number, { net: number; vat: number }>();
    for (const l of totals.lines) {
      const row = map.get(l.vatCategory) ?? { net: 0, vat: 0 };
      row.net += l.netCents;
      row.vat += l.vatCents;
      map.set(l.vatCategory, row);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [totals]);

  // Όριο μετρητών (ρύθμιση στις Ρυθμίσεις: προειδοποίηση / επιβεβαίωση / απαγόρευση)
  const cashLimit = isNote ? null : cashLimitState(org.data?.cashLimitMode, selectedMethod?.mydataType, totals.grossCents);
  const needsVat = selectedSeries && B2B_TYPES.has(selectedSeries.docType) && customer && !customer.vatNumber;
  const setD = (patch: Partial<Delivery>) => setDelivery((d) => ({ ...d, ...patch }));

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // Τιμή τιμοκαταλόγου στον τρόπο που γράφονται οι τιμές: λιανική για ιδιώτη (αν υπάρχει), αλλιώς χονδρική
  function listPrice(item: Item, vatCategory = item.vatCategory) {
    const retail = item.retailPriceCents != null && !!customer && !customer.vatNumber;
    if (retail) return { cents: vatIncl ? item.retailPriceCents! : grossToNet(item.retailPriceCents!, vatCategory), label: "λιανική" };
    return { cents: vatIncl ? netToGross(item.unitPriceCents, vatCategory) : item.unitPriceCents, label: "χονδρική" };
  }

  // Η τελευταία τιμή στον πελάτη, στον τρόπο που γράφονται οι τιμές
  const lastInMode = (last: LastPrices[string]) =>
    vatIncl ? (last.unitPriceGrossCents ?? netToGross(last.unitPriceCents, last.vatCategory)) : last.unitPriceCents;

  // Τιμή για ένα είδος που μόλις επιλέχθηκε: η τελευταία στον πελάτη (αν είναι ενεργή η ρύθμιση), αλλιώς του τιμοκαταλόγου
  function priceFor(item: Item): Pick<DraftLine, "price" | "priceFrom"> {
    const last = org.data?.suggestLastPrice !== false && !isNote ? lastPrices.data?.[item.id] : undefined;
    return last ? { price: centsToInput(lastInMode(last)), priceFrom: last } : { price: centsToInput(listPrice(item).cents), priceFrom: undefined };
  }

  function onDescription(key: number, description: string) {
    // Αν η περιγραφή ταιριάζει με είδος από τη λίστα, συμπλήρωσε τιμή και ΦΠΑ και σύνδεσε το είδος.
    // Αλλαγή της περιγραφής μετά δεν χαλάει τη σύνδεση (π.χ. «Καρέκλα» -> «Καρέκλα μαύρη»).
    // Δέχεται και τον κωδικό ή το barcode του είδους (π.χ. από σκάνερ): μπαίνει η περιγραφή του.
    const typed = description.trim();
    const item = items.data?.find((i) => i.name === description) ?? (typed ? items.data?.find((i) => i.code === typed || i.barcode === typed) : undefined);
    if (item) {
      updateLine(key, { code: undefined, description: item.name === description ? description : item.name, ...priceFor(item), vatCategory: item.vatCategory, itemId: item.id });
    } else {
      updateLine(key, description.trim() ? { description } : { description, itemId: undefined });
    }
  }

  // Στήλη «Κωδικός»: κωδικός ή barcode που ταιριάζει ακριβώς συνδέει το είδος (περιγραφή, τιμή, ΦΠΑ)
  function onCode(key: number, code: string) {
    const typed = code.trim();
    const item = typed ? items.data?.find((i) => i.code === typed || i.barcode === typed) : undefined;
    if (item) {
      updateLine(key, { code: undefined, description: item.name, ...priceFor(item), vatCategory: item.vatCategory, itemId: item.id });
    } else {
      updateLine(key, { code });
    }
  }

  function removeLine(key: number) {
    setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((l) => l.key !== key)));
  }

  // Αποθηκεύει το πρόχειρο και επιστρέφει το id του
  async function save(): Promise<string | null> {
    setShowErrors(true);
    setError(null);
    if (!seriesId) return setError("Επιλέξτε σειρά"), null;
    if (!customerId) return setError("Επιλέξτε πελάτη"), null;
    const filled = lines.filter((l) => l.description.trim() || l.price.trim());
    if (filled.length === 0) return setError("Προσθέστε τουλάχιστον μία γραμμή"), null;
    const lineInputs = filled.map((l) => toInput(l, isNote));
    if (lineInputs.some((l) => l === null)) return setError("Ελέγξτε τις γραμμές με κόκκινο"), null;

    const movement = {
      movePurpose: delivery.movePurpose,
      otherMovePurposeTitle: delivery.otherMovePurposeTitle.trim() || undefined,
      dispatchDate: delivery.dispatchDate || undefined,
      dispatchTime: delivery.dispatchTime || undefined,
      vehicleNumber: delivery.vehicleNumber.trim() || undefined,
      loadingAddress: delivery.loadingAddress.trim() || undefined,
      deliveryAddress: delivery.deliveryAddress.trim() || undefined,
    };
    const body = isNote
      ? { seriesId, customerId, paymentMethodId: null, delivery: movement, lines: lineInputs }
      : {
          seriesId,
          customerId,
          paymentMethodId: paymentMethodId || null,
          actsAsDeliveryNote: acts,
          pricesIncludeVat: vatIncl,
          delivery: acts ? movement : undefined,
          lines: lineInputs,
        };
    const inv = savedId
      ? await api<Invoice>(`/invoices/${savedId}`, { method: "PUT", body })
      : await api<Invoice>("/invoices", { method: "POST", body });
    setSavedId(inv.id);
    return inv.id;
  }

  async function run(issue: boolean) {
    if (issue && !confirmCashLimit(cashLimit, totals.grossCents)) return;
    if (issue && !window.confirm("Μετά την έκδοση το παραστατικό παίρνει αριθμό και δεν μπορεί πλέον να αλλάξει. Συνέχεια;")) return;
    setBusy(true);
    try {
      const id = await save();
      if (!id) return;
      if (issue) await api(`/invoices/${id}/issue`, { method: "POST" });
      navigate(`/invoices/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createNoteSeries() {
    setError(null);
    try {
      const s = await api<Series>("/series", { method: "POST", body: { code: "ΔΑ", docType: "9.3" } });
      await series.reload();
      setSeriesId(s.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (series.loading || customers.loading || !loadedDraft) {
    return error ? <ErrorBox message={error} /> : <Loading />;
  }

  const title = invoiceId ? "Επεξεργασία πρόχειρου" : wantNote ? "Νέο δελτίο αποστολής" : "Νέο τιμολόγιο";

  if (!allowedSeries.length) {
    return (
      <>
        <PageHeader title={title} />
        <div className="card empty">
          {wantNote ? (
            <>
              <p>Χρειάζεται μια σειρά για δελτία αποστολής.</p>
              <button className="btn btn-primary" onClick={createNoteSeries}>
                Δημιουργία σειράς «ΔΑ»
              </button>
              <ErrorBox message={error} />
            </>
          ) : (
            <>
              Χρειάζεται πρώτα μια σειρά παραστατικών. <a href="#/settings/series">Δημιουργία στις Ρυθμίσεις</a>.
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={title} subtitle={selectedSeries ? `${DOC_TYPES[selectedSeries.docType]} · σειρά ${selectedSeries.code}` : undefined} />

      {draft?.correlatedInvoice && (
        <div className="alert alert-info">
          Δελτίο αποστολής για το τιμολόγιο{" "}
          <a href={`#/invoices/${draft.correlatedInvoice.id}`}>{docNumber(draft.correlatedInvoice.seriesCode, draft.correlatedInvoice.number)}</a>. Μειώστε τις
          ποσότητες αν η αποστολή γίνεται τμηματικά· τα υπόλοιπα στέλνονται με επόμενο δελτίο. Οι γραμμές δεν κινούν ξανά την αποθήκη.
        </div>
      )}

      {draft && draft.deliveryNotes.length > 0 && (
        <div className="alert alert-info">
          Τιμολόγηση δελτίων αποστολής:{" "}
          {draft.deliveryNotes.map((n, i) => (
            <span key={n.id}>
              {i > 0 && ", "}
              <a href={`#/invoices/${n.id}`}>{docNumber(n.seriesCode, n.number)}</a>
            </span>
          ))}
          . Οι γραμμές τους δεν θα κινήσουν ξανά την αποθήκη.
        </div>
      )}

      <div className="editor">
        <div className="editor-main">
          <section className="card">
            <div className="form-grid">
              <Field label="Σειρά & τύπος">
                <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                  {allowedSeries.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {DOC_TYPES[s.docType] ?? s.docType}
                    </option>
                  ))}
                </select>
              </Field>
              {!isNote && (
                <Field
                  label="Τρόπος πληρωμής"
                  hint={selectedMethod?.settlesOnIssue && !isCredit ? "Εξοφλείται με την έκδοση: καταχωρίζεται αυτόματα είσπραξη." : undefined}
                >
                  <div className="row">
                    <select value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
                      <option value="">— Επιλέξτε —</option>
                      {methods.data
                        ?.filter((m) => m.active || m.id === paymentMethodId)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                    <a className="btn" href="#/settings/payment-methods" title="Διαχείριση τρόπων πληρωμής">
                      ⚙
                    </a>
                  </div>
                </Field>
              )}
              <Field label="Πελάτης" wide>
                <div className="row">
                  <select
                    value={customerId}
                    onChange={(e) => {
                      setCustomerId(e.target.value);
                      setError(null);
                    }}
                    className={showErrors && !customerId ? "invalid" : ""}
                    disabled={!!draft?.deliveryNotes.length || !!draft?.correlatedInvoice}
                  >
                    <option value="">— Επιλέξτε πελάτη —</option>
                    {customers.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.vatNumber ? ` · ΑΦΜ ${c.vatNumber}` : ""}
                        {c.code ? ` · ${c.code}` : ""}
                      </option>
                    ))}
                  </select>
                  {!draft?.deliveryNotes.length && !draft?.correlatedInvoice && (
                    <button type="button" className="btn" onClick={() => setAddingCustomer(true)}>
                      + Νέος
                    </button>
                  )}
                </div>
              </Field>
              {customer && (
                <div className="customer-card wide">
                  <strong>{customer.name}</strong>
                  <span>{customer.vatNumber ? `ΑΦΜ ${customer.vatNumber}` : "Χωρίς ΑΦΜ"}</span>
                  <span className="muted">{[customer.address, customer.postalCode, customer.city, customer.country].filter(Boolean).join(", ")}</span>
                </div>
              )}
              {canActAsNote && (
                <label className="check wide">
                  <input
                    type="checkbox"
                    checked={actsAsNote}
                    onChange={(e) => {
                      setActsAsNote(e.target.checked);
                      // σε τιμολόγιο-δελτίο ο σκοπός είναι πώληση (ή πώληση για τρίτους / εφοδιασμός)
                      if (e.target.checked && !INVOICEABLE_PURPOSES.has(delivery.movePurpose)) setD({ movePurpose: 1 });
                    }}
                  />
                  <span>
                    <strong>Το τιμολόγιο είναι και δελτίο αποστολής</strong>
                    <span className="field-hint">Τα αγαθά διακινούνται με αυτό το τιμολόγιο· δεν χρειάζεται χωριστό δελτίο.</span>
                  </span>
                </label>
              )}
              {needsVat && (
                <div className="alert alert-warn wide">
                  Ο πελάτης δεν έχει ΑΦΜ. Για {DOC_TYPES[selectedSeries.docType]} το myDATA απαιτεί ΑΦΜ αντισυμβαλλόμενου.
                </div>
              )}
            </div>
          </section>

          {showMovement && (
            <section className="card">
              <div className="card-head">
                <h2>Στοιχεία διακίνησης</h2>
              </div>
              <div className="form-grid">
                <Field label="Σκοπός διακίνησης" wide={delivery.movePurpose !== OTHER_MOVE_PURPOSE}>
                  <select value={delivery.movePurpose} onChange={(e) => setD({ movePurpose: Number(e.target.value) })}>
                    {Object.entries(MOVE_PURPOSES)
                      .filter(([k]) => !acts || INVOICEABLE_PURPOSES.has(Number(k)))
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {k} · {v}
                        </option>
                      ))}
                  </select>
                </Field>
                {delivery.movePurpose === OTHER_MOVE_PURPOSE && (
                  <Field label="Περιγραφή σκοπού">
                    <input
                      value={delivery.otherMovePurposeTitle}
                      onChange={(e) => setD({ otherMovePurposeTitle: e.target.value })}
                      maxLength={100}
                      className={showErrors && !delivery.otherMovePurposeTitle.trim() ? "invalid" : ""}
                    />
                  </Field>
                )}
                <Field label="Ημερομηνία αποστολής">
                  <input type="date" value={delivery.dispatchDate} onChange={(e) => setD({ dispatchDate: e.target.value })} />
                </Field>
                <Field label="Ώρα αποστολής">
                  <input type="time" value={delivery.dispatchTime} onChange={(e) => setD({ dispatchTime: e.target.value })} />
                </Field>
                <Field label="Τόπος φόρτωσης" hint={org.data?.address ? undefined : "Η έδρα σας ορίζεται στις Ρυθμίσεις και προτείνεται εδώ"}>
                  <input
                    value={delivery.loadingAddress}
                    onChange={(e) => setD({ loadingAddress: e.target.value })}
                    maxLength={200}
                    className={showErrors && !delivery.loadingAddress.trim() ? "invalid" : ""}
                  />
                </Field>
                <Field label="Τόπος παράδοσης">
                  <input
                    value={delivery.deliveryAddress}
                    onChange={(e) => {
                      setDeliveryTouched(true);
                      setD({ deliveryAddress: e.target.value });
                    }}
                    maxLength={200}
                    className={showErrors && !delivery.deliveryAddress.trim() ? "invalid" : ""}
                  />
                </Field>
                <Field label="Αριθμός οχήματος (προαιρετικό)">
                  <input value={delivery.vehicleNumber} onChange={(e) => setD({ vehicleNumber: e.target.value.toUpperCase() })} maxLength={20} placeholder="π.χ. ΙΚΧ1234" />
                </Field>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>{isNote ? "Είδη που διακινούνται" : "Γραμμές"}</h2>
              {!isNote && (
                <div className="segmented" role="group" aria-label="Οι τιμές μονάδας είναι">
                  <button type="button" className={!includeVat ? "active" : ""} onClick={() => switchVatMode(false)} aria-pressed={!includeVat}>
                    Τιμές χωρίς ΦΠΑ
                  </button>
                  <button type="button" className={includeVat ? "active" : ""} onClick={() => switchVatMode(true)} aria-pressed={includeVat}>
                    Τιμές με ΦΠΑ
                  </button>
                </div>
              )}
              {isNote && (
                <span className="muted small">
                  {draft?.correlatedInvoice
                    ? "Οι αξίες είναι ήδη στο τιμολόγιο· εδώ αρκούν οι ποσότητες."
                    : "Η τιμή είναι προαιρετική· αν τη δώσετε, μεταφέρεται στο τιμολόγιο."}
                </span>
              )}
            </div>
            <datalist id="codes-list">
              {items.data?.filter((i) => i.code).map((i) => <option key={i.id} value={i.code!} label={i.name} />)}
            </datalist>
            <datalist id="items-list">
              {items.data?.map((i) => (
                <option key={i.id} value={i.name} label={[i.code, i.barcode].filter(Boolean).join(" · ") || undefined} />
              ))}
            </datalist>
            <div className="lines">
              <div className="line line-head" aria-hidden>
                <span>Κωδικός</span>
                <span>Περιγραφή</span>
                <span className="num">Ποσότητα</span>
                <span className="num">{vatIncl ? "Τιμή με ΦΠΑ" : "Τιμή μον."}</span>
                <span className="num">Έκπτ. %</span>
                <span>ΦΠΑ</span>
                <span className="num">Καθαρή αξία</span>
                <span />
              </div>
              {lines.map((l, idx) => {
                const input = inputs[idx];
                const computed = input ? computeTotals(withVatMode([input], vatIncl)).lines[0] : null;
                const touched = showErrors && (l.description.trim() || l.price.trim() || lines.length === 1);
                const bad = (cond: boolean) => (touched && cond ? "invalid" : "");
                const priceOk = (isNote && !l.price.trim()) || (parseMoneyToCents(l.price) ?? -1) >= 0;
                const linked = items.data?.find((i) => i.id === l.itemId);
                const codeValue = l.code ?? linked?.code ?? "";
                const codeUnknown = l.code !== undefined && l.code.trim() !== "" && l.code.trim() !== linked?.code;
                // F4 σε οποιοδήποτε πεδίο της γραμμής: άνοιγμα/κλείσιμο ιστορικού τιμών
                const historyKey = (e: React.KeyboardEvent) => {
                  if (e.key === "F4" && linked) {
                    e.preventDefault();
                    setHistoryFor(historyFor === l.key ? null : l.key);
                  }
                };
                const priceCents = parseMoneyToCents(l.price);
                return (
                  <div className="line" key={l.key}>
                    <div className="cell cell-code">
                      <span className="cell-label" aria-hidden>
                        Κωδικός
                      </span>
                      <input
                        aria-label="Κωδικός"
                        className={`line-code code ${codeUnknown ? "invalid" : ""}`}
                        placeholder="Κωδικός"
                        list="codes-list"
                        value={codeValue}
                        onChange={(e) => onCode(l.key, e.target.value)}
                        onBlur={() => !codeUnknown && updateLine(l.key, { code: undefined })}
                        onKeyDown={historyKey}
                        title={codeUnknown ? "Δεν βρέθηκε είδος με αυτόν τον κωδικό ή barcode" : "Κωδικός ή barcode είδους"}
                      />
                    </div>
                    <div className="cell cell-desc">
                      <span className="cell-label" aria-hidden>
                        Περιγραφή
                      </span>
                      <input
                        aria-label="Περιγραφή"
                        placeholder="Περιγραφή είδους ή υπηρεσίας"
                        list="items-list"
                        value={l.description}
                        onChange={(e) => onDescription(l.key, e.target.value)}
                        onKeyDown={historyKey}
                        className={`line-desc ${bad(!l.description.trim())}`}
                      />
                    </div>
                    <div className="cell cell-qty">
                      <span className="cell-label" aria-hidden>
                        Ποσότητα
                      </span>
                      <input
                        aria-label="Ποσότητα"
                        className={`num line-qty ${bad(!((parseDecimal(l.quantity) ?? 0) > 0))}`}
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="cell cell-price">
                      <span className="cell-label" aria-hidden>
                        {vatIncl ? "Τιμή με ΦΠΑ" : "Τιμή μονάδας"}
                      </span>
                      <div className="price-cell">
                        {linked && (
                          <button
                            type="button"
                            className="price-history-btn"
                            onClick={() => setHistoryFor(historyFor === l.key ? null : l.key)}
                            aria-label="Ιστορικό τιμών"
                            aria-expanded={historyFor === l.key}
                            title="Ιστορικό τιμών (F4)"
                          >
                            🕘
                          </button>
                        )}
                        <input
                          aria-label="Τιμή μονάδας"
                          className={`num ${linked ? "with-btn" : ""} ${bad(!priceOk)}`}
                          inputMode="decimal"
                          placeholder={isNote ? "—" : "0,00"}
                          value={l.price}
                          onChange={(e) => updateLine(l.key, { price: e.target.value })}
                          onKeyDown={historyKey}
                        />
                      </div>
                    </div>
                    <div className="cell cell-disc">
                      <span className="cell-label" aria-hidden>
                        Έκπτωση %
                      </span>
                      <input
                        aria-label="Έκπτωση %"
                        className={`num line-disc ${bad(parseDiscount(l.discount) === null)}`}
                        inputMode="decimal"
                        placeholder="%"
                        value={l.discount}
                        onChange={(e) => updateLine(l.key, { discount: e.target.value })}
                        title="Έκπτωση γραμμής σε %"
                      />
                    </div>
                    <div className="cell cell-vat">
                      <span className="cell-label" aria-hidden>
                        ΦΠΑ
                      </span>
                      <VatSelect value={l.vatCategory} onChange={(v) => updateLine(l.key, { vatCategory: v })} />
                    </div>
                    <div className="cell cell-net">
                      <span className="cell-label" aria-hidden>
                        Καθαρή αξία
                      </span>
                      <span className="num line-net">{computed ? formatCents(computed.netCents) : "—"}</span>
                    </div>
                    <button type="button" className="btn-icon" onClick={() => removeLine(l.key)} aria-label="Διαγραφή γραμμής">
                      ×
                    </button>
                    {l.sourceLineId && isNote ? (
                      <OriginHint origin={origin} sourceLineId={l.sourceLineId} quantity={parseDecimal(l.quantity)} />
                    ) : l.sourceLineId ? (
                      <div className="line-hint">Από δελτίο αποστολής · η αποθήκη κινήθηκε ήδη με το δελτίο</div>
                    ) : (
                      <LineItemHint
                        item={items.data?.find((i) => i.id === l.itemId)}
                        stock={stock.data?.find((s) => s.itemId === l.itemId)}
                        quantity={parseDecimal(l.quantity)}
                        onUnlink={() => updateLine(l.key, { itemId: undefined })}
                      />
                    )}
                    {!isNote && linked && !l.sourceLineId && (
                      <PriceHint
                        item={linked}
                        priceCents={priceCents}
                        netPriceCents={
                          priceCents === null
                            ? null
                            : Math.round((vatIncl ? grossToNet(priceCents, l.vatCategory) : priceCents) * (1 - (parseDiscount(l.discount) ?? 0) / 100))
                        }
                        fromCustomerCents={l.priceFrom ? lastInMode(l.priceFrom) : null}
                        list={listPrice(linked, l.vatCategory)}
                        priceFrom={l.priceFrom}
                        onListPrice={() => updateLine(l.key, { price: centsToInput(listPrice(linked, l.vatCategory).cents), priceFrom: undefined })}
                      />
                    )}
                    {historyFor === l.key && linked && (
                      <PriceHistoryPanel
                        itemId={linked.id}
                        customerId={customerId}
                        customerName={customer?.name}
                        priceCents={priceCents}
                        includeVat={vatIncl}
                        vatCategory={l.vatCategory}
                        retailFirst={!!customer && !customer.vatNumber}
                        stockQty={linked.trackStock ? stock.data?.find((x) => x.itemId === linked.id)?.quantity : undefined}
                        onUse={(cents) => updateLine(l.key, { price: centsToInput(cents) })}
                        onClose={() => setHistoryFor(null)}
                      />
                    )}
                    {!isNote && selectedSeries && (
                      <ClassificationHint
                        docType={selectedSeries.docType}
                        customer={customer}
                        itemCategory={items.data?.find((i) => i.id === l.itemId)?.incomeClassCategory ?? null}
                        line={l}
                        onChange={(patch) => updateLine(l.key, patch)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              + Προσθήκη γραμμής
            </button>
          </section>
        </div>

        <aside className="editor-side">
          <section className="card totals">
            <h2>Σύνολα</h2>
            <dl>
              {totals.discountCents > 0 && (
                <>
                  <dt>Αξία προ έκπτωσης</dt>
                  <dd>{formatCents(totals.netCents + totals.discountCents)}</dd>
                  <dt>Έκπτωση</dt>
                  <dd className="negative">−{formatCents(totals.discountCents)}</dd>
                </>
              )}
              <dt>Καθαρή αξία</dt>
              <dd>{formatCents(totals.netCents)}</dd>
              {vatBreakdown.map(([cat, v]) => (
                <div className="totals-sub" key={cat}>
                  <dt>
                    ΦΠΑ {vatLabel(cat)} <span className="muted">επί {formatCents(v.net)}</span>
                  </dt>
                  <dd>{formatCents(v.vat)}</dd>
                </div>
              ))}
              <dt>Σύνολο ΦΠΑ</dt>
              <dd>{formatCents(totals.vatCents)}</dd>
              <dt className="grand">{isNote ? "Αξία" : "Πληρωτέο"}</dt>
              <dd className="grand">{formatCents(totals.grossCents)}</dd>
            </dl>
            <CashLimitAlert state={cashLimit} />
            <ErrorBox message={error} />
            <div className="stack">
              <button className="btn btn-primary" disabled={busy || cashLimit === "block"} onClick={() => run(true)}>
                Έκδοση
              </button>
              <button className="btn" disabled={busy} onClick={() => run(false)}>
                Αποθήκευση πρόχειρου
              </button>
              <a className="btn btn-ghost" href={invoiceId ? `#/invoices/${invoiceId}` : "#/documents"}>
                Άκυρο
              </a>
            </div>
            <p className="muted small">
              {isNote ? "Το δελτίο δεν είναι πώληση: δεν μετράει στις αναφορές πωλήσεων." : "Ο ΦΠΑ υπολογίζεται ανά γραμμή, όπως θα διαβιβαστεί στο myDATA."}
            </p>
          </section>
        </aside>
      </div>

      {addingCustomer && (
        <Modal title="Νέος πελάτης" onClose={() => setAddingCustomer(false)}>
          <CustomerForm
            onCancel={() => setAddingCustomer(false)}
            onSaved={(c) => {
              setAddingCustomer(false);
              customers.setData([...(customers.data ?? []), c].sort((a, b) => a.name.localeCompare(b.name, "el")));
              setCustomerId(c.id);
              setError(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}

// Κάτω από τη γραμμή: με ποιο είδος συνδέεται και πόσο απόθεμα έχει
function LineItemHint({
  item,
  stock,
  quantity,
  onUnlink,
}: {
  item?: Item;
  stock?: StockRow;
  quantity: number | null;
  onUnlink: () => void;
}) {
  // Οι υπηρεσίες χωρίς απόθεμα συνδέονται σιωπηλά: δεν υπάρχει κάτι χρήσιμο να δείξουμε
  if (!item?.trackStock) return null;
  const short = stock && quantity !== null && quantity > stock.quantity;
  return (
    <div className={short ? "line-hint warn" : "line-hint"}>
      <span>Είδος: {item.name}</span>
      {stock && (
        <span>
          · Απόθεμα {formatQty(stock.quantity)} {item.unit}
          {short && " · δεν επαρκεί"}
        </span>
      )}
      <button type="button" className="btn-link" onClick={onUnlink} title="Η γραμμή δεν θα κινήσει αποθήκη">
        αποσύνδεση
      </button>
    </div>
  );
}

// Από πού ήρθε η τιμή της γραμμής, και προειδοποίηση αν είναι κάτω από την τελευταία τιμή αγοράς
function PriceHint({
  item,
  priceCents,
  netPriceCents,
  fromCustomerCents,
  list,
  priceFrom,
  onListPrice,
}: {
  item: Item;
  priceCents: number | null; // όπως γράφεται (με ή χωρίς ΦΠΑ)
  netPriceCents: number | null; // χωρίς ΦΠΑ, για σύγκριση με το κόστος
  fromCustomerCents: number | null;
  list: { cents: number; label: string };
  priceFrom?: LastPrices[string];
  onListPrice: () => void;
}) {
  const fromCustomer = priceFrom && priceCents === fromCustomerCents && priceCents !== list.cents;
  const belowCost = netPriceCents !== null && item.lastCostCents != null && netPriceCents < item.lastCostCents;
  if (!fromCustomer && !belowCost) return null;
  return (
    <div className={belowCost ? "line-hint warn" : "line-hint"}>
      {fromCustomer && (
        <>
          <span>
            Τελευταία τιμή σε αυτόν τον πελάτη ({formatDate(priceFrom.date)} · {docNumber(priceFrom.seriesCode, priceFrom.number)}) · {list.label}{" "}
            {formatCents(list.cents)}
          </span>
          <button type="button" className="btn-link" onClick={onListPrice}>
            τιμή τιμοκαταλόγου
          </button>
        </>
      )}
      {belowCost && <span>{fromCustomer ? " · " : ""}Κάτω από την τελευταία τιμή αγοράς ({formatCents(item.lastCostCents!)} χωρίς ΦΠΑ)</span>}
    </div>
  );
}

// Γραμμή δελτίου από τιμολόγιο: πόσα τιμολογήθηκαν και πόσα απομένουν για αποστολή
function OriginHint({ origin, sourceLineId, quantity }: { origin: Invoice | null; sourceLineId: string; quantity: number | null }) {
  const line = origin?.lines.find((l) => l.id === sourceLineId);
  if (!origin || !line) return <div className="line-hint">Από τιμολόγιο · η αποθήκη κινήθηκε ήδη με το τιμολόγιο</div>;
  const left = roundQty(line.quantity - (line.shippedQuantity ?? 0));
  const over = quantity !== null && quantity > left;
  return (
    <div className={over ? "line-hint warn" : "line-hint"}>
      Από {docNumber(origin.seriesCode, origin.number)} · τιμολογήθηκαν {formatQty(line.quantity)}
      {line.shippedQuantity ? ` · στάλθηκαν ήδη ${formatQty(line.shippedQuantity)}` : ""} · απομένουν {formatQty(left)}
      {over && " · η ποσότητα ξεπερνά το υπόλοιπο"}
    </div>
  );
}

// Χαρακτηρισμός εσόδου της γραμμής: τι θα σταλεί στο myDATA, με δυνατότητα αλλαγής
function ClassificationHint({
  docType,
  customer,
  itemCategory,
  line,
  onChange,
}: {
  docType: string;
  customer?: Customer;
  itemCategory: string | null;
  line: DraftLine;
  onChange: (patch: Partial<DraftLine>) => void;
}) {
  const [open, setOpen] = useState(false);
  const auto = resolveClassification(docType, customer ?? { vatNumber: null, country: "GR" }, {}, itemCategory);
  const cls = resolveClassification(docType, customer ?? { vatNumber: null, country: "GR" }, line, itemCategory);
  const manual = !!(line.incomeClassCategory || line.incomeClassType);
  return (
    <div className="line-class">
      <span>
        Χαρακτηρισμός: {INCOME_CATEGORIES[cls.incomeClassCategory]} · {customer || line.incomeClassType ? `${INCOME_TYPES[cls.incomeClassType]} (${cls.incomeClassType})` : "ανάλογα με τον πελάτη"}
        {manual ? " · επιλογή σας" : " · αυτόματα"}
      </span>
      <button type="button" className="btn-link" onClick={() => setOpen((o) => !o)}>
        {open ? "κλείσιμο" : "αλλαγή"}
      </button>
      {open && (
        <div className="line-class-edit">
          <select aria-label="Κατηγορία εσόδου" value={line.incomeClassCategory ?? ""} onChange={(e) => onChange({ incomeClassCategory: e.target.value || undefined })}>
            <option value="">Αυτόματα: {INCOME_CATEGORIES[auto.incomeClassCategory]}</option>
            {Object.entries(INCOME_CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select aria-label="Τύπος Ε3" value={line.incomeClassType ?? ""} onChange={(e) => onChange({ incomeClassType: e.target.value || undefined })}>
            <option value="">Αυτόματα από τον πελάτη{customer ? `: ${auto.incomeClassType}` : ""}</option>
            {Object.entries(INCOME_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {k} · {v}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
