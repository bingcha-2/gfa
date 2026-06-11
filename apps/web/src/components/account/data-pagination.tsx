"use client";

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { fmt } from "@/lib/i18n";

export type DataPaginationLabels = {
  prevPage: string;
  nextPage: string;
  /** Template with {page} and {pages} placeholders. */
  pageInfo: string;
};

/**
 * Shared previous/next pager for portal tables. Renders nothing when there is
 * a single page. Labels are passed in so the component stays namespace-agnostic
 * (usage / notifications / billing all reuse it).
 */
export function DataPagination({
  page,
  totalPages,
  onPage,
  labels,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  labels: DataPaginationLabels;
}) {
  if (totalPages <= 1) return null;

  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground tabular-nums">
        {fmt(labels.pageInfo, { page, pages: totalPages })}
      </span>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              text={labels.prevPage}
              aria-disabled={atStart}
              className={atStart ? "pointer-events-none opacity-50" : ""}
              onClick={(e) => {
                e.preventDefault();
                if (!atStart) onPage(page - 1);
              }}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              href="#"
              text={labels.nextPage}
              aria-disabled={atEnd}
              className={atEnd ? "pointer-events-none opacity-50" : ""}
              onClick={(e) => {
                e.preventDefault();
                if (!atEnd) onPage(page + 1);
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
