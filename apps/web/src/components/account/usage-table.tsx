"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DataPagination } from "@/components/account/data-pagination";
import { getUsage } from "@/lib/account/user-api";
import type { UsageDays, UsagePage } from "@/lib/account/user-types";
import { formatDateTime, formatTokens } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

const PAGE_SIZE = 20;

function isSuccessStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "success" || s === "ok" || s === "200";
}

export function UsageTable() {
  const dict = useDict();
  const u = dict.portalApp.usage;

  const [days, setDays] = useState<UsageDays>(7);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsagePage | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (p: number, d: UsageDays) => {
    try {
      const next = await getUsage(p, PAGE_SIZE, d);
      setData(next);
      setLoadError(false);
    } catch {
      setData({ records: [], total: 0, page: p, pageSize: PAGE_SIZE });
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load(page, days);
  }, [page, days, load]);

  function handleDaysChange(value: UsageDays) {
    setDays(value);
    setPage(1); // window change resets pagination
    setData(null); // show skeleton while reloading
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <ToggleGroup
        multiple={false}
        value={[String(days)]}
        onValueChange={(value) => {
          const next = Number(value[0]) as UsageDays | undefined;
          if (next && next !== days) handleDaysChange(next);
        }}
        variant="outline"
      >
        <ToggleGroupItem value="1">{u.daysToday}</ToggleGroupItem>
        <ToggleGroupItem value="7">{u.days7}</ToggleGroupItem>
        <ToggleGroupItem value="30">{u.days30}</ToggleGroupItem>
      </ToggleGroup>

      {loadError && <p className="text-sm text-destructive">{u.loadFailed}</p>}

      {data === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : data.records.length === 0 ? (
        <Empty className="border min-h-[280px]">
          <EmptyHeader>
            <EmptyTitle>{u.empty}</EmptyTitle>
            <EmptyDescription>{u.emptyDesc}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{u.colTime}</TableHead>
                  <TableHead>{u.colModel}</TableHead>
                  <TableHead>{u.colBucket}</TableHead>
                  <TableHead>{u.colStatus}</TableHead>
                  <TableHead className="text-right">{u.colInput}</TableHead>
                  <TableHead className="text-right">{u.colOutput}</TableHead>
                  <TableHead className="text-right">{u.colTotal}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.records.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatDateTime(record.timestamp)}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs max-w-[180px] truncate"
                      title={record.modelKey}
                    >
                      {record.modelKey}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{record.bucket}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          isSuccessStatus(record.status)
                            ? "secondary"
                            : "destructive"
                        }
                      >
                        {isSuccessStatus(record.status)
                          ? u.statusSuccess
                          : record.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(record.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(record.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatTokens(record.totalTokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DataPagination
            page={page}
            totalPages={totalPages}
            onPage={setPage}
            labels={{
              prevPage: u.prevPage,
              nextPage: u.nextPage,
              pageInfo: u.pageInfo,
            }}
          />
        </div>
      )}
    </div>
  );
}
