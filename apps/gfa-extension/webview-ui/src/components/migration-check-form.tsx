import React, { useEffect, useRef, useState, useTransition } from "react";
import { apiRequest, getErrorMessage } from "../lib/vscode-api";

type CheckMigrationResponse = {
  eligible: boolean; needsMigration: boolean; needsSync: boolean;
  syncTaskId?: string; reason: string; message: string;
  memberInfo?: { groupName: string; expiresAt: string | null; accountStatus: string };
};
type SelfMigrateResponse = { success: boolean; message: string; targetGroupName?: string; taskId?: string };

export function MigrationCheckForm() {
  const [email, setEmail] = useState("");
  const [checkResult, setCheckResult] = useState<CheckMigrationResponse | null>(null);
  const [migrateResult, setMigrateResult] = useState<SelfMigrateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isMigrating, setIsMigrating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const emailRef = useRef("");

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  function stopPolling() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } setIsSyncing(false); }

  function startPolling(currentEmail: string) {
    stopPolling(); setIsSyncing(true); emailRef.current = currentEmail;
    pollRef.current = setInterval(async () => {
      try {
        const data = await apiRequest<CheckMigrationResponse>("public/check-migration", { method: "POST", body: { email: emailRef.current } });
        setCheckResult(data);
        if (!data.needsSync) stopPolling();
      } catch {}
    }, 3000);
  }

  function onCheck(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setCheckResult(null); setMigrateResult(null); stopPolling();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return;
    startTransition(async () => {
      try {
        const data = await apiRequest<CheckMigrationResponse>("public/check-migration", { method: "POST", body: { email: normalizedEmail } });
        setCheckResult(data);
        if (data.needsSync) startPolling(normalizedEmail);
      } catch (err) { setError(getErrorMessage(err)); }
    });
  }

  async function onMigrate() {
    if (isMigrating) return;
    setIsMigrating(true); setError(null); setMigrateResult(null);
    try {
      const data = await apiRequest<SelfMigrateResponse>("public/self-migrate", { method: "POST", body: { email: email.trim().toLowerCase() } });
      setMigrateResult(data);
      if (data.success) setCheckResult(null);
    } catch (err) { setError(getErrorMessage(err)); } finally { setIsMigrating(false); }
  }

  const showMemberInfo = checkResult?.memberInfo && !migrateResult;
  const showMigrateButton = checkResult?.needsMigration && !migrateResult;

  return (
    <section className="form-card">
      <div className="panel-stack">
        <form className="field-grid" onSubmit={onCheck} style={{ marginTop: '16px' }}>
          <div className="field">
            <label htmlFor="migrate-email">邮箱地址</label>
            <input id="migrate-email" autoComplete="email" inputMode="email" placeholder="your-account@gmail.com"
              required type="email" value={email} onChange={(e) => setEmail(e.target.value.trimStart())} />
            <small>输入开通会员时使用的 Gmail 邮箱，系统将自动检测您所在家庭组的母号状态。</small>
          </div>
          <div className="field-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="button" disabled={isPending || isSyncing} type="submit"
              style={{ flex: 1, padding: '8px 16px', background: '#ea580c', color: 'white', border: 'none' }}>
              {isPending ? "正在检测..." : isSyncing ? "正在同步母号状态..." : "开始检测"}
            </button>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {showMemberInfo && checkResult!.memberInfo ? (() => {
          const info = checkResult!.memberInfo!;
          return (
            <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px',
              background: checkResult!.needsMigration ? 'rgba(239, 68, 68, 0.1)' : 'rgba(234, 88, 12, 0.1)',
              border: `1px solid ${checkResult!.needsMigration ? 'rgba(239, 68, 68, 0.3)' : 'rgba(234, 88, 12, 0.3)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>{checkResult!.needsMigration ? '⚠️' : checkResult!.reason === 'NORMAL' ? '✅' : 'ℹ️'}</span>
                <strong style={{ fontSize: '14px' }}>{checkResult!.needsMigration ? '检测到异常' : checkResult!.reason === 'NORMAL' ? '母号状态正常' : '检测结果'}</strong>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {info.groupName ? <div style={{ background: 'rgba(31,26,23,0.05)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(31,26,23,0.1)', display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>家庭组</span><span className="mono strong" style={{ fontSize: '13px' }}>{info.groupName}</span></div> : null}
                {info.expiresAt ? <div style={{ background: 'rgba(31,26,23,0.05)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(31,26,23,0.1)', display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>到期时间</span><span className="mono strong" style={{ fontSize: '13px' }}>{new Date(info.expiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span></div> : null}
                <div style={{ background: 'rgba(31,26,23,0.05)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(31,26,23,0.1)', display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>母号状态</span><span className="mono strong" style={{ fontSize: '13px', color: checkResult!.needsMigration ? '#ef4444' : '#22c55e' }}>{info.accountStatus}</span></div>
              </div>
              <div className="muted">{checkResult!.message}</div>
            </div>);
        })() : null}

        {checkResult && !checkResult.eligible && !checkResult.memberInfo && !migrateResult ? (
          <div className="notice warn" style={{ marginTop: '16px' }}>{checkResult.message}</div>) : null}

        {showMigrateButton ? (
          <div style={{ marginTop: '16px' }}>
            <button className="button" disabled={isMigrating} onClick={onMigrate} type="button"
              style={{ width: '100%', padding: '10px 16px', background: '#dc2626', color: 'white', border: 'none', fontWeight: 600 }}>
              {isMigrating ? "正在执行迁移..." : "一键迁移到正常组"}
            </button>
            <small className="muted" style={{ display: 'block', marginTop: '8px', textAlign: 'center' }}>
              迁移不会影响您的到期时间，成功后请注意查收新的家庭组邀请邮件。</small>
          </div>) : null}

        {migrateResult ? (
          <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px',
            background: migrateResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${migrateResult.success ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>{migrateResult.success ? '✅' : '❌'}</span>
              <strong style={{ fontSize: '14px' }}>{migrateResult.success ? '迁移成功' : '迁移失败'}</strong>
            </div>
            <div className="muted">{migrateResult.message}</div>
            {migrateResult.success && migrateResult.targetGroupName ? (
              <div style={{ background: 'rgba(31,26,23,0.05)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(31,26,23,0.1)', display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted" style={{ fontSize: '12px' }}>新家庭组</span>
                <span className="mono strong" style={{ color: '#22c55e', fontSize: '13px' }}>{migrateResult.targetGroupName}</span>
              </div>) : null}
          </div>) : null}
      </div>
    </section>
  );
}
