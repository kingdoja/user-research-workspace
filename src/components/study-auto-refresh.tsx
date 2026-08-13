"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";

export function StudyAutoRefresh({ publicId, after }: { publicId: string; after: string }) {
  const router = useRouter();
  const cursor = useRef(after);

  useEffect(() => {
    cursor.current = after;
    const stream = new EventSource(`/api/studies/${publicId}/events?after=${encodeURIComponent(cursor.current)}`);
    const refresh = (event: MessageEvent<string>) => {
      if (event.lastEventId) cursor.current = event.lastEventId;
      startTransition(() => router.refresh());
    };
    stream.addEventListener("study-event", refresh as EventListener);
    return () => {
      stream.removeEventListener("study-event", refresh as EventListener);
      stream.close();
    };
  }, [after, publicId, router]);

  return null;
}
