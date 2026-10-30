import { useEffect, useState } from "react";
import { api, getOrgId, setOrgId, type Organization } from "./api";
import { navigate, useRoute } from "./router";
import { Onboarding } from "./pages/Onboarding";
import { Home } from "./pages/Home";
import { Documents } from "./pages/Documents";
import { InvoiceEditor } from "./pages/InvoiceEditor";
import { InvoiceView } from "./pages/InvoiceView";
import { Customers } from "./pages/Customers";
import { Items } from "./pages/Items";
import { Settings } from "./pages/Settings";
import { Reports } from "./pages/Reports";
import { Warehouse } from "./pages/Warehouse";
import { Suppliers } from "./pages/Suppliers";
import { Payments } from "./pages/Payments";
import { CustomerStatement } from "./pages/CustomerStatement";
import { ComingSoon } from "./pages/ComingSoon";

interface MenuItem {
  path: string;
  label: string;
  icon: string;
  soon?: boolean;
  children?: MenuItem[];
}

const MENU: MenuItem[] = [
  { path: "/", label: "Αρχική", icon: "⌂" },
  {
    path: "/documents",
    label: "Παραστατικά",
    icon: "▤",
    children: [
      { path: "/invoices/new", label: "Νέο τιμολόγιο", icon: "+" },
      { path: "/delivery-notes/new", label: "Νέο δελτίο αποστολής", icon: "⇢" },
      { path: "/credit-notes", label: "Πιστωτικά", icon: "−", soon: true },
      { path: "/quotes", label: "Προσφορές", icon: "≈", soon: true },
    ],
  },
  { path: "/customers", label: "Πελάτες", icon: "☺" },
  { path: "/suppliers", label: "Προμηθευτές", icon: "⇄" },
  { path: "/items", label: "Είδη & Υπηρεσίες", icon: "▦" },
  { path: "/warehouse", label: "Αποθήκη", icon: "▣" },
  { path: "/payments", label: "Εισπράξεις & Πληρωμές", icon: "€" },
  { path: "/reports", label: "Αναφορές", icon: "▥" },
  { path: "/mydata", label: "myDATA", icon: "◎", soon: true },
  { path: "/settings", label: "Ρυθμίσεις", icon: "⚙" },
];

const SOON: Record<string, string> = {
  "/credit-notes": "Πιστωτικά τιμολόγια (τύπος 5.1) με συσχέτιση στο αρχικό παραστατικό.",
  "/quotes": "Προσφορές που μετατρέπονται σε τιμολόγιο με ένα κλικ.",
  "/mydata": "Αυτόματη διαβίβαση στο myDATA της ΑΑΔΕ και λήψη ΜΑΡΚ.",
};

function isActive(route: string, path: string) {
  if (path === "/") return route === "/";
  return route === path || route.startsWith(path + "/");
}

function Page({ route, org, setOrg }: { route: string; org: Organization | null; setOrg: (o: Organization) => void }) {
  let m: RegExpMatchArray | null;
  if (route === "/") return <Home org={org} />;
  if (route === "/documents") return <Documents />;
  if (route === "/invoices/new") return <InvoiceEditor key="new-invoice" />;
  if (route === "/delivery-notes/new") return <InvoiceEditor key="new-note" kind="delivery" />;
  if ((m = route.match(/^\/invoices\/([^/]+)\/edit$/))) return <InvoiceEditor invoiceId={m[1]} key={m[1]} />;
  if ((m = route.match(/^\/invoices\/([^/]+)$/))) return <InvoiceView invoiceId={m[1]} key={m[1]} />;
  if (route === "/customers") return <Customers />;
  if (route === "/items") return <Items />;
  if ((m = route.match(/^\/reports(?:\/(journal|items|aging))?$/))) return <Reports tab={(m[1] as "journal" | "items" | "aging" | undefined) ?? "summary"} key={m[1] ?? "summary"} />;
  if (route === "/warehouse") return <Warehouse />;
  if ((m = route.match(/^\/settings(?:\/([^/]+))?$/))) return <Settings section={m[1]} org={org} onOrgUpdated={setOrg} key={m[1] ?? "home"} />;
  if (route === "/suppliers") return <Suppliers />;
  if (route === "/payments") return <Payments />;
  if ((m = route.match(/^\/payments\/customers\/([^/]+)$/))) return <CustomerStatement customerId={m[1]} key={m[1]} />;
  const soon = MENU.flatMap((i) => [i, ...(i.children ?? [])]).find((i) => i.path === route && i.soon);
  if (soon) return <ComingSoon title={soon.label} description={SOON[route]} />;
  return <ComingSoon title="Η σελίδα δεν βρέθηκε" description="Ο σύνδεσμος δεν αντιστοιχεί σε κάποια σελίδα." />;
}

export function App() {
  const route = useRoute();
  const [orgId, setOrgIdState] = useState(getOrgId);
  const [org, setOrg] = useState<Organization | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onChange = () => setOrgIdState(getOrgId());
    window.addEventListener("org-changed", onChange);
    return () => window.removeEventListener("org-changed", onChange);
  }, []);

  useEffect(() => {
    setOrg(null);
    if (orgId) api<Organization>("/organizations/current").then(setOrg).catch(() => {});
  }, [orgId]);

  useEffect(() => setMenuOpen(false), [route]);

  if (!orgId) {
    return (
      <Onboarding
        onDone={(id) => {
          setOrgId(id);
          navigate("/");
        }}
      />
    );
  }

  const link = (item: MenuItem, child = false) => (
    <a
      key={item.path}
      href={`#${item.path}`}
      className={`nav-link${child ? " nav-child" : ""}${isActive(route, item.path) ? " active" : ""}`}
    >
      <span className="nav-icon" aria-hidden>
        {item.icon}
      </span>
      <span className="nav-label">{item.label}</span>
      {item.soon && <span className="soon">Σύντομα</span>}
    </a>
  );

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">Τ</span>
          <div>
            <div className="brand-name">Τιμολόγηση</div>
            <div className="brand-org" title={org?.name}>
              {org ? org.name : "…"}
            </div>
          </div>
        </div>
        <nav>
          {MENU.map((item) => (
            <div key={item.path}>
              {link(item)}
              {item.children?.map((c) => link(c, true))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="topbar">
        <button className="btn-icon" onClick={() => setMenuOpen((o) => !o)} aria-label="Μενού">
          ☰
        </button>
        <span className="brand-name">Τιμολόγηση</span>
      </div>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <main className="main">
        <Page route={route} org={org} setOrg={setOrg} />
      </main>
    </div>
  );
}
