/** Minimal hash router: works on any static host, no server rewrites. */

import { useEffect, useState } from "react";

export type Route =
  | { page: "home"; section?: "how" | "security" }
  | { page: "trade" };

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (raw === "trade") return { page: "trade" };
  if (raw === "how" || raw === "security") return { page: "home", section: raw };
  return { page: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (route.page === "home" && route.section) {
      document.getElementById(route.section)?.scrollIntoView({ behavior: "smooth" });
    } else {
      window.scrollTo(0, 0);
    }
  }, [route]);
  return route;
}
