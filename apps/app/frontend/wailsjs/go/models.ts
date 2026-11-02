export namespace main {

	export class ClaudeConfigConflict {
	    id: string;
	    kind: string;
	    scope: string;
	    location: string;
	    detail: string;
	    severity: string;

	    static createFrom(source: any = {}) {
	        return new ClaudeConfigConflict(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.scope = source["scope"];
	        this.location = source["location"];
	        this.detail = source["detail"];
	        this.severity = source["severity"];
	    }
	}
	export class HourlyRecord {
	    byModel?: Record<string, ModelUsageRecord>;
	    hour: string;
	    inputTokens: number;
	    outputTokens: number;
	    cachedTokens: number;
	    cacheWriteTokens: number;

	    static createFrom(source: any = {}) {
	        return new HourlyRecord(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.byModel = this.convertValues(source["byModel"], ModelUsageRecord, true);
	        this.hour = source["hour"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.cachedTokens = source["cachedTokens"];
	        this.cacheWriteTokens = source["cacheWriteTokens"];
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
	export class ModelUsageRecord {
	    modelKey: string;
	    displayName: string;
	    family: string;
	    requests: number;
	    inputTokens: number;
	    outputTokens: number;
	    cachedTokens: number;
	    cacheWriteTokens: number;
	    totalTokens: number;
	    estimatedCostUSD: number;
	    pricingVersion?: string;
	    pricingMode?: string;
	    pricingQuality?: string;
	    fastTokens: number;

	    static createFrom(source: any = {}) {
	        return new ModelUsageRecord(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.modelKey = source["modelKey"];
	        this.displayName = source["displayName"];
	        this.family = source["family"];
	        this.requests = source["requests"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.cachedTokens = source["cachedTokens"];
	        this.cacheWriteTokens = source["cacheWriteTokens"];
	        this.totalTokens = source["totalTokens"];
	        this.estimatedCostUSD = source["estimatedCostUSD"];
	        this.pricingVersion = source["pricingVersion"];
	        this.pricingMode = source["pricingMode"];
	        this.pricingQuality = source["pricingQuality"];
	        this.fastTokens = source["fastTokens"];
	    }
	}
	export class DailyRecord {
	    date: string;
	    inputTokens: number;
	    outputTokens: number;
	    cachedTokens: number;
	    cacheWriteTokens: number;
	    billableTokens: number;
	    requests: number;
	    errors: number;
	    retries: number;
	    generations: number;
	    savedMoneyUSD: number;
	    byModel?: Record<string, ModelUsageRecord>;

	    static createFrom(source: any = {}) {
	        return new DailyRecord(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.date = source["date"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.cachedTokens = source["cachedTokens"];
	        this.cacheWriteTokens = source["cacheWriteTokens"];
	        this.billableTokens = source["billableTokens"];
	        this.requests = source["requests"];
	        this.errors = source["errors"];
	        this.retries = source["retries"];
	        this.generations = source["generations"];
	        this.savedMoneyUSD = source["savedMoneyUSD"];
	        this.byModel = this.convertValues(source["byModel"], ModelUsageRecord, true);
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
	export class ServerUsageSummary {
	    today: DailyRecord;
	    dailyHistory: DailyRecord[];
	    hourlyHistory: HourlyRecord[];
	    chartMode: string;
	    cumulativeSaving: number;
	    source: string;

	    static createFrom(source: any = {}) {
	        return new ServerUsageSummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.today = this.convertValues(source["today"], DailyRecord);
	        this.dailyHistory = this.convertValues(source["dailyHistory"], DailyRecord);
	        this.hourlyHistory = this.convertValues(source["hourlyHistory"], HourlyRecord);
	        this.chartMode = source["chartMode"];
	        this.cumulativeSaving = source["cumulativeSaving"];
	        this.source = source["source"];
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
	export class SubscriptionUsdQuotaWindow {
	    used: number;
	    limit: number;
	    resetAt: string;

	    static createFrom(source: any = {}) {
	        return new SubscriptionUsdQuotaWindow(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.used = source["used"];
	        this.limit = source["limit"];
	        this.resetAt = source["resetAt"];
	    }
	}
	export class SubscriptionProductUsdQuota {
	    fiveHour?: SubscriptionUsdQuotaWindow;
	    weekly?: SubscriptionUsdQuotaWindow;

	    static createFrom(source: any = {}) {
	        return new SubscriptionProductUsdQuota(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fiveHour = this.convertValues(source["fiveHour"], SubscriptionUsdQuotaWindow);
	        this.weekly = this.convertValues(source["weekly"], SubscriptionUsdQuotaWindow);
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
	    id: string;
	    status: string;
	    expiresAt: string;
	    deviceLimit: number;
	    priority: number;
	    products: string[];
	    levels: Record<string, string>;
	    usdQuotaByProduct?: Record<string, SubscriptionProductUsdQuota>;
	    exclusive: boolean;
	    shareSeats: number;

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
	        this.usdQuotaByProduct = this.convertValues(source["usdQuotaByProduct"], SubscriptionProductUsdQuota, true);
	        this.exclusive = source["exclusive"];
	        this.shareSeats = source["shareSeats"];
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
	    userId: string;
	    planName: string;
	    planExpiry: string;
	    planDeviceMax: number;
	    deviceName: string;
	    subscriptions: SubscriptionSnapshot[];
	    serverUsage?: ServerUsageSummary;
	    codexMode: string;
	    codexRelayBase: string;
	    codexRelayKey: string;
	    codexRelayProtocol: string;
	    codexModelMap: Record<string, string>;
	    codexFastMode: boolean;

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
	        this.userId = source["userId"];
	        this.planName = source["planName"];
	        this.planExpiry = source["planExpiry"];
	        this.planDeviceMax = source["planDeviceMax"];
	        this.deviceName = source["deviceName"];
	        this.subscriptions = this.convertValues(source["subscriptions"], SubscriptionSnapshot);
	        this.serverUsage = this.convertValues(source["serverUsage"], ServerUsageSummary);
	        this.codexMode = source["codexMode"];
	        this.codexRelayBase = source["codexRelayBase"];
	        this.codexRelayKey = source["codexRelayKey"];
	        this.codexRelayProtocol = source["codexRelayProtocol"];
	        this.codexModelMap = source["codexModelMap"];
	        this.codexFastMode = source["codexFastMode"];
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
	export class HistoryVisibilitySummary {
	    targetProvider: string;
	    changedRolloutFiles: number;
	    updatedSqliteRows: number;
	    skippedSqlite: boolean;

	    static createFrom(source: any = {}) {
	        return new HistoryVisibilitySummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.targetProvider = source["targetProvider"];
	        this.changedRolloutFiles = source["changedRolloutFiles"];
	        this.updatedSqliteRows = source["updatedSqliteRows"];
	        this.skippedSqlite = source["skippedSqlite"];
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

	export class SanitizeReport {
	    cleaned: string[];
	    skipped: string[];
	    backupTo: string;
	    needsUac: boolean;

	    static createFrom(source: any = {}) {
	        return new SanitizeReport(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cleaned = source["cleaned"];
	        this.skipped = source["skipped"];
	        this.backupTo = source["backupTo"];
	        this.needsUac = source["needsUac"];
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
