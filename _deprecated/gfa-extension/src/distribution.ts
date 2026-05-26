export type RosettaDistribution = "server" | "client" | "employee";

export const ROSETTA_DISTRIBUTION: RosettaDistribution =
  process.env.ROSETTA_DISTRIBUTION === "client"
    ? "client"
    : process.env.ROSETTA_DISTRIBUTION === "employee"
      ? "employee"
      : "server";

export const IS_CLIENT_DISTRIBUTION = ROSETTA_DISTRIBUTION === "client";
export const IS_EMPLOYEE_DISTRIBUTION = ROSETTA_DISTRIBUTION === "employee";

export const ROSETTA_VIEW_CONTAINER_ID =
  ROSETTA_DISTRIBUTION === "client"
    ? "bcai-client-sidebar"
    : ROSETTA_DISTRIBUTION === "employee"
      ? "bcai-account-assistant-sidebar"
      : "bcai-server-sidebar";

export const ROSETTA_WEBVIEW_ID =
  ROSETTA_DISTRIBUTION === "client"
    ? "bcai.clientView"
    : ROSETTA_DISTRIBUTION === "employee"
      ? "bcai.accountAssistantView"
      : "bcai.serverView";

export const BCAI_CONFIG_SECTION =
  ROSETTA_DISTRIBUTION === "client"
    ? "bcai-client"
    : ROSETTA_DISTRIBUTION === "employee"
      ? "bcai-employee"
      : "bcai";
