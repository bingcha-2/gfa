/**
 * Codex「快速(Fast)」服务档的服务端能力判定。结果作为 lease-token 响应的 codexFastAllowed
 * 下发给客户端;客户端据此放行/剥离请求体的 service_tier=priority(见客户端 codex_service_tier.go)。
 *
 * 只有「能力闸」——被租号的 plan 是否支持快速。是否真开由用户在 app 里点「快速」决定(codexFastMode
 * 写桌面档位让 Codex 发 priority);经济由 fair-share ×2 兜(见 fair-share-tracker)。无服务端总开关。
 */

/** ChatGPT plan 是否具备「快速(priority)」能力。镜像客户端 codexPlanSupportsFast:
 *  Pro / Team / Business / Enterprise / Edu 有;Plus / Free / 未知 一律无。
 *  注意 "plus" 不含子串 "pro",故 pro 命中不会误伤 Plus。 */
export function codexPlanSupportsFast(planType: string): boolean {
  const p = String(planType || "").trim().toLowerCase();
  if (!p) return false;
  return /enterprise|business|team|edu|pro/.test(p);
}
