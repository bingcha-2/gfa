import fs from "fs";

const path = "c:/Users/Administrator/Desktop/GFA/apps/web/src/components/console-app.tsx";
let code = fs.readFileSync(path, "utf-8");

// 1. Remove RedeemCodeSummary from type ConsoleData
code = code.replace(/redeemCodes: RedeemCodeSummary\[\];\n/, "stats: any;\n");
code = code.replace(/accounts: AccountSummary\[\];/, "accounts: AccountSummary[] | null;");
code = code.replace(/groups: FamilyGroupSummary\[\];/, "groups: FamilyGroupSummary[] | null;");
code = code.replace(/orders: OrderSummary\[\];/, "orders: OrderSummary[] | null;");
code = code.replace(/tasks: TaskSummary\[\];/, "tasks: TaskSummary[] | null;");

// 2. Initial state initialization
code = code.replace(
  /const \[data, setData\] = useState<ConsoleData>\(initialData\);/,
  `const [data, setData] = useState<ConsoleData>({ ...initialData, accounts: null, groups: null, orders: null, tasks: null });`
);

// 3. Overview calculations replace
const calculationsRegex = /const availableSlots =[\s\S]*?const reviewQueue = data\.tasks\.filter\([^;]+;\n/;
code = code.replace(calculationsRegex, `
  const availableSlots = data.stats?.availableSlots ?? 0;
  const activeOrders = data.stats?.activeOrders ?? 0;
  const manualReviewTasks = data.stats?.manualReviewTasks ?? 0;
  const disabledAccounts = data.stats?.disabledAccounts ?? 0;
  const pendingInvites = data.stats?.pendingInvites ?? 0;
  const unusedCodes = data.stats?.unusedCodes ?? 0;
  const recentOrders = data.stats?.recentOrders ?? [];
  const reviewQueue = data.stats?.reviewQueue ?? [];
`);

// 4. Update the load logic
// Replace loadDashboard with loadModule, and add useEffect
const loadDashboardRegex = /async function loadDashboard\(\) \{[\s\S]*?\}\n/g;
const newLoadDashboard = `
  async function loadModule(section: ConsoleSection, force = false) {
    try {
      if (section === "accounts" && (force || !data.accounts)) {
        const accounts = await apiRequest<AccountSummary[]>("accounts");
        setData(prev => ({ ...prev, accounts }));
      } else if (section === "groups" && (force || !data.groups)) {
        const groups = await apiRequest<FamilyGroupSummary[]>("family-groups");
        setData(prev => ({ ...prev, groups }));
      } else if (section === "orders" && (force || !data.orders)) {
        const orders = await apiRequest<OrderSummary[]>("orders");
        setData(prev => ({ ...prev, orders }));
      } else if ((section === "tasks" || section === "lookup") && (force || !data.tasks)) {
        const tasks = await apiRequest<TaskSummary[]>("tasks");
        setData(prev => ({ ...prev, tasks }));
      } else if (section === "overview" && force) {
        const stats = await apiRequest<any>("stats");
        setData(prev => ({ ...prev, stats }));
      }
      setError(null);
    } catch (requestError) {
      const message = getErrorMessage(requestError);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\\/|\\/$/g, "") || "console";
        router.push(\`/\${prefix}/login\`);
        router.refresh();
        return;
      }
      setError(message);
    }
  }

  // Load module data dynamically
  import { useEffect } from "react";
  useEffect(() => {
    setIsRefreshing(true);
    loadModule(activeSection).finally(() => setIsRefreshing(false));
  }, [activeSection]);

  // Keep loadDashboard alias for runAction backward compatibility but make it only reload current module
  async function loadDashboard() {
    await loadModule(activeSection, true);
    if (activeSection !== "overview") await loadModule("overview", true);
  }
`;
code = code.replace(loadDashboardRegex, newLoadDashboard.trim() + "\n");

// Add correct useEffect import if not already added. wait, it's safer to add it to top.
code = code.replace(/import \{ useState \} from "react";/, 'import { useState, useEffect } from "react";');
// remove the hacky inline import
code = code.replace(/import \{ useEffect \} from "react";\n/, "");


// 5. Update renderWorkspace panel props to handle nulls
code = code.replace(/accounts={data.accounts}/g, 'accounts={data.accounts || []}');
code = code.replace(/groups={data.groups}/g, 'groups={data.groups || []}');
code = code.replace(/orders={data.orders}/g, 'orders={data.orders || []}');
code = code.replace(/tasks={data.tasks}/g, 'tasks={data.tasks || []}');


// 6. Delete codes={data.redeemCodes} and related props from RedeemCodesPanel rendering
code = code.replace(/<RedeemCodesPanel[\s\S]*?\/>/, `<RedeemCodesPanel role={data.user.role} />`);

// Remove unused disableCode, deleteCode, createCodes from console-app.tsx since they are now in RedeemCodesPanel
const removeUnusedFunctionsRegex = /async function createCodes\([\s\S]*?async function syncGroup/s;
code = code.replace(removeUnusedFunctionsRegex, "async function syncGroup");

const disableCodeRegex = /async function disableCode\([\s\S]*?async function replaceMember/s;
code = code.replace(disableCodeRegex, "async function replaceMember");

fs.writeFileSync(path, code, "utf-8");
console.log("ConsoleApp successfully converted to lazy loading.");
