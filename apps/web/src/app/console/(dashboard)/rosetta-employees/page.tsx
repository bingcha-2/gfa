"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Employee = {
  id: string;
  email: string;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  stats: { total: number; accepted: number; failed: number; disabled: number; deleted: number };
};

type EmployeeAccount = {
  id: string;
  employeeId: string;
  email: string;
  projectId: string;
  planType?: string;
  status: string;
  acceptedAt?: string;
  lastConversationOkAt?: string;
};

export default function RosettaEmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accounts, setAccounts] = useState<EmployeeAccount[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/rosetta/employees")
      .then((res) => res.json())
      .then((data) => {
        setEmployees(data.employees || []);
        setAccounts(data.accounts || []);
      })
      .finally(() => setLoading(false));
  }, []);

  const employeeById = useMemo(() => new Map(employees.map((item) => [item.id, item])), [employees]);
  const term = query.trim().toLowerCase();
  const filteredAccounts = accounts.filter((item) => {
    if (!term) return true;
    const owner = employeeById.get(item.employeeId);
    return [item.email, item.projectId, item.status, item.planType, owner?.email]
      .some((value) => String(value || "").toLowerCase().includes(term));
  });

  const totals = employees.reduce(
    (sum, item) => {
      sum.total += item.stats?.total || 0;
      sum.accepted += item.stats?.accepted || 0;
      sum.failed += item.stats?.failed || 0;
      return sum;
    },
    { total: 0, accepted: 0, failed: 0 }
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Rosetta 员工账号</h1>
        <p className="text-sm text-muted-foreground">查看员工注册、贡献账号、自动入池统计。</p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">员工</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{employees.length}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">提交账号</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{totals.total}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">已入池</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{totals.accepted}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">失败</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{totals.failed}</CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>员工列表</CardTitle>
          <Input className="w-72" placeholder="搜索员工 / 账号 / projectId" value={query} onChange={(event) => setQuery(event.target.value)} />
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>员工</TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>项目号</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>对话测试</TableHead>
                  <TableHead>入池时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((account) => {
                  const owner = employeeById.get(account.employeeId);
                  return (
                    <TableRow key={account.id}>
                      <TableCell>{owner?.email || account.employeeId}</TableCell>
                      <TableCell className="font-mono text-xs">{account.email}</TableCell>
                      <TableCell className="font-mono text-xs">{account.projectId || "-"}</TableCell>
                      <TableCell>{account.planType || "-"}</TableCell>
                      <TableCell><Badge variant={account.status === "accepted" ? "default" : "secondary"}>{account.status}</Badge></TableCell>
                      <TableCell>{account.lastConversationOkAt ? new Date(account.lastConversationOkAt).toLocaleString() : "-"}</TableCell>
                      <TableCell>{account.acceptedAt ? new Date(account.acceptedAt).toLocaleString() : "-"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
