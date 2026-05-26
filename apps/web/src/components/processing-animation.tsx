"use client";

import React, { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

type ProcessingAnimationProps = {
  status: string;
};

export function ProcessingAnimation({ status }: ProcessingAnimationProps) {
  const [loadingText, setLoadingText] = useState("Initializing connection...");

  useEffect(() => {
    let timer: number;
    if (status === "QUEUED") {
      setLoadingText("Allocating resources...");
      timer = window.setTimeout(() => setLoadingText("Awaiting automation queue..."), 2500);
    } else if (status === "IN_PROGRESS" || status === "PROCESSING") {
      setLoadingText("Executing protocol...");
      timer = window.setTimeout(() => setLoadingText("Processing payload..."), 3500);
    } else {
      setLoadingText("Establishing handshake...");
    }
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6 py-12">
      <Spinner className="size-12" />
      <div className="flex flex-col items-center gap-2 text-center">
        <Badge variant="secondary">Status: {status}</Badge>
        <div className="text-base font-medium">{loadingText}</div>
        <div className="font-mono text-sm text-muted-foreground">
          &gt; Please sit tight and do not close this window
        </div>
      </div>
    </div>
  );
}
