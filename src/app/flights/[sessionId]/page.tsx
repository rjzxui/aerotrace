import type { Metadata } from "next";
import PostFlightReport from "@/components/post-flight-report";

export const metadata: Metadata = { title: "Flight debrief | AeroTrace" };

export default async function FlightReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <PostFlightReport sessionId={sessionId} />;
}
