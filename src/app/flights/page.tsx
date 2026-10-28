import type { Metadata } from "next";
import FlightHistory from "@/components/flight-history";

export const metadata: Metadata = { title: "Flight history | AeroTrace" };

export default function FlightHistoryPage() {
  return <FlightHistory />;
}
