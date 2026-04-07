import { useState, useEffect } from "react";
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
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Zap,
} from "lucide-react";
import { ToastContainer } from "./components/Toast";

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
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem("sidebar-collapsed") === "true";
  });

  useEffect(() => {
    loadAccounts();
    loadSettings();
    initEventListener();
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

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
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <Zap size={20} />
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-title">GFA Client</span>
            <span className="sidebar-subtitle">Google Family Automation</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${currentPage === item.id ? "active" : ""}`}
              onClick={() => setCurrentPage(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-collapse-btn" onClick={toggleCollapsed}>
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
          <div className="sidebar-version">v3.0.0</div>
        </div>
      </aside>
      <main className="main-content">
        <div key={currentPage} className="animate-in" style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", gap: 20 }}>
          {renderPage()}
        </div>
      </main>
      <ToastContainer />
    </div>
  );
}

export default App;
