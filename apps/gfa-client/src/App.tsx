import { useEffect } from "react";
import "./App.css";
import { useAppStore } from "./stores/useAppStore";
import { Accounts } from "./pages/Accounts";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Redeem } from "./pages/Redeem";
import { Swap } from "./pages/Swap";
import { Settings } from "./pages/Settings";
import { Dashboard } from "./pages/Dashboard";
import {
  LayoutDashboard,
  Users,
  Mail,
  ArrowLeftRight,
  Gift,
  SettingsIcon,
} from "lucide-react";

const NAV_ITEMS = [
  { id: "dashboard", label: "仪表盘", icon: LayoutDashboard },
  { id: "accounts", label: "账号管理", icon: Users },
  { id: "accept-invite", label: "接受邀请", icon: Mail },
  { id: "redeem", label: "兑换码", icon: Gift },
  { id: "swap", label: "账号置换", icon: ArrowLeftRight },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

function App() {
  const { currentPage, setCurrentPage, loadAccounts, loadSettings, initEventListener } = useAppStore();

  useEffect(() => {
    loadAccounts();
    loadSettings();
    initEventListener();
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard": return <Dashboard />;
      case "accounts": return <Accounts />;
      case "accept-invite": return <AcceptInvite />;
      case "redeem": return <Redeem />;
      case "swap": return <Swap />;
      case "settings": return <Settings />;
      default: return <Dashboard />;
    }
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">GFA Client</div>
          <div className="sidebar-subtitle">Google Family Automation</div>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${currentPage === item.id ? "active" : ""}`}
              onClick={() => setCurrentPage(item.id)}
            >
              <item.icon />
              <span>{item.label}</span>
            </div>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}

export default App;
