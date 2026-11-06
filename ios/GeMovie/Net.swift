import Foundation

/**
 * Lookups the page can't do itself (other sites don't allow it): titles and descriptions
 * in Russian/English from TMDB, machine translation of the Georgian text, and the
 * YouTube trailer search. Same logic as MainActivity.java on Android.
 */
enum Net {
    static let browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

    /** At most two downloads per site at once, so fast scrolling can't flood the connection. */
    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 10
        c.httpMaximumConnectionsPerHost = 2
        c.httpShouldSetCookies = false
        return URLSession(configuration: c)
    }()

    static func get(_ url: String, browserUA: Bool = true, cookie: String? = nil) async -> String? {
        guard let u = URL(string: url) else { return nil }
        var r = URLRequest(url: u)
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.setValue(browserUA ? Net.browserUA : "GeMovie-iOS", forHTTPHeaderField: "User-Agent")
        r.setValue("en-US,en;q=0.9,ru;q=0.8", forHTTPHeaderField: "Accept-Language")
        if let cookie { r.setValue(cookie, forHTTPHeaderField: "Cookie") }
        guard let res = try? await session.data(for: r),
              (res.1 as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return String(decoding: res.0, as: UTF8.self)
    }

    static func firstMatch(_ pattern: String, in text: String, dotAll: Bool = false) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: dotAll ? [.dotMatchesLineSeparators] : []),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    static func unescapeHtml(_ s: String) -> String {
        s.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'").replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    static func meta(_ html: String, _ prop: String) -> String {
        let p = NSRegularExpression.escapedPattern(for: prop)
        let v = firstMatch("<meta[^>]+(?:property|name)=\"\(p)\"[^>]+content=\"([^\"]*)\"", in: html) ?? ""
        return unescapeHtml(v).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /** TMDB's page in the wanted language: (title, overview), "" when it has none. */
    static func tmdbTexts(kind: String, id: String, lang: String) async -> (String, String)? {
        let loc = lang == "ru" ? "ru-RU" : "en-US"
        guard let html = await get("https://www.themoviedb.org/\(kind)/\(id)?language=\(loc)") else { return nil }
        var title = meta(html, "og:title")
        if let r = title.range(of: "\\s*\\(\\d{4}\\)\\s*$", options: .regularExpression) { title.removeSubrange(r) }
        var plot = ""
        if let p = firstMatch("<div class=\"overview\"[^>]*>\\s*<p>(.*?)</p>", in: html, dotAll: true) {
            plot = unescapeHtml(p.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if plot.isEmpty { plot = meta(html, "og:description") }
        // TMDB's "no translation yet" notice is not a description
        if plot.contains("We don't have an overview") || plot.contains("нет описания") || plot.contains("нет перевода") {
            plot = ""
        }
        return (title, plot)
    }

    /** Machine translation from Georgian. "" if it fails. */
    static func translate(_ text: String, lang: String) async -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        guard let q = text.addingPercentEncoding(withAllowedCharacters: allowed) else { return "" }
        let url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ka&tl=\(lang == "ru" ? "ru" : "en")&dt=t&q=\(q)"
        guard let body = await get(url), let data = body.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [Any],
              let parts = root.first as? [Any] else { return "" }
        var out = ""
        for p in parts { if let a = p as? [Any], let s = a.first as? String { out += s } }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /** What the page's onLocal(key, {title, plot, facts}) expects. */
    static func localize(kind: String, tmdbId: String, lang: String, geoPlot: String, geoFacts: String) async -> [String: Any] {
        var title = "", plot = ""
        if !tmdbId.isEmpty, let tp = await tmdbTexts(kind: kind == "tv" ? "tv" : "movie", id: tmdbId, lang: lang) {
            title = tp.0; plot = tp.1
        }
        if plot.isEmpty && !geoPlot.isEmpty { plot = await translate(geoPlot, lang: lang) }
        var facts = ""
        if !geoFacts.isEmpty { facts = await translate(geoFacts, lang: lang) }
        let list = facts.isEmpty ? [] : facts.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        return ["title": title, "plot": plot, "facts": list]
    }

    /** YouTube search page, first video result. */
    static func youtubeSearch(_ query: String) async -> String? {
        guard let q = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let html = await get("https://www.youtube.com/results?search_query=\(q)", cookie: "SOCS=CAI; CONSENT=YES+1")
        else { return nil }
        return firstMatch("\"videoRenderer\":\\{\"videoId\":\"([\\w-]{11})\"", in: html)
            ?? firstMatch("\"videoId\":\"([\\w-]{11})\"", in: html)
    }
}
