"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function StudyAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
