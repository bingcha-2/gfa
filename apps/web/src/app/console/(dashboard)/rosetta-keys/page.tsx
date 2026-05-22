"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type AccessKey = {
  id: string;
  name: string;
  fullKey: string;
  key: string;
  status: string;
  totalRequests: number;
  totalTokensUsed: number;
  recentWindowTokens: number;
  tokenWindowLimit: number;
  createdAt: string;
  lastUsedAt: string;
};

export default function RosettaKeysPage() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (query.trim()) params.set("search", query.trim());
    fetch(`/api/rosetta/access-keys?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => setKeys(data.keys || []))
      .finally(() => setLoading(false));
  }, [query]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Rosetta 卡密</h1>
        <p className="text-sm text-muted-foreground">支持按卡密、名称、状态、会话信息搜索。</p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>卡密列表</CardTitle>
          <Input className="w-80" placeholder="搜索卡密 / 名称 / 状态" value={query} onChange={(event) => setQuery(event.target.value)} />
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>卡密</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>5小时 tokens</TableHead>
                  <TableHead>总 tokens</TableHead>
                  <TableHead>最后使用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.name || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{item.fullKey || item.key}</TableCell>
                    <TableCell><Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status}</Badge></TableCell>
                    <TableCell>{item.totalRequests}</TableCell>
                    <TableCell>{item.recentWindowTokens.toLocaleString()} / {item.tokenWindowLimit.toLocaleString()}</TableCell>
                    <TableCell>{item.totalTokensUsed.toLocaleString()}</TableCell>
                    <TableCell>{item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
