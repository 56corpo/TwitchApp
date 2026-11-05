use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const TWITCH_PUBLIC_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmoteItem {
    pub name: String,
    pub provider: String,
    pub scope: String,
    pub zero_width: bool,
    pub url1x: String,
    pub url2x: String,
    pub url4x: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmoteCounts {
    pub total: usize,
    #[serde(rename = "7TV")]
    pub seven_tv: usize,
    #[serde(rename = "BTTV")]
    pub bttv: usize,
    #[serde(rename = "FFZ")]
    pub ffz: usize,
    #[serde(rename = "Global")]
    pub global: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEmotesPayload {
    pub channel: String,
    pub twitch_id: Option<String>,
    pub counts: EmoteCounts,
    pub emotes: Vec<EmoteItem>,
}

struct CachedGlobals {
    fetched_at: Instant,
    emotes: Vec<EmoteItem>,
}

struct CachedChannel {
    fetched_at: Instant,
    payload: ChannelEmotesPayload,
}

static GLOBAL_CACHE: OnceLock<Mutex<Option<CachedGlobals>>> = OnceLock::new();
static CHANNEL_CACHE: OnceLock<Mutex<HashMap<String, CachedChannel>>> = OnceLock::new();

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(8))
        .user_agent("TwitchApp-Rust/2.0.0")
        .build()
}

fn fetch_json(url: &str) -> Option<Value> {
    let agent = http_agent();
    let res = agent
        .get(url)
        .set("Accept", "application/json")
        .call()
        .ok()?;
    res.into_json::<Value>().ok()
}

fn resolve_twitch_user_id(channel_login: &str) -> Option<String> {
    if channel_login.is_empty() {
        return None;
    }

    let agent = http_agent();
    let body = json!({
        "query": "query($login: String!) { user(login: $login) { id } }",
        "variables": { "login": channel_login.to_lowercase() }
    });

    let res = agent
        .post("https://gql.twitch.tv/gql")
        .set("Client-ID", TWITCH_PUBLIC_CLIENT_ID)
        .set("Content-Type", "application/json")
        .send_json(body)
        .ok()?;

    let val: Value = res.into_json().ok()?;
    val.pointer("/data/user/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn normalize_url(raw: &str) -> String {
    if raw.starts_with("//") {
        format!("https:{}", raw)
    } else {
        raw.to_string()
    }
}

fn parse_7tv_emote(item: &Value, scope: &str) -> Option<EmoteItem> {
    let name = item.get("name")?.as_str()?.to_string();
    let id = item.get("id")?.as_str()?;

    let flags = item.get("flags").and_then(|v| v.as_u64()).unwrap_or(0);
    let data_flags = item
        .pointer("/data/flags")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let zero_width = (flags & 1) == 1 || (data_flags & 256) == 256;

    let base_host = item
        .pointer("/data/host/url")
        .and_then(|v| v.as_str())
        .map(normalize_url)
        .unwrap_or_else(|| format!("https://cdn.7tv.app/emote/{}", id));

    Some(EmoteItem {
        name,
        provider: "7TV".to_string(),
        scope: scope.to_string(),
        zero_width,
        url1x: format!("{}/1x.webp", base_host),
        url2x: format!("{}/2x.webp", base_host),
        url4x: format!("{}/4x.webp", base_host),
    })
}

fn parse_bttv_emote(item: &Value, scope: &str) -> Option<EmoteItem> {
    let name = item.get("code")?.as_str()?.to_string();
    let id = item.get("id")?.as_str()?;

    Some(EmoteItem {
        name,
        provider: "BTTV".to_string(),
        scope: scope.to_string(),
        zero_width: false,
        url1x: format!("https://cdn.betterttv.net/emote/{}/1x.webp", id),
        url2x: format!("https://cdn.betterttv.net/emote/{}/2x.webp", id),
        url4x: format!("https://cdn.betterttv.net/emote/{}/3x.webp", id),
    })
}

fn parse_ffz_emote(item: &Value, scope: &str) -> Option<EmoteItem> {
    let name = item.get("name")?.as_str()?.to_string();
    let id = item.get("id")?.as_u64()?;

    let urls_obj = item
        .get("animated")
        .or_else(|| item.get("urls"))
        .and_then(|v| v.as_object());

    let get_scale = |key: &str| -> Option<String> {
        urls_obj
            .and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .map(normalize_url)
    };

    let url1x = get_scale("1").unwrap_or_else(|| format!("https://cdn.frankerfacez.com/emote/{}/1", id));
    let url2x = get_scale("2").unwrap_or_else(|| url1x.clone());
    let url4x = get_scale("4").unwrap_or_else(|| url2x.clone());

    Some(EmoteItem {
        name,
        provider: "FFZ".to_string(),
        scope: scope.to_string(),
        zero_width: false,
        url1x,
        url2x,
        url4x,
    })
}

pub fn fetch_global_emotes() -> Vec<EmoteItem> {
    let cache_mutex = GLOBAL_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache_mutex.lock() {
        if let Some(ref cached) = *guard {
            if cached.fetched_at.elapsed() < CACHE_TTL * 3 {
                return cached.emotes.clone();
            }
        }
    }

    let mut list = Vec::new();

    // 1. FFZ Global
    if let Some(ffz) = fetch_json("https://api.frankerfacez.com/v1/set/global") {
        if let (Some(default_sets), Some(sets)) = (
            ffz.get("default_sets").and_then(|v| v.as_array()),
            ffz.get("sets").and_then(|v| v.as_object()),
        ) {
            for set_id_val in default_sets {
                if let Some(set_id) = set_id_val.as_u64() {
                    if let Some(emoticons) = sets
                        .get(&set_id.to_string())
                        .and_then(|s| s.get("emoticons"))
                        .and_then(|e| e.as_array())
                    {
                        for em in emoticons {
                            if let Some(parsed) = parse_ffz_emote(em, "Global") {
                                list.push(parsed);
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. BTTV Global
    if let Some(bttv) = fetch_json("https://api.betterttv.net/3/cached/emotes/global") {
        if let Some(arr) = bttv.as_array() {
            for em in arr {
                if let Some(parsed) = parse_bttv_emote(em, "Global") {
                    list.push(parsed);
                }
            }
        }
    }

    // 3. 7TV Global
    if let Some(seventv) = fetch_json("https://7tv.io/v3/emote-sets/global") {
        if let Some(arr) = seventv.get("emotes").and_then(|v| v.as_array()) {
            for em in arr {
                if let Some(parsed) = parse_7tv_emote(em, "Global") {
                    list.push(parsed);
                }
            }
        }
    }

    if let Ok(mut guard) = cache_mutex.lock() {
        *guard = Some(CachedGlobals {
            fetched_at: Instant::now(),
            emotes: list.clone(),
        });
    }

    list
}

pub fn get_emotes_for_channel(channel_login: &str) -> ChannelEmotesPayload {
    let clean_channel = channel_login.trim().to_lowercase();
    let globals = fetch_global_emotes();

    if clean_channel.is_empty() {
        let total = globals.len();
        return ChannelEmotesPayload {
            channel: String::new(),
            twitch_id: None,
            counts: EmoteCounts {
                total,
                seven_tv: 0,
                bttv: 0,
                ffz: 0,
                global: total,
            },
            emotes: globals,
        };
    }

    let chan_cache_mutex = CHANNEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = chan_cache_mutex.lock() {
        if let Some(cached) = guard.get(&clean_channel) {
            if cached.fetched_at.elapsed() < CACHE_TTL {
                return cached.payload.clone();
            }
        }
    }

    let ffz_room_url = format!("https://api.frankerfacez.com/v1/room/{}", clean_channel);
    let ffz_room = fetch_json(&ffz_room_url);

    let twitch_id = resolve_twitch_user_id(&clean_channel).or_else(|| {
        ffz_room
            .as_ref()
            .and_then(|v| v.pointer("/room/twitch_id"))
            .and_then(|id| id.as_u64().map(|n| n.to_string()))
    });

    let mut counts = EmoteCounts {
        total: 0,
        seven_tv: 0,
        bttv: 0,
        ffz: 0,
        global: globals.len(),
    };

    let mut channel_emotes = Vec::new();

    // 1. FFZ Channel Emotes
    if let Some(sets) = ffz_room
        .as_ref()
        .and_then(|v| v.get("sets"))
        .and_then(|s| s.as_object())
    {
        for set_obj in sets.values() {
            if let Some(emoticons) = set_obj.get("emoticons").and_then(|e| e.as_array()) {
                for em in emoticons {
                    if let Some(parsed) = parse_ffz_emote(em, "Channel") {
                        channel_emotes.push(parsed);
                        counts.ffz += 1;
                    }
                }
            }
        }
    }

    if let Some(ref tid) = twitch_id {
        // 2. BTTV Channel + Shared Emotes
        let bttv_url = format!("https://api.betterttv.net/3/cached/users/twitch/{}", tid);
        if let Some(bttv_user) = fetch_json(&bttv_url) {
            for key in ["channelEmotes", "sharedEmotes"] {
                if let Some(arr) = bttv_user.get(key).and_then(|v| v.as_array()) {
                    for em in arr {
                        if let Some(parsed) = parse_bttv_emote(em, "Channel") {
                            channel_emotes.push(parsed);
                            counts.bttv += 1;
                        }
                    }
                }
            }
        }

        // 3. 7TV Channel Emotes
        let seventv_url = format!("https://7tv.io/v3/users/twitch/{}", tid);
        if let Some(seventv_user) = fetch_json(&seventv_url) {
            if let Some(arr) = seventv_user
                .pointer("/emote_set/emotes")
                .and_then(|v| v.as_array())
            {
                for em in arr {
                    if let Some(parsed) = parse_7tv_emote(em, "Channel") {
                        channel_emotes.push(parsed);
                        counts.seven_tv += 1;
                    }
                }
            }
        }
    }

    // Fusionner : les emotes de chaîne prennent la priorité sur les globales, 7TV > BTTV > FFZ
    let mut merged_map: HashMap<String, EmoteItem> = HashMap::new();
    for em in globals {
        merged_map.insert(em.name.clone(), em);
    }
    for em in channel_emotes {
        merged_map.insert(em.name.clone(), em);
    }

    let mut final_emotes: Vec<EmoteItem> = merged_map.into_values().collect();
    final_emotes.sort_by(|a, b| a.name.cmp(&b.name));
    counts.total = final_emotes.len();

    let payload = ChannelEmotesPayload {
        channel: clean_channel.clone(),
        twitch_id,
        counts,
        emotes: final_emotes,
    };

    if let Ok(mut guard) = chan_cache_mutex.lock() {
        guard.insert(
            clean_channel,
            CachedChannel {
                fetched_at: Instant::now(),
                payload: payload.clone(),
            },
        );
    }

    payload
}

