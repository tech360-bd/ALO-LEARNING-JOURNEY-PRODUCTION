import type { Metadata } from "next";
import { marketingOsMetadata } from "@/lib/marketingos-metadata";

// The Super Admin command center is an authenticated app shell — never indexed.
export const metadata: Metadata = {
  ...marketingOsMetadata,
  title: "Super Admin",
  robots: { index: false, follow: false },
};

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
