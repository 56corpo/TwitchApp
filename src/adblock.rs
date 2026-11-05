use url::Url;

/// Script d'initialisation injecté dans le WebView dès `document-start`
pub const INITIALIZATION_SCRIPT: &str = include_str!("injected.js");

/// User-Agent Chrome standard sans marqueur Electron/WebView pour éviter les blocages Kasada Twitch
pub const CLEAN_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Vérifie si une URL fait partie de l'écosystème Twitch (navigation et OAuth internes autorisés)
pub fn is_allowed_twitch_domain(raw_url: &str) -> bool {
    if raw_url.starts_with("about:") || raw_url.starts_with("blob:") || raw_url.starts_with("data:") {
        return true;
    }

    let parsed = match Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return false,
    };

    let host = match parsed.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return false,
    };

    host == "twitch.tv"
        || host.ends_with(".twitch.tv")
        || host.ends_with(".ttvnw.net")
        || host.ends_with(".jtvnw.net")
        || host.ends_with(".7tv.app")
        || host.ends_with(".7tv.io")
        || host.ends_with(".betterttv.net")
        || host.ends_with(".frankerfacez.com")
}

