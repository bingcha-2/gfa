"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";

const PAGE_SIZE = 30;

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
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/console/rosetta/employees");
      const data = await res.json();
      setEmployees(data.employees || []);
      setAccounts(data.accounts || []);
    } catch {
      toast.error("加载员工数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const accountsByEmployee = useMemo(() => {
    const map = new Map<string, EmployeeAccount[]>();
    for (const acc of accounts) {
      const list = map.get(acc.employeeId) || [];
      list.push(acc);
      map.set(acc.employeeId, list);
    }
    return map;
  }, [accounts]);

  const term = query.trim().toLowerCase();
  const filteredEmployees = useMemo(() => {
    return employees.filter((emp) => {
      if (!term) return true;
      const empAccounts = accountsByEmployee.get(emp.id) || [];
      return [emp.email, emp.id, emp.status]
        .some((v) => String(v || "").toLowerCase().includes(term))
        || empAccounts.some((a) =>
          [a.email, a.projectId, a.planType, a.status]
            .some((v) => String(v || "").toLowerCase().includes(term))
        );
    });
  }, [employees, accountsByEmployee, term]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedEmployees = filteredEmployees.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [term]);

  const totals = employees.reduce(
    (sum, item) => {
      sum.total += item.stats?.total || 0;
      sum.accepted += item.stats?.accepted || 0;
      sum.failed += item.stats?.failed || 0;
      sum.disabled += item.stats?.disabled || 0;
      return sum;
    },
    { total: 0, accepted: 0, failed: 0, disabled: 0 }
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Rosetta 员工管理</h1>
          <p className="text-sm text-muted-foreground">查看员工注册、贡献账号、自动入池统计。点击员工行展开查看其账号详情。</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          {loading ? <Spinner data-icon size={14} /> : <RefreshCwIcon data-icon className="size-4" />}
          刷新
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">员工数</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{employees.length}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">提交账号</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{totals.total}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">已入池</CardTitle></CardHeader><CardContent className="text-2xl font-semibold text-green-600">{totals.accepted}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">失败</CardTitle></CardHeader><CardContent className="text-2xl font-semibold text-red-500">{totals.failed}</CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>员工列表</CardTitle>
          <Input className="w-72" placeholder="搜索员工 / 账号 / projectId" value={query} onChange={(e) => setQuery(e.target.value)} />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner size={24} /></div>
          ) : filteredEmployees.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">{term ? "没有匹配的员工或账号" : "暂无员工数据"}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {term
                  ? `搜索到 ${filteredEmployees.length} 名员工；全部 ${employees.length} 名员工、${accounts.length} 个账号。`
                  : `全部 ${employees.length} 名员工、${accounts.length} 个账号。`}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>员工邮箱</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">提交</TableHead>
                    <TableHead className="text-right">入池</TableHead>
                    <TableHead className="text-right">失败</TableHead>
                    <TableHead>注册时间</TableHead>
                    <TableHead>最后活跃</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedEmployees.map((emp) => {
                    const isExpanded = expandedEmployee === emp.id;
                    const empAccounts = accountsByEmployee.get(emp.id) || [];
                    return (
                      <Fragment key={emp.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => setExpandedEmployee(isExpanded ? null : emp.id)}
                        >
                          <TableCell className="font-mono text-xs">{emp.email}</TableCell>
                          <TableCell>
                            <Badge variant={emp.status === "active" ? "default" : "secondary"}>{emp.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right">{emp.stats?.total || 0}</TableCell>
                          <TableCell className="text-right">{emp.stats?.accepted || 0}</TableCell>
                          <TableCell className="text-right">{emp.stats?.failed || 0}</TableCell>
                          <TableCell className="text-xs">{emp.createdAt ? new Date(emp.createdAt).toLocaleString() : "-"}</TableCell>
                          <TableCell className="text-xs">{emp.lastActiveAt ? new Date(emp.lastActiveAt).toLocaleString() : "-"}</TableCell>
                        </TableRow>
                        {isExpanded && empAccounts.length > 0 && (
                          <TableRow>
                            <TableCell colSpan={7} className="bg-muted/30 p-0">
                              <div className="px-6 py-3">
                                <p className="text-xs font-medium text-muted-foreground mb-2">该员工贡献的账号（{empAccounts.length}）</p>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>账号</TableHead>
                                      <TableHead>项目号</TableHead>
                                      <TableHead>套餐</TableHead>
                                      <TableHead>状态</TableHead>
                                      <TableHead>对话测试</TableHead>
                                      <TableHead>入池时间</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {empAccounts.map((acc) => (
                                      <TableRow key={acc.id}>
                                        <TableCell className="font-mono text-xs">{acc.email}</TableCell>
                                        <TableCell className="font-mono text-xs">{acc.projectId || "-"}</TableCell>
                                        <TableCell>{acc.planType || "-"}</TableCell>
                                        <TableCell><Badge variant={acc.status === "accepted" ? "default" : "secondary"}>{acc.status}</Badge></TableCell>
                                        <TableCell className="text-xs">{acc.lastConversationOkAt ? new Date(acc.lastConversationOkAt).toLocaleString() : "-"}</TableCell>
                                        <TableCell className="text-xs">{acc.acceptedAt ? new Date(acc.acceptedAt).toLocaleString() : "-"}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-2">
                  <Button variant="outline" size="icon" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                    <ChevronLeftIcon data-icon className="size-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    第 {currentPage} / {totalPages} 页
                  </span>
                  <Button variant="outline" size="icon" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                    <ChevronRightIcon data-icon className="size-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
