"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Przegląd" },
  { href: "/agents", label: "Agenci" },
  { href: "/strategies", label: "Strategie" },
  { href: "/decisions", label: "Decyzje" },
  { href: "/trades", label: "Transakcje" },
  { href: "/market", label: "Rynek" },
  { href: "/review", label: "Przegląd i wnioski" },
  { href: "/journal", label: "Dziennik" },
  { href: "/models", label: "Modele AI" },
  { href: "/accounts", label: "Konta MT" },
  { href: "/settings", label: "Ustawienia" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="px-2 space-y-0.5">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href}
            className={`block rounded-lg px-3 py-2 text-sm ${active ? "bg-panel-2 text-ink" : "text-muted hover:text-ink hover:bg-panel-2/60"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
