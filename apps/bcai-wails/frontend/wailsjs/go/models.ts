export namespace main {
	
	export class AccountInfo {
	    id: number;
	    email: string;
	    alias: string;
	    enabled: boolean;
	    projectId: string;
	    planType: string;
	    oauthProfile: string;
	    hasAccessToken: boolean;
	    tokenExpiresIn: number;
	    quotaStatus: string;
	    quotaReason: string;
	    exhaustedUntil?: string;
	    consecutiveErrors: number;
	    lastUsedAt?: string;
	    blockedModels?: Record<string, string>;
	
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
	        this.oauthProfile = source["oauthProfile"];
	        this.hasAccessToken = source["hasAccessToken"];
	        this.tokenExpiresIn = source["tokenExpiresIn"];
	        this.quotaStatus = source["quotaStatus"];
	        this.quotaReason = source["quotaReason"];
	        this.exhaustedUntil = source["exhaustedUntil"];
	        this.consecutiveErrors = source["consecutiveErrors"];
	        this.lastUsedAt = source["lastUsedAt"];
	        this.blockedModels = source["blockedModels"];
	    }
	}
	export class Config {
	    accountCard: string;
	    deviceId: string;
	    proxyPort: number;
	    upstreamProxy: string;
	    idePath: string;
	    hubPath: string;
	    cardExpiry: string;
	    poolMode: string;
	
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
	        this.cardExpiry = source["cardExpiry"];
	        this.poolMode = source["poolMode"];
	    }
	}
	export class DetectedPaths {
	    idePath: string;
	    hubPath: string;
	
	    static createFrom(source: any = {}) {
	        return new DetectedPaths(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.idePath = source["idePath"];
	        this.hubPath = source["hubPath"];
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
	
	    static createFrom(source: any = {}) {
	        return new IDEStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.products = this.convertValues(source["products"], IDEProduct);
	        this.proxyUrl = source["proxyUrl"];
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

