import UIKit
import WebKit

/**
 * Full-screen web view showing the app's own screens (tvui.html, shared with Android),
 * loaded under the site's address (gemovie.tv) so they may read the site's pages.
 * The page talks to this code through window.TVApp (the same calls as on Android).
 */
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    // ---- Settings (same as the Android app) ------------------------------
    static let uiURL = URL(string: "https://gemovie.tv/tv-app")!   // the site moved from ge.movie
    static let allowedDomains = ["gemovie.tv", "ge.movie"]
    static let blockedHosts = [
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "adservice.google.com", "popads.net", "popcash.net", "propellerads.com",
        "adsterra.com", "exoclick.com", "juicyads.com", "onclickads.net",
        "onclkds.com", "adcash.com", "hilltopads.net", "a-ads.com",
        "mgid.com", "taboola.com", "outbrain.com",
    ]
    static let releases = "https://github.com/ATABESHA/gemovie-tv/releases/"
    // -----------------------------------------------------------------------

    private var webView: WKWebView!
    private var landscape = false
    private var lang = "ka"
    private var checkedUpdate = false

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { landscape ? .landscape : .all }
    override var prefersStatusBarHidden: Bool { landscape }
    override var prefersHomeIndicatorAutoHidden: Bool { landscape }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        makeWebView()
        loadUI()

        // Swipe in from the left edge = Back (iPhones have no Back button).
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        edge.edges = .left
        view.addGestureRecognizer(edge)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !checkedUpdate {
            checkedUpdate = true
            checkUpdate(manual: false)
        }
    }

    @objc private func edgeSwipe(_ g: UIScreenEdgePanGestureRecognizer) {
        if g.state == .recognized { js("window.__tv&&__tv.back()") }
    }

    // ------------------------------------------------------------ web view

    private func makeWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsPictureInPictureMediaPlayback = true
        cfg.preferences.isElementFullscreenEnabled = true
        cfg.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"

        let ucc = cfg.userContentController
        ucc.add(WeakHandler(self), name: "tvapp")
        // The bridge and the player script run in every frame (the player is an iframe).
        ucc.addUserScript(WKUserScript(source: bridgeScript() + "\n" + navScript(),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: false))

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never   // the page uses safe-area insets itself
        webView.scrollView.bounces = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        view.addSubview(webView)

        installAdBlocker(ucc)
    }

    /** Drops requests to ad servers (like BLOCKED_HOSTS on Android). */
    private func installAdBlocker(_ ucc: WKUserContentController) {
        let rules: [[String: Any]] = Self.blockedHosts.map { host in
            let h = NSRegularExpression.escapedPattern(for: host)
            return ["trigger": ["url-filter": "^https?://([^/]*\\.)?\(h)[:/]"], "action": ["type": "block"]]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let json = String(data: data, encoding: .utf8) else { return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ads", encodedContentRuleList: json) { list, _ in
            if let list { ucc.add(list) }
        }
    }

    private func bundleText(_ name: String, _ ext: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }

    private func dataURI(_ name: String, _ ext: String, _ mime: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let d = try? Data(contentsOf: url) else { return "" }
        return "data:\(mime);base64," + d.base64EncodedString()
    }

    private func navScript() -> String {
        bundleText("tvnav", "js")
            .replacingOccurrences(of: "__VIEWPORT_WIDTH__", with: "0")
            .replacingOccurrences(of: "__MODE__", with: "touch")
    }

    private var appVersion: String {
        let i = Bundle.main.infoDictionary
        let v = i?["CFBundleShortVersionString"] as? String ?? "1.0"
        let b = i?["CFBundleVersion"] as? String ?? "1"
        return "\(v).\(b)"
    }

    /** window.TVApp for the page: the same calls the Android app offers. */
    private func bridgeScript() -> String {
        let ver = appVersion
        let ios = "iOS " + UIDevice.current.systemVersion
        return """
        (function () {
          if (window.TVApp) return;
          var h = window.webkit && webkit.messageHandlers && webkit.messageHandlers.tvapp;
          if (!h) return;
          function send(m, a) { try { h.postMessage({ m: m, a: a || [] }); } catch (e) {} }
          window.TVApp = {
            setEditing: function () {}, setFsControls: function () {}, tap: function () {},
            setPlaying: function (v) { send('setPlaying', [!!v]); },
            setLandscape: function (v) { send('setLandscape', [!!v]); },
            webViewVersion: function () { return '\(ios)'; },
            appVersion: function () { return '\(ver)'; },
            localize: function (k, kind, id, lang, plot, facts) { send('localize', [k, kind, id, lang, plot, facts]); },
            findTrailer: function (q, k) { send('findTrailer', [q, k]); },
            setLang: function (l) { send('setLang', [l]); },
            checkUpdate: function () { send('checkUpdate'); },
            retry: function () { send('retry'); }
          };
        })();
        """
    }

    private func loadUI() {
        let html = bundleText("tvui", "html")
            .replacingOccurrences(of: "__LOGO__", with: dataURI("logo", "png", "image/png"))
            .replacingOccurrences(of: "__AV_PARENTS__", with: dataURI("av_parents", "jpg", "image/jpeg"))
            .replacingOccurrences(of: "__AV_SON__", with: dataURI("av_son", "jpg", "image/jpeg"))
            .replacingOccurrences(of: "__MODE__", with: "touch")
            .replacingOccurrences(of: "__VIEWPORT__",
                                  with: "width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no")
        webView.loadHTMLString(html, baseURL: Self.uiURL)
    }

    private func js(_ code: String) {
        webView.evaluateJavaScript(code, completionHandler: nil)
    }

    /** Calls a page function with arguments turned into JSON (safe for any text). */
    private func callPage(_ fn: String, _ args: [Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: args),
              let a = String(data: d, encoding: .utf8) else { return }
        js("window.__tvui&&__tvui.\(fn)&&__tvui.\(fn).apply(null,\(a))")
    }

    // ------------------------------------------------------------ bridge

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let m = body["m"] as? String else { return }
        let a = body["a"] as? [Any] ?? []
        func s(_ i: Int) -> String { i < a.count ? (a[i] as? String ?? "") : "" }
        func b(_ i: Int) -> Bool { i < a.count ? ((a[i] as? NSNumber)?.boolValue ?? false) : false }

        switch m {
        case "setPlaying":
            UIApplication.shared.isIdleTimerDisabled = b(0)   // screen stays on while a movie plays
        case "setLandscape":
            setLandscape(b(0))
        case "setLang":
            lang = s(0).isEmpty ? "ka" : s(0)
        case "localize":
            let key = s(0), kind = s(1), id = s(2), l = s(3), plot = s(4), facts = s(5)
            Task {
                let r = await Net.localize(kind: kind, tmdbId: id, lang: l, geoPlot: plot, geoFacts: facts)
                self.callPage("onLocal", [key, r])
            }
        case "findTrailer":
            let query = s(0), key = s(1)
            Task {
                if let vid = await Net.youtubeSearch(query) { self.callPage("onTrailer", [key, vid]) }
            }
        case "checkUpdate":
            checkUpdate(manual: true)
        case "retry":
            loadUI()
        default:
            break
        }
    }

    /** A movie or trailer turns the screen sideways; closing it lets it turn back. */
    private func setLandscape(_ on: Bool) {
        guard on != landscape else { return }
        landscape = on
        setNeedsUpdateOfSupportedInterfaceOrientations()
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        // iPhone: back to upright after the movie. iPad: stays as it is held.
        if on || UIDevice.current.userInterfaceIdiom == .phone {
            view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: on ? .landscape : .portrait)) { _ in }
        }
    }

    // ------------------------------------------------------------ navigation

    private static func matches(_ host: String, _ list: [String]) -> Bool {
        list.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel); return
        }
        if ["about", "data", "blob"].contains(scheme) { decisionHandler(.allow); return }
        guard scheme == "http" || scheme == "https" else { decisionHandler(.cancel); return }   // intent://, market:// …
        let host = url.host?.lowercased() ?? ""
        if Self.matches(host, Self.blockedHosts) { decisionHandler(.cancel); return }
        // Pop-up windows (target=_blank, window.open) are ads: never opened.
        guard let frame = action.targetFrame else { decisionHandler(.cancel); return }
        if !frame.isMainFrame { decisionHandler(.allow); return }      // the video player and its parts
        decisionHandler(Self.matches(host, Self.allowedDomains) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    /** The page's engine stopped (crash or low memory): start a fresh page. */
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        UIApplication.shared.isIdleTimerDisabled = false
        setLandscape(false)
        loadUI()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }
        let msg = e.localizedDescription
            .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="background:#111;color:#eee;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;
        align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:0 20px">
        <h2>Can't load the page</h2><p>\(msg)</p>
        <button style="font-size:20px;padding:12px 32px;margin-top:16px" onclick="TVApp.retry()">Try again</button>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // ------------------------------------------------------------ updates

    private func t(_ ka: String, _ ru: String, _ en: String) -> String {
        lang == "ru" ? ru : lang == "en" ? en : ka
    }

    /**
     * iPhones can't install updates by themselves (the app is installed from a computer).
     * This only says when a newer build is on GitHub and opens its download page.
     */
    private func checkUpdate(manual: Bool) {
        let have = Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0
        Task {
            var best = -1, bestTag = "latest"
            for tag in ["latest", "test"] {
                if let txt = await Net.get(Self.releases + "download/\(tag)/version.txt", browserUA: false),
                   let v = Int(txt.trimmingCharacters(in: .whitespacesAndNewlines)), v > best {
                    best = v; bestTag = tag
                }
            }
            if best > have {
                let alert = UIAlertController(
                    title: t("ახალი ვერსია", "Новая версия", "Update available"),
                    message: t("MyMovie-ს ახალი ვერსია მზადაა. გადმოწერეთ gemovie-ios.ipa და დააყენეთ კომპიუტერიდან (Sideloadly).",
                               "Новая версия MyMovie готова. Скачайте gemovie-ios.ipa и установите с компьютера (Sideloadly).",
                               "A new version of MyMovie is ready. Download gemovie-ios.ipa and install it from your computer (Sideloadly).")
                        + " (build \(best))",
                    preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: t("გახსნა", "Открыть", "Open"), style: .default) { _ in
                    if let u = URL(string: Self.releases + "tag/\(bestTag)") { UIApplication.shared.open(u) }
                })
                alert.addAction(UIAlertAction(title: t("მოგვიანებით", "Позже", "Later"), style: .cancel))
                self.present(alert, animated: true)
            } else if manual {
                let text = best < 0
                    ? t("GitHub-თან დაკავშირება ვერ მოხერხდა", "Не удалось связаться с GitHub", "Couldn't reach GitHub")
                    : t("უკვე უახლესი ვერსიაა", "Уже последняя версия", "You have the latest version") + " (build \(have))"
                let alert = UIAlertController(title: nil, message: text, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(alert, animated: true)
            }
        }
    }
}

/** Keeps the page's message handler from holding the screen in memory forever. */
@MainActor
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}
