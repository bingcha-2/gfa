export namespace main {
	
	export class CreditsInfo {
	    known: boolean;
	    available: boolean;
	    creditAmount: number;
	    minCreditAmount: number;
	    paidTierID: string;
	
	    static createFrom(source: any = {}) {
	        return new CreditsInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.known = source["known"];
	        this.available = source["available"];
	        this.creditAmount = source["creditAmount"];
	        this.minCreditAmount = source["minCreditAmount"];
	        this.paidTierID = source["paidTierID"];
	    }
	}
	export class QuotaEntry {
	    key: string;
	    label: string;
	    percent: number;
	    isBlocked: boolean;
	    resetTime: string;
	    provider: string;
	
	    static createFrom(source: any = {}) {
	        return new QuotaEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.label = source["label"];
	        this.percent = source["percent"];
	        this.isBlocked = source["isBlocked"];
	        this.resetTime = source["resetTime"];
	        this.provider = source["provider"];
	    }
	}
	export class QuotaGroup {
	    provider: string;
	    percent: number;
	    resetTime: string;
	    modelCount: number;
	    blockedCount: number;
	    entries: QuotaEntry[];
	
	    static createFrom(source: any = {}) {
	        return new QuotaGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.provider = source["provider"];
	        this.percent = source["percent"];
	        this.resetTime = source["resetTime"];
	        this.modelCount = source["modelCount"];
	        this.blockedCount = source["blockedCount"];
	        this.entries = this.convertValues(source["entries"], QuotaEntry);
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
	export class RequestStatsInfo {
	    total: number;
	    successes: number;
	    failures: number;
	
	    static createFrom(source: any = {}) {
	        return new RequestStatsInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.successes = source["successes"];
	        this.failures = source["failures"];
	    }
	}
	export class AccountInfo {
	    id: number;
	    email: string;
	    alias: string;
	    enabled: boolean;
	    projectId: string;
	    planType: string;
	    hasAccessToken: boolean;
	    tokenExpiresIn: number;
	    quotaStatus: string;
	    quotaReason: string;
	    exhaustedUntil?: string;
	    consecutiveErrors: number;
	    lastUsedAt?: string;
	    blockedModels?: Record<string, string>;
	    isActive: boolean;
	    successRate?: number;
	    qualityTier: string;
	    requestStats: RequestStatsInfo;
	    quotaGroups: QuotaGroup[];
	    quotaRefreshedAt?: string;
	    accountStatusLabel: string;
	    accountStatusTone: string;
	    isLocked: boolean;
	    credits?: CreditsInfo;
	
	    static createFrom(source: any = {}) {
	        return new AccountInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.email = source["email"];
	        this.alias = source["alias"];
	        this.enabled = source["enabled"];
	        this.projectId = source["projectId"];
	        this.planType = source["planType"];
	        this.hasAccessToken = source["hasAccessToken"];
	        this.tokenExpiresIn = source["tokenExpiresIn"];
	        this.quotaStatus = source["quotaStatus"];
	        this.quotaReason = source["quotaReason"];
	        this.exhaustedUntil = source["exhaustedUntil"];
	        this.consecutiveErrors = source["consecutiveErrors"];
	        this.lastUsedAt = source["lastUsedAt"];
	        this.blockedModels = source["blockedModels"];
	        this.isActive = source["isActive"];
	        this.successRate = source["successRate"];
	        this.qualityTier = source["qualityTier"];
	        this.requestStats = this.convertValues(source["requestStats"], RequestStatsInfo);
	        this.quotaGroups = this.convertValues(source["quotaGroups"], QuotaGroup);
	        this.quotaRefreshedAt = source["quotaRefreshedAt"];
	        this.accountStatusLabel = source["accountStatusLabel"];
	        this.accountStatusTone = source["accountStatusTone"];
	        this.isLocked = source["isLocked"];
	        this.credits = this.convertValues(source["credits"], CreditsInfo);
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
	    deviceId: string;
	    proxyPort: number;
	    upstreamProxy: string;
	    idePath: string;
	    hubPath: string;
	    codexAppPath: string;
	    cardExpiry: string;
	    poolMode: string;
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
	        this.deviceId = source["deviceId"];
	        this.proxyPort = source["proxyPort"];
	        this.upstreamProxy = source["upstreamProxy"];
	        this.idePath = source["idePath"];
	        this.hubPath = source["hubPath"];
	        this.codexAppPath = source["codexAppPath"];
	        this.cardExpiry = source["cardExpiry"];
	        this.poolMode = source["poolMode"];
	        this.codexMode = source["codexMode"];
	        this.codexRelayBase = source["codexRelayBase"];
	        this.codexRelayKey = source["codexRelayKey"];
	        this.codexRelayProtocol = source["codexRelayProtocol"];
	        this.codexModelMap = source["codexModelMap"];
	    }
	}
	
	export class DetectedPaths {
	    idePath: string;
	    hubPath: string;
	    codexAppPath: string;
	
	    static createFrom(source: any = {}) {
	        return new DetectedPaths(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.idePath = source["idePath"];
	        this.hubPath = source["hubPath"];
	        this.codexAppPath = source["codexAppPath"];
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

