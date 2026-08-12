"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export function StudyAutoRefresh({ publicId }: { publicId: string }) {
  const router = useRouter();
  const refreshing = useRef(false);

  useEffect(() => {
    let timer = 0;
    let cancelled = false;

    function schedule() {
      if (cancelled) return;
      const delay = document.visibilityState === "visible" ? 2000 : 8000;
      timer = window.setTimeout(() => {
        if (!refreshing.current) {
          refreshing.current = true;
          router.refresh();
          window.setTimeout(() => { refreshing.current = false; }, 400);
        }
        schedule();
      }, delay);
    }

    function refreshOnFocus() {
      if (document.visibilityState === "visible") router.refresh();
    }

    schedule();
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [publicId, router]);

  return null;
}
