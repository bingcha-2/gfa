"use client";

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
    <div className="account-pagination">
      <span>
        {fmt(labels.pageInfo, { page, pages: totalPages })}
      </span>
      <div className="account-pagination__actions">
        <button
          type="button"
          className="account-btn account-btn--secondary"
          disabled={atStart}
          onClick={() => onPage(page - 1)}
        >
          {labels.prevPage}
        </button>
        <button
          type="button"
          className="account-btn account-btn--secondary"
          disabled={atEnd}
          onClick={() => onPage(page + 1)}
        >
          {labels.nextPage}
        </button>
      </div>
    </div>
  );
}
