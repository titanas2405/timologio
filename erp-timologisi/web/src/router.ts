import { useEffect, useState } from "react";

// Hash routing (#/invoices/123): δεν χρειάζεται ρύθμιση στον server για βαθιά links.
const current = () => window.location.hash.replace(/^#/, "") || "/";

export function useRoute(): string {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const onChange = () => {
      setRoute(current());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path;
}
