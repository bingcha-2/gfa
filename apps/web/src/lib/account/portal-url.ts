/**
 * 用户中心(toC 门户)入口 URL —— 官网各处「进入用户中心」按钮的统一目标。
 *
 * 单域部署(本地开发、单域名上线):留空,使用相对路径 `/account`。
 * 分域部署(官网 bcai.lol / 用户中心 my.bcai.lol,见 Caddyfile.migration):
 *   官网 host 会 404 掉相对的 `/account`,必须指向用户中心子域的绝对地址。
 *   设 `NEXT_PUBLIC_ACCOUNT_URL=https://my.bcai.lol/account` 即可。
 *
 * 与 `NEXT_PUBLIC_API_BASE_URL` 同一套路:NEXT_PUBLIC_ 前缀使其在
 * 服务端与浏览器端组件中都能被构建期内联。
 */
export const ACCOUNT_URL =
  process.env.NEXT_PUBLIC_ACCOUNT_URL || "/account";
