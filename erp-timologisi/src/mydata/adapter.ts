// Το σημείο σύνδεσης με το myDATA. Το υπόλοιπο σύστημα δεν ξέρει τίποτα για το πρωτόκολλο της ΑΑΔΕ:
// μιλάει μόνο με αυτή τη διεπαφή. Όταν έρθει η ώρα, γράφεται μία υλοποίηση (MydataRestAdapter)
// που μετατρέπει το InvoiceForSubmission σε XML και καλεί το SendInvoices.

export interface SubmissionLine {
  lineNo: number;
  description: string;
  quantity: number;
  netCents: number;
  vatCents: number;
  vatCategory: number;
  incomeClassCategory: string | null;
  incomeClassType: string | null;
}

export interface InvoiceForSubmission {
  issuerVatNumber: string;
  counterpartVatNumber: string | null;
  counterpartCountry: string;
  docType: string; // τύπος παραστατικού myDATA
  series: string;
  number: number;
  issueDate: string; // YYYY-MM-DD
  currency: string;
  netCents: number;
  vatCents: number;
  grossCents: number;
  paymentMethodType: string | null; // κωδικός τρόπου πληρωμής myDATA
  isDeliveryNote: boolean; // τιμολόγιο που είναι και δελτίο αποστολής
  // Δελτίο αποστολής (9.3) ή τιμολόγιο-δελτίο: στοιχεία διακίνησης
  delivery: {
    movePurpose: number;
    otherMovePurposeTitle: string | null;
    dispatchDate: string | null;
    dispatchTime: string | null;
    vehicleNumber: string | null;
    loadingAddress: string;
    deliveryAddress: string;
  } | null;
  // ΜΑΡΚ των δελτίων αποστολής που τιμολογεί αυτό το παραστατικό (συσχέτιση)
  connectedMarks: string[];
  // Δελτίο για ήδη εκδομένο τιμολόγιο: ΜΑΡΚ του αρχικού τιμολογίου (correlatedInvoices)
  correlatedInvoices: string[];
  lines: SubmissionLine[];
}

export interface SubmissionResult {
  mark: string; // ΜΑΡΚ
  uid: string;
}

export interface MydataAdapter {
  submit(invoice: InvoiceForSubmission): Promise<SubmissionResult>;
}

export class NotConfiguredAdapter implements MydataAdapter {
  async submit(): Promise<SubmissionResult> {
    throw new Error("Η σύνδεση με το myDATA δεν έχει ρυθμιστεί ακόμα");
  }
}
