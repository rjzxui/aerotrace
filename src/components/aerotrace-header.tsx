"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Plane } from "lucide-react";
import { IS_PUBLIC_DEMO_MODE } from "@/lib/flight-api";

export default function AeroTraceHeader({
  children,
}: {
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const onRecorder = pathname === "/";
  const onHistory = pathname.startsWith("/flights");

  return (
    <>
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
          <Link
            href="/"
            className={onRecorder ? "is-current" : undefined}
            aria-current={onRecorder ? "page" : undefined}
          >
            RECORDER
          </Link>
          <Link
            href="/flights"
            className={onHistory ? "is-current" : undefined}
            aria-current={onHistory ? "page" : undefined}
          >
            FLIGHT HISTORY
          </Link>
        </nav>
        {children}
      </header>
      {IS_PUBLIC_DEMO_MODE && (
        <div className="public-demo-banner" role="status">
          <strong>DEMO DATA — NOT LIVE MSFS TELEMETRY</strong>
          <span>Sample flights only · the local connector is not used.</span>
        </div>
      )}
    </>
  );
}
