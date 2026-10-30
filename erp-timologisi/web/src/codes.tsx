import { useEffect, useState } from "react";
import { api, type CodeSettings } from "./api";
import type { CodeEntity } from "../../src/domain/codes";
import { useLoad } from "./hooks";
import { Field } from "./ui";

// Πεδίο «Κωδικός» στις φόρμες πελάτη / προμηθευτή / είδους.
// Αυτόματη κωδικοποίηση: προσυμπληρώνεται ο επόμενος κωδικός (αλλάζει ελεύθερα). Χειροκίνητη: υποχρεωτικό.
export function useCode(entity: CodeEntity, initialCode: string | null | undefined) {
  const settings = useLoad(() => api<CodeSettings>(`/codes/${entity}`), [entity]);
  const [code, setCode] = useState(initialCode ?? "");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const s = settings.data;
    if (s?.mode === "AUTO" && !initialCode && !touched) setCode(s.nextCode);
  }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const field = (
    <Field
      label="Κωδικός"
      hint={
        settings.data?.mode === "MANUAL"
          ? "Υποχρεωτικός· χειροκίνητη κωδικοποίηση"
          : initialCode
            ? "Μπορείτε να τον αλλάξετε. Τα εκδομένα παραστατικά κρατούν τον παλιό."
            : "Προτείνεται αυτόματα· μπορείτε να τον αλλάξετε"
      }
    >
      <input
        value={code}
        onChange={(e) => {
          setTouched(true);
          setCode(e.target.value);
        }}
        maxLength={30}
        required={settings.data?.mode === "MANUAL"}
        placeholder={settings.data?.mode === "MANUAL" ? "π.χ. ΓΡ-100" : undefined}
      />
    </Field>
  );
  return { code: code.trim(), field };
}

// Αναζήτηση σε λίστες: κάθε πεδίο που περιέχει το κείμενο (χωρίς διάκριση πεζών/κεφαλαίων)
export function matches(query: string, ...fields: (string | null | undefined)[]) {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f?.toLowerCase().includes(q));
}
