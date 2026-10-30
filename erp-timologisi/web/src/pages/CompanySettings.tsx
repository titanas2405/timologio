import { useRef, useState, type FormEvent } from "react";
import { api, setOrgId, type Organization } from "../api";
import { ErrorBox, Field, Loading } from "../ui";

const MAX_W = 600;
const MAX_H = 240;
const MAX_BYTES = 300 * 1024;

// Σμίκρυνση στον browser, ώστε να χωράει στο όριο του server και να τυπώνεται καθαρά.
// Διαφανή PNG μένουν PNG· αν βγει μεγάλο, δοκιμάζεται WebP και μετά JPEG.
async function prepareLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") throw new Error("Επιλέξτε εικόνα PNG, JPEG ή WebP");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Η εικόνα δεν διαβάζεται"));
      i.src = url;
    });
    const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const bytes = (d: string) => Math.ceil(((d.length - d.indexOf(",") - 1) * 3) / 4);
    for (const [type, q] of [["image/png", undefined], ["image/webp", 0.9], ["image/jpeg", 0.85]] as const) {
      const data = canvas.toDataURL(type, q);
      // ο browser μπορεί να μην υποστηρίζει webp και να επιστρέψει png
      if (data.startsWith(`data:${type};`) && bytes(data) <= MAX_BYTES) return data;
    }
    throw new Error("Η εικόνα παραμένει μεγάλη μετά τη σμίκρυνση");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CompanySettings({ org, onUpdated }: { org: Organization | null; onUpdated: (o: Organization) => void }) {
  const [name, setName] = useState(org?.name ?? "");
  const [address, setAddress] = useState(org?.address ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!org) return <Loading />;

  async function run(fn: () => Promise<Organization>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onUpdated(await fn());
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    run(() => api<Organization>("/organizations/current", { method: "PUT", body: { name, address: address.trim() || undefined } }));
  }

  function upload(file: File | undefined) {
    if (!file) return;
    run(async () => api<Organization>("/organizations/current/logo", { method: "PUT", body: { dataUrl: await prepareLogo(file) } }));
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Εταιρεία</h2>
      </div>
      <div className="company">
        <div className="logo-box">
          {org.logo ? <img src={org.logo} alt="Λογότυπο" /> : <span className="muted small">Χωρίς λογότυπο</span>}
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
              {org.logo ? "Αλλαγή λογοτύπου" : "Ανέβασμα λογοτύπου"}
            </button>
            {org.logo && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => run(() => api<Organization>("/organizations/current/logo", { method: "PUT", body: { dataUrl: null } }))}
              >
                Αφαίρεση
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <span className="field-hint">Εμφανίζεται στα παραστατικά. PNG, JPEG ή WebP· μεγάλες εικόνες σμικραίνονται αυτόματα.</span>
        </div>
        <form onSubmit={save} className="form-grid">
          <Field label="Επωνυμία" wide>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="ΑΦΜ">
            <input value={org.vatNumber} disabled />
          </Field>
          <Field label="Κωδικός εταιρείας" hint="Με αυτόν συνδέεστε από άλλον browser, μέχρι να υπάρξει σύνδεση χρηστών.">
            <input value={org.id} readOnly onFocus={(e) => e.target.select()} />
          </Field>
          <Field label="Διεύθυνση έδρας" hint="Τυπώνεται στα παραστατικά και προτείνεται ως τόπος φόρτωσης στα δελτία αποστολής." wide>
            <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} placeholder="π.χ. Ερμού 10, 10563 Αθήνα" />
          </Field>
          <div className="wide">
            <ErrorBox message={error} />
            {saved && !error && <div className="alert alert-info">Αποθηκεύτηκε.</div>}
          </div>
          <div className="form-actions wide">
            <button type="button" className="btn btn-danger" onClick={() => setOrgId(null)}>
              Αλλαγή εταιρείας
            </button>
            <button className="btn btn-primary" disabled={busy}>
              Αποθήκευση
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
