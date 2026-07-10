package main

// ianaWindowsTimezoneIDs 覆盖固定列表与主要代理出口区域。多个 IANA 城市映射到同一
// Windows 时区时，Claude 进程仍会额外收到精确 TZ 环境变量，补足系统 ID 的城市级塌缩。
var ianaWindowsTimezoneIDs = map[string]string{
	"Etc/UTC": "UTC", "UTC": "UTC",
	"America/Adak": "Aleutian Standard Time", "Pacific/Honolulu": "Hawaiian Standard Time",
	"America/Anchorage": "Alaskan Standard Time", "America/Los_Angeles": "Pacific Standard Time",
	"America/Vancouver": "Pacific Standard Time", "America/Tijuana": "Pacific Standard Time (Mexico)",
	"America/Phoenix": "US Mountain Standard Time", "America/Denver": "Mountain Standard Time",
	"America/Edmonton": "Mountain Standard Time", "America/Mexico_City": "Central Standard Time (Mexico)",
	"America/Chicago": "Central Standard Time", "America/Winnipeg": "Central Standard Time",
	"America/Bogota": "SA Pacific Standard Time", "America/Lima": "SA Pacific Standard Time",
	"America/New_York": "Eastern Standard Time", "America/Detroit": "Eastern Standard Time",
	"America/Toronto": "Eastern Standard Time", "America/Nassau": "Eastern Standard Time",
	"America/Havana": "Cuba Standard Time", "America/Caracas": "Venezuela Standard Time",
	"America/Halifax": "Atlantic Standard Time", "America/St_Johns": "Newfoundland Standard Time",
	"America/Sao_Paulo": "E. South America Standard Time", "America/Argentina/Buenos_Aires": "Argentina Standard Time",
	"America/Santiago": "Pacific SA Standard Time", "America/Montevideo": "Montevideo Standard Time",
	"Atlantic/Azores": "Azores Standard Time", "Atlantic/Cape_Verde": "Cape Verde Standard Time",
	"Europe/London": "GMT Standard Time", "Europe/Dublin": "GMT Standard Time", "Europe/Lisbon": "GMT Standard Time",
	"Africa/Casablanca": "Morocco Standard Time", "Africa/Lagos": "W. Central Africa Standard Time",
	"Europe/Paris": "Romance Standard Time", "Europe/Madrid": "Romance Standard Time",
	"Europe/Berlin": "W. Europe Standard Time", "Europe/Rome": "W. Europe Standard Time",
	"Europe/Amsterdam": "W. Europe Standard Time", "Europe/Brussels": "Romance Standard Time",
	"Europe/Stockholm": "W. Europe Standard Time", "Europe/Warsaw": "Central European Standard Time",
	"Europe/Prague": "Central Europe Standard Time", "Europe/Budapest": "Central Europe Standard Time",
	"Europe/Athens": "GTB Standard Time", "Europe/Bucharest": "GTB Standard Time",
	"Europe/Helsinki": "FLE Standard Time", "Europe/Kyiv": "FLE Standard Time",
	"Europe/Istanbul": "Turkey Standard Time", "Europe/Moscow": "Russian Standard Time",
	"Africa/Cairo": "Egypt Standard Time", "Africa/Johannesburg": "South Africa Standard Time",
	"Africa/Nairobi": "E. Africa Standard Time", "Asia/Jerusalem": "Israel Standard Time",
	"Asia/Beirut": "Middle East Standard Time", "Asia/Amman": "Jordan Standard Time",
	"Asia/Riyadh": "Arab Standard Time", "Asia/Baghdad": "Arabic Standard Time",
	"Asia/Tehran": "Iran Standard Time", "Asia/Dubai": "Arabian Standard Time",
	"Asia/Kabul": "Afghanistan Standard Time", "Asia/Karachi": "Pakistan Standard Time",
	"Asia/Kolkata": "India Standard Time", "Asia/Colombo": "Sri Lanka Standard Time",
	"Asia/Kathmandu": "Nepal Standard Time", "Asia/Dhaka": "Bangladesh Standard Time",
	"Asia/Yangon": "Myanmar Standard Time", "Asia/Bangkok": "SE Asia Standard Time",
	"Asia/Jakarta": "SE Asia Standard Time", "Asia/Ho_Chi_Minh": "SE Asia Standard Time",
	"Asia/Shanghai": "China Standard Time", "Asia/Hong_Kong": "China Standard Time", "Asia/Macau": "China Standard Time",
	"Asia/Singapore": "Singapore Standard Time", "Asia/Kuala_Lumpur": "Singapore Standard Time",
	"Asia/Kuching": "Singapore Standard Time", "Asia/Manila": "Singapore Standard Time",
	"Asia/Brunei": "Singapore Standard Time", "Asia/Makassar": "Singapore Standard Time",
	"Asia/Taipei": "Taipei Standard Time", "Asia/Ulaanbaatar": "Ulaanbaatar Standard Time",
	"Asia/Irkutsk": "North Asia East Standard Time", "Asia/Tokyo": "Tokyo Standard Time",
	"Asia/Seoul": "Korea Standard Time", "Australia/Perth": "W. Australia Standard Time",
	"Australia/Darwin": "AUS Central Standard Time", "Australia/Adelaide": "Cen. Australia Standard Time",
	"Australia/Brisbane": "E. Australia Standard Time", "Australia/Sydney": "AUS Eastern Standard Time",
	"Australia/Melbourne": "AUS Eastern Standard Time", "Pacific/Guam": "West Pacific Standard Time",
	"Pacific/Fiji": "Fiji Standard Time", "Pacific/Auckland": "New Zealand Standard Time",
}

var canonicalIANAByWindowsID = map[string]string{
	"UTC": "Etc/UTC", "Pacific Standard Time": "America/Los_Angeles",
	"Mountain Standard Time": "America/Denver", "Central Standard Time": "America/Chicago",
	"Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London",
	"W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
	"Russian Standard Time": "Europe/Moscow", "India Standard Time": "Asia/Kolkata",
	"China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore",
	"Taipei Standard Time": "Asia/Taipei", "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
	"North Asia East Standard Time": "Asia/Irkutsk", "Tokyo Standard Time": "Asia/Tokyo",
	"Korea Standard Time": "Asia/Seoul", "W. Australia Standard Time": "Australia/Perth",
	"AUS Eastern Standard Time": "Australia/Sydney", "New Zealand Standard Time": "Pacific/Auckland",
}

func ianaToWindowsTimezoneID(iana string) (string, bool) {
	id, ok := ianaWindowsTimezoneIDs[iana]
	return id, ok
}

func windowsIDToCanonicalIANA(id string) string { return canonicalIANAByWindowsID[id] }
