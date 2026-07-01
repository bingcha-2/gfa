export namespace accountgroups {
	
	export class Group {
	    id: string;
	    name: string;
	    sortOrder: number;
	    accountIds: string[];
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Group(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.sortOrder = source["sortOrder"];
	        this.accountIds = source["accountIds"];
	        this.createdAt = source["createdAt"];
	    }
	}

}

export namespace aghistory {
	
	export class AutoSwitchHitGroup {
	    groupId: string;
	    groupName: string;
	    percentage: number;
	
	    static createFrom(source: any = {}) {
	        return new AutoSwitchHitGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.groupId = source["groupId"];
	        this.groupName = source["groupName"];
	        this.percentage = source["percentage"];
	    }
	}
	export class AutoSwitchReason {
	    rule: string;
	    threshold: number;
	    scopeMode: string;
	    selectedGroupIds?: string[];
	    selectedGroupNames?: string[];
	    hitGroups?: AutoSwitchHitGroup[];
	    candidateCount: number;
	    selectedPolicy: string;
	
	    static createFrom(source: any = {}) {
	        return new AutoSwitchReason(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rule = source["rule"];
	        this.threshold = source["threshold"];
	        this.scopeMode = source["scopeMode"];
	        this.selectedGroupIds = source["selectedGroupIds"];
	        this.selectedGroupNames = source["selectedGroupNames"];
	        this.hitGroups = this.convertValues(source["hitGroups"], AutoSwitchHitGroup);
	        this.candidateCount = source["candidateCount"];
	        this.selectedPolicy = source["selectedPolicy"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SwitchHistoryItem {
	    id: string;
	    timestamp: number;
	    accountId: string;
	    targetEmail: string;
	    triggerType: string;
	    triggerSource: string;
	    localOk: boolean;
	    seamlessOk: boolean;
	    success: boolean;
	    localDurationMs: number;
	    seamlessDurationMs?: number;
	    totalDurationMs: number;
	    errorStage?: string;
	    errorCode?: string;
	    errorMessage?: string;
	    seamlessEffectiveMode?: string;
	    seamlessFromEmail?: string;
	    seamlessToEmail?: string;
	    seamlessExecutionId?: string;
	    seamlessFinishedAt?: string;
	    autoSwitchReason?: AutoSwitchReason;
	
	    static createFrom(source: any = {}) {
	        return new SwitchHistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.timestamp = source["timestamp"];
	        this.accountId = source["accountId"];
	        this.targetEmail = source["targetEmail"];
	        this.triggerType = source["triggerType"];
	        this.triggerSource = source["triggerSource"];
	        this.localOk = source["localOk"];
	        this.seamlessOk = source["seamlessOk"];
	        this.success = source["success"];
	        this.localDurationMs = source["localDurationMs"];
	        this.seamlessDurationMs = source["seamlessDurationMs"];
	        this.totalDurationMs = source["totalDurationMs"];
	        this.errorStage = source["errorStage"];
	        this.errorCode = source["errorCode"];
	        this.errorMessage = source["errorMessage"];
	        this.seamlessEffectiveMode = source["seamlessEffectiveMode"];
	        this.seamlessFromEmail = source["seamlessFromEmail"];
	        this.seamlessToEmail = source["seamlessToEmail"];
	        this.seamlessExecutionId = source["seamlessExecutionId"];
	        this.seamlessFinishedAt = source["seamlessFinishedAt"];
	        this.autoSwitchReason = this.convertValues(source["autoSwitchReason"], AutoSwitchReason);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace codexbiz {
	
	export class ReferralTimeFrameRule {
	    type: string;
	    invites_sent: number;
	    invites_total: number;
	
	    static createFrom(source: any = {}) {
	        return new ReferralTimeFrameRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.invites_sent = source["invites_sent"];
	        this.invites_total = source["invites_total"];
	    }
	}
	export class ReferralEligibilityRules {
	    requires_explicit_confirmation?: boolean;
	    rules: string[];
	    time_frame_rules: ReferralTimeFrameRule[];
	
	    static createFrom(source: any = {}) {
	        return new ReferralEligibilityRules(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requires_explicit_confirmation = source["requires_explicit_confirmation"];
	        this.rules = source["rules"];
	        this.time_frame_rules = this.convertValues(source["time_frame_rules"], ReferralTimeFrameRule);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ReferralInvite {
	    email: string;
	
	    static createFrom(source: any = {}) {
	        return new ReferralInvite(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	    }
	}
	export class ReferralInviteEligibility {
	    should_show: boolean;
	    remaining_referrals?: number;
	    ineligible_reason_code?: string;
	    grant_action?: string;
	    grant_amount?: number;
	    referral_key: string;
	
	    static createFrom(source: any = {}) {
	        return new ReferralInviteEligibility(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.should_show = source["should_show"];
	        this.remaining_referrals = source["remaining_referrals"];
	        this.ineligible_reason_code = source["ineligible_reason_code"];
	        this.grant_action = source["grant_action"];
	        this.grant_amount = source["grant_amount"];
	        this.referral_key = source["referral_key"];
	    }
	}
	export class ReferralInviteResponse {
	    invites: ReferralInvite[];
	
	    static createFrom(source: any = {}) {
	        return new ReferralInviteResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.invites = this.convertValues(source["invites"], ReferralInvite);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ResetCredit {
	    id?: string;
	    status?: string;
	    reset_type?: string;
	    granted_at?: number;
	    expires_at?: number;
	    redeemed_at?: number;
	    raw_status?: string;
	
	    static createFrom(source: any = {}) {
	        return new ResetCredit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.reset_type = source["reset_type"];
	        this.granted_at = source["granted_at"];
	        this.expires_at = source["expires_at"];
	        this.redeemed_at = source["redeemed_at"];
	        this.raw_status = source["raw_status"];
	    }
	}
	export class ResetCreditsSnapshot {
	    available_count?: number;
	    credits: ResetCredit[];
	    next_expires_at?: number;
	
	    static createFrom(source: any = {}) {
	        return new ResetCreditsSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available_count = source["available_count"];
	        this.credits = this.convertValues(source["credits"], ResetCredit);
	        this.next_expires_at = source["next_expires_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SubscriptionSnapshot {
	    AccountID: string;
	    PlanType: string;
	    SubscriptionActiveUntil: string;
	
	    static createFrom(source: any = {}) {
	        return new SubscriptionSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.AccountID = source["AccountID"];
	        this.PlanType = source["PlanType"];
	        this.SubscriptionActiveUntil = source["SubscriptionActiveUntil"];
	    }
	}

}

export namespace codexsettings {
	
	export class QuickConfig {
	    contextWindow1m: boolean;
	    autoCompactTokenLimit: number;
	    detectedModelContextWindow?: number;
	    detectedAutoCompactTokenLimit?: number;
	
	    static createFrom(source: any = {}) {
	        return new QuickConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.contextWindow1m = source["contextWindow1m"];
	        this.autoCompactTokenLimit = source["autoCompactTokenLimit"];
	        this.detectedModelContextWindow = source["detectedModelContextWindow"];
	        this.detectedAutoCompactTokenLimit = source["detectedAutoCompactTokenLimit"];
	    }
	}
	export class Settings {
	    codexAppPath: string;
	    launchOnSwitch: boolean;
	    restartAppOnSwitch: boolean;
	    restartAppPath: string;
	    showApiEntry: boolean;
	    filterMemory: boolean;
	    showCodeReviewQuota: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.codexAppPath = source["codexAppPath"];
	        this.launchOnSwitch = source["launchOnSwitch"];
	        this.restartAppOnSwitch = source["restartAppOnSwitch"];
	        this.restartAppPath = source["restartAppPath"];
	        this.showApiEntry = source["showApiEntry"];
	        this.filterMemory = source["filterMemory"];
	        this.showCodeReviewQuota = source["showCodeReviewQuota"];
	    }
	}

}

export namespace economy {
	
	export class AlertConfig {
	    enabled: boolean;
	    thresholdPct: number;
	
	    static createFrom(source: any = {}) {
	        return new AlertConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.thresholdPct = source["thresholdPct"];
	    }
	}
	export class AlertResult {
	    Alert: boolean;
	    LowestPercentage: number;
	    LowModels: string[];
	
	    static createFrom(source: any = {}) {
	        return new AlertResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Alert = source["Alert"];
	        this.LowestPercentage = source["LowestPercentage"];
	        this.LowModels = source["LowModels"];
	    }
	}
	export class AppSpeed {
	    contextPreset: string;
	    tier: string;
	    customContextWindow?: number;
	    customAutoCompact?: number;
	
	    static createFrom(source: any = {}) {
	        return new AppSpeed(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.contextPreset = source["contextPreset"];
	        this.tier = source["tier"];
	        this.customContextWindow = source["customContextWindow"];
	        this.customAutoCompact = source["customAutoCompact"];
	    }
	}
	export class SwitchConfig {
	    Enabled: boolean;
	    ThresholdPct: number;
	    ScopeMode: string;
	    SelectedAccountIDs: string[];
	
	    static createFrom(source: any = {}) {
	        return new SwitchConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Enabled = source["Enabled"];
	        this.ThresholdPct = source["ThresholdPct"];
	        this.ScopeMode = source["ScopeMode"];
	        this.SelectedAccountIDs = source["SelectedAccountIDs"];
	    }
	}

}

export namespace gateway {
	
	export class ConnTestResult {
	    ok: boolean;
	    status: number;
	    latencyMs: number;
	    err: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnTestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.status = source["status"];
	        this.latencyMs = source["latencyMs"];
	        this.err = source["err"];
	    }
	}

}

export namespace gatewaykeys {
	
	export class Key {
	    id: string;
	    name: string;
	    value: string;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Key(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.value = source["value"];
	        this.createdAt = source["createdAt"];
	    }
	}

}

export namespace hub {
	
	export class GatewayStatus {
	    running: boolean;
	    addr: string;
	    port: number;
	
	    static createFrom(source: any = {}) {
	        return new GatewayStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.addr = source["addr"];
	        this.port = source["port"];
	    }
	}

}

export namespace instance {
	
	export class Profile {
	    id: string;
	    provider: string;
	    name: string;
	    userDataDir: string;
	    workingDir?: string;
	    extraArgs?: string;
	    bindAccountId?: string;
	    launchMode?: string;
	    appSpeed?: string;
	    followLocalAccount?: boolean;
	    quickContextWindow?: number;
	    quickAutoCompact?: number;
	    createdAt: number;
	    lastLaunchedAt?: number;
	    pid?: number;
	
	    static createFrom(source: any = {}) {
	        return new Profile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.provider = source["provider"];
	        this.name = source["name"];
	        this.userDataDir = source["userDataDir"];
	        this.workingDir = source["workingDir"];
	        this.extraArgs = source["extraArgs"];
	        this.bindAccountId = source["bindAccountId"];
	        this.launchMode = source["launchMode"];
	        this.appSpeed = source["appSpeed"];
	        this.followLocalAccount = source["followLocalAccount"];
	        this.quickContextWindow = source["quickContextWindow"];
	        this.quickAutoCompact = source["quickAutoCompact"];
	        this.createdAt = source["createdAt"];
	        this.lastLaunchedAt = source["lastLaunchedAt"];
	        this.pid = source["pid"];
	    }
	}

}

export namespace main {
	
	export class ProductQuotaWindow {
	    hourlyPercent?: number;
	    weeklyPercent?: number;
	    hourlyResetAt: string;
	    weeklyResetAt: string;
	    myHourlyFraction?: number;
	    myWeeklyFraction?: number;
	    myShare?: number;
	    exclusive?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProductQuotaWindow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hourlyPercent = source["hourlyPercent"];
	        this.weeklyPercent = source["weeklyPercent"];
	        this.hourlyResetAt = source["hourlyResetAt"];
	        this.weeklyResetAt = source["weeklyResetAt"];
	        this.myHourlyFraction = source["myHourlyFraction"];
	        this.myWeeklyFraction = source["myWeeklyFraction"];
	        this.myShare = source["myShare"];
	        this.exclusive = source["exclusive"];
	    }
	}
	export class SubscriptionSnapshot {
	    id: string;
	    status: string;
	    expiresAt: string;
	    deviceLimit: number;
	    priority: number;
	    products: string[];
	    levels: Record<string, string>;
	    remainFraction?: number;
	    productQuota?: Record<string, ProductQuotaWindow>;
	
	    static createFrom(source: any = {}) {
	        return new SubscriptionSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.expiresAt = source["expiresAt"];
	        this.deviceLimit = source["deviceLimit"];
	        this.priority = source["priority"];
	        this.products = source["products"];
	        this.levels = source["levels"];
	        this.remainFraction = source["remainFraction"];
	        this.productQuota = this.convertValues(source["productQuota"], ProductQuotaWindow, true);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Config {
	    accountCard: string;
	    cardExpiry: string;
	    deviceId: string;
	    proxyPort: number;
	    idePath: string;
	    hubPath: string;
	    codexAppPath: string;
	    claudeDesktopPath: string;
	    userToken: string;
	    userTokenExpiry: string;
	    userEmail: string;
	    planName: string;
	    planExpiry: string;
	    planDeviceMax: number;
	    deviceName: string;
	    subscriptions: SubscriptionSnapshot[];
	    codexMode: string;
	    codexRelayBase: string;
	    codexRelayKey: string;
	    codexRelayProtocol: string;
	    codexModelMap: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accountCard = source["accountCard"];
	        this.cardExpiry = source["cardExpiry"];
	        this.deviceId = source["deviceId"];
	        this.proxyPort = source["proxyPort"];
	        this.idePath = source["idePath"];
	        this.hubPath = source["hubPath"];
	        this.codexAppPath = source["codexAppPath"];
	        this.claudeDesktopPath = source["claudeDesktopPath"];
	        this.userToken = source["userToken"];
	        this.userTokenExpiry = source["userTokenExpiry"];
	        this.userEmail = source["userEmail"];
	        this.planName = source["planName"];
	        this.planExpiry = source["planExpiry"];
	        this.planDeviceMax = source["planDeviceMax"];
	        this.deviceName = source["deviceName"];
	        this.subscriptions = this.convertValues(source["subscriptions"], SubscriptionSnapshot);
	        this.codexMode = source["codexMode"];
	        this.codexRelayBase = source["codexRelayBase"];
	        this.codexRelayKey = source["codexRelayKey"];
	        this.codexRelayProtocol = source["codexRelayProtocol"];
	        this.codexModelMap = source["codexModelMap"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DetectedPaths {
	    idePath: string;
	    hubPath: string;
	    codexAppPath: string;
	    claudeDesktopPath: string;
	
	    static createFrom(source: any = {}) {
	        return new DetectedPaths(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.idePath = source["idePath"];
	        this.hubPath = source["hubPath"];
	        this.codexAppPath = source["codexAppPath"];
	        this.claudeDesktopPath = source["claudeDesktopPath"];
	    }
	}
	export class IDEProduct {
	    id: string;
	    name: string;
	    detected: boolean;
	    detectedPath: string;
	    injected: boolean;
	    supportsInjection: boolean;
	    injectionType: string;
	
	    static createFrom(source: any = {}) {
	        return new IDEProduct(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.detected = source["detected"];
	        this.detectedPath = source["detectedPath"];
	        this.injected = source["injected"];
	        this.supportsInjection = source["supportsInjection"];
	        this.injectionType = source["injectionType"];
	    }
	}
	export class IDEStatus {
	    products: IDEProduct[];
	    proxyUrl: string;
	    isLsProxyApplied: boolean;
	
	    static createFrom(source: any = {}) {
	        return new IDEStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.products = this.convertValues(source["products"], IDEProduct);
	        this.proxyUrl = source["proxyUrl"];
	        this.isLsProxyApplied = source["isLsProxyApplied"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class UpdateStatus {
	    status: string;
	    version: string;
	    current: string;
	    changelog: string;
	    percent: number;
	    error: string;
	    canSkip: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UpdateStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.version = source["version"];
	        this.current = source["current"];
	        this.changelog = source["changelog"];
	        this.percent = source["percent"];
	        this.error = source["error"];
	        this.canSkip = source["canSkip"];
	    }
	}

}

export namespace manager {
	
	export class AccountView {
	    id: string;
	    email: string;
	    name: string;
	    provider: string;
	    authKind: string;
	    note: string;
	    planType: string;
	    quotaStatus: string;
	    tags: string[];
	    poolEnabled: boolean;
	    priority: boolean;
	    hourlyPercent: number;
	    weeklyPercent: number;
	    hourlyResetAt: number;
	    weeklyResetAt: number;
	    lastUsedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new AccountView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.email = source["email"];
	        this.name = source["name"];
	        this.provider = source["provider"];
	        this.authKind = source["authKind"];
	        this.note = source["note"];
	        this.planType = source["planType"];
	        this.quotaStatus = source["quotaStatus"];
	        this.tags = source["tags"];
	        this.poolEnabled = source["poolEnabled"];
	        this.priority = source["priority"];
	        this.hourlyPercent = source["hourlyPercent"];
	        this.weeklyPercent = source["weeklyPercent"];
	        this.hourlyResetAt = source["hourlyResetAt"];
	        this.weeklyResetAt = source["weeklyResetAt"];
	        this.lastUsedAt = source["lastUsedAt"];
	    }
	}

}

export namespace modelprovider {
	
	export class ConnTestResult {
	    ok: boolean;
	    status: number;
	    latencyMs: number;
	    err: string;
	    model: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnTestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.status = source["status"];
	        this.latencyMs = source["latencyMs"];
	        this.err = source["err"];
	        this.model = source["model"];
	    }
	}
	export class Model {
	    id: string;
	    displayName?: string;
	
	    static createFrom(source: any = {}) {
	        return new Model(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.displayName = source["displayName"];
	    }
	}
	export class ListModelsResult {
	    models: Model[];
	    latencyMs: number;
	
	    static createFrom(source: any = {}) {
	        return new ListModelsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.models = this.convertValues(source["models"], Model);
	        this.latencyMs = source["latencyMs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Provider {
	    id: string;
	    name: string;
	    baseURL: string;
	    apiKey: string;
	    wireApi: string;
	    modelCatalog: string[];
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Provider(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.baseURL = source["baseURL"];
	        this.apiKey = source["apiKey"];
	        this.wireApi = source["wireApi"];
	        this.modelCatalog = source["modelCatalog"];
	        this.createdAt = source["createdAt"];
	    }
	}

}

export namespace refreshcfg {
	
	export class Config {
	    quotaMinutes: number;
	    currentMinutes: number;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.quotaMinutes = source["quotaMinutes"];
	        this.currentMinutes = source["currentMinutes"];
	    }
	}

}

export namespace sessionsync {
	
	export class RestoreSummary {
	    requestedSessionCount: number;
	    restoredSessionCount: number;
	    restoredInstanceCount: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new RestoreSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestedSessionCount = source["requestedSessionCount"];
	        this.restoredSessionCount = source["restoredSessionCount"];
	        this.restoredInstanceCount = source["restoredInstanceCount"];
	        this.message = source["message"];
	    }
	}
	export class SessionLocation {
	    instanceId: string;
	    instanceName: string;
	    running: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionLocation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.instanceId = source["instanceId"];
	        this.instanceName = source["instanceName"];
	        this.running = source["running"];
	    }
	}
	export class SessionRecord {
	    sessionId: string;
	    title: string;
	    cwd: string;
	    updatedAt?: number;
	    locationCount: number;
	    locations: SessionLocation[];
	
	    static createFrom(source: any = {}) {
	        return new SessionRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.title = source["title"];
	        this.cwd = source["cwd"];
	        this.updatedAt = source["updatedAt"];
	        this.locationCount = source["locationCount"];
	        this.locations = this.convertValues(source["locations"], SessionLocation);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SessionTokenStats {
	    sessionId: string;
	    inputTokens: number;
	    outputTokens: number;
	    totalTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionTokenStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.totalTokens = source["totalTokens"];
	    }
	}
	export class TrashSummary {
	    requestedSessionCount: number;
	    trashedSessionCount: number;
	    trashedInstanceCount: number;
	    trashDir: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new TrashSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestedSessionCount = source["requestedSessionCount"];
	        this.trashedSessionCount = source["trashedSessionCount"];
	        this.trashedInstanceCount = source["trashedInstanceCount"];
	        this.trashDir = source["trashDir"];
	        this.message = source["message"];
	    }
	}
	export class TrashedSessionLocation {
	    instanceId: string;
	    instanceName: string;
	
	    static createFrom(source: any = {}) {
	        return new TrashedSessionLocation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.instanceId = source["instanceId"];
	        this.instanceName = source["instanceName"];
	    }
	}
	export class TrashedSessionRecord {
	    sessionId: string;
	    title: string;
	    cwd: string;
	    deletedAt?: number;
	    locationCount: number;
	    locations: TrashedSessionLocation[];
	
	    static createFrom(source: any = {}) {
	        return new TrashedSessionRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.title = source["title"];
	        this.cwd = source["cwd"];
	        this.deletedAt = source["deletedAt"];
	        this.locationCount = source["locationCount"];
	        this.locations = this.convertValues(source["locations"], TrashedSessionLocation);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace stats {
	
	export class AccountStat {
	    authId: string;
	    email: string;
	    requests: number;
	    totalTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new AccountStat(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.authId = source["authId"];
	        this.email = source["email"];
	        this.requests = source["requests"];
	        this.totalTokens = source["totalTokens"];
	    }
	}
	export class RequestEntry {
	    atMs: number;
	    authId: string;
	    email: string;
	    model: string;
	    failed: boolean;
	    latencyMs: number;
	
	    static createFrom(source: any = {}) {
	        return new RequestEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.atMs = source["atMs"];
	        this.authId = source["authId"];
	        this.email = source["email"];
	        this.model = source["model"];
	        this.failed = source["failed"];
	        this.latencyMs = source["latencyMs"];
	    }
	}
	export class LogPage {
	    total: number;
	    entries: RequestEntry[];
	
	    static createFrom(source: any = {}) {
	        return new LogPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.entries = this.convertValues(source["entries"], RequestEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ModelStat {
	    model: string;
	    requests: number;
	    totalTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new ModelStat(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.model = source["model"];
	        this.requests = source["requests"];
	        this.totalTokens = source["totalTokens"];
	    }
	}
	
	export class Snapshot {
	    totalRequests: number;
	    totalFailed: number;
	    totalInputTokens: number;
	    totalOutputTokens: number;
	    byAccount: AccountStat[];
	    byModel: ModelStat[];
	    recent: RequestEntry[];
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalRequests = source["totalRequests"];
	        this.totalFailed = source["totalFailed"];
	        this.totalInputTokens = source["totalInputTokens"];
	        this.totalOutputTokens = source["totalOutputTokens"];
	        this.byAccount = this.convertValues(source["byAccount"], AccountStat);
	        this.byModel = this.convertValues(source["byModel"], ModelStat);
	        this.recent = this.convertValues(source["recent"], RequestEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace wakeup {
	
	export class Config {
	    enabled: boolean;
	    intervalMinutes: number;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.intervalMinutes = source["intervalMinutes"];
	    }
	}
	export class RunEntry {
	    atMs: number;
	    accountId: string;
	    email: string;
	    ok: boolean;
	    err?: string;
	    newExpiry?: number;
	
	    static createFrom(source: any = {}) {
	        return new RunEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.atMs = source["atMs"];
	        this.accountId = source["accountId"];
	        this.email = source["email"];
	        this.ok = source["ok"];
	        this.err = source["err"];
	        this.newExpiry = source["newExpiry"];
	    }
	}

}

