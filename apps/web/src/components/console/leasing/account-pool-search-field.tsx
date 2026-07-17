"use client";

import { SearchIcon, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { boundCustomerEmailMatches, type SearchableAccountPool } from "./account-pool-search";

export function AccountPoolSearchField({
  value,
  onValueChange,
  resultCount,
  totalCount,
}: {
  value: string;
  onValueChange: (value: string) => void;
  resultCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <InputGroup className="w-full sm:w-80">
        <InputGroupInput
          type="text"
          role="searchbox"
          aria-label="搜索母号或绑定用户邮箱"
          placeholder="搜索母号或绑定用户邮箱"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        />
        <InputGroupAddon align="inline-start">
          <SearchIcon />
        </InputGroupAddon>
        {value ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="清除账号池搜索" onClick={() => onValueChange("")}>
              <XIcon />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {value.trim() ? <Badge variant="outline">{resultCount}/{totalCount}</Badge> : null}
    </div>
  );
}

export function BoundCustomerEmailSearchHit({
  account,
  query,
}: {
  account: SearchableAccountPool;
  query: string;
}) {
  const matches = boundCustomerEmailMatches(account, query);
  if (!matches.length) return null;
  const visible = matches.slice(0, 2);
  return (
    <div
      className="mt-1 max-w-72 truncate text-xs text-muted-foreground"
      title={`绑定用户：${matches.join("、")}`}
    >
      绑定用户：{visible.join("、")}{matches.length > visible.length ? ` 等 ${matches.length} 个` : ""}
    </div>
  );
}
