"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useConsole } from "@/components/console/shell/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export default function SettingsPage() {
  const { user } = useConsole();
  const [current, setCurrent] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (newPw !== confirm) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (newPw.length < 6) {
      toast.error("新密码至少 6 个字符");
      return;
    }

    setLoading(true);
    try {
      await apiRequest("auth/change-password", {
        method: "PATCH",
        body: {
          currentPassword: current,
          newPassword: newPw,
        },
      });
      toast.success("密码修改成功，下次登录请使用新密码");
      setCurrent("");
      setNewPw("");
      setConfirm("");
    } catch (err) {
      const msg = getErrorMessage(err);
      toast.error(msg.includes("incorrect") ? "当前密码错误" : msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>修改登录密码</CardTitle>
        <CardDescription>
          修改当前账号 ({user.email}) 的登录密码
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="current-pw">当前密码</FieldLabel>
              <Input
                id="current-pw"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-pw">新密码（至少 6 位）</FieldLabel>
              <Input
                id="new-pw"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-pw">确认新密码</FieldLabel>
              <Input
                id="confirm-pw"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </Field>
            <Field>
              <Button type="submit" disabled={loading}>
                {loading && <Spinner />}
                {loading ? "修改中…" : "确认修改"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
