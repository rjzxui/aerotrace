import Link from "next/link";
import type { ReactNode } from "react";
import { Plane } from "lucide-react";

export default function AeroTraceHeader({
  children,
}: {
  children?: ReactNode;
}) {
  return (
    <header className="app-header">
      <Link className="brand-lockup" href="/" aria-label="AeroTrace recorder">
        <div className="brand-mark" aria-hidden="true">
          <Plane size={17} />
        </div>
        <div>
          <div className="brand-name">AEROTRACE</div>
          <div className="brand-caption">FLIGHT DATA SYSTEM</div>
        </div>
      </Link>
      <nav className="app-nav" aria-label="Main navigation">
        <Link href="/">RECORDER</Link>
        <Link href="/flights">FLIGHT HISTORY</Link>
      </nav>
      {children}
    </header>
  );
}
