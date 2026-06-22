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

